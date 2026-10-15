import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { apply as applyOpenViking } from "./index.mjs";
import { OpenVikingClient } from "./client.mjs";
import { deriveDshSessionId } from "./session-id.mjs";

const manifestPath = process.env.MAN350_SYNTHETIC_MANIFEST || "";
const syntheticRootPath = process.env.MAN350_SYNTHETIC_ROOT || "";
// This is intentionally opt-in: the ordinary package suite must never contact
// a configured or active OpenViking service.
test("MAN-350 DSH composition keeps capture, approved reads, history, and MCP tools separate", {
  skip: !manifestPath && "set MAN350_SYNTHETIC_MANIFEST and MAN350_SYNTHETIC_ROOT for a disposable fixture",
}, async () => {
  const manifest = realpathSync(manifestPath);
  assert.equal(basename(manifest), "identities.json");
  assert.ok(syntheticRootPath, "set MAN350_SYNTHETIC_ROOT to the disposable test folder");
  assert.equal(dirname(dirname(manifest)), realpathSync(syntheticRootPath));
  assert.match(basename(dirname(manifest)), /^run-[a-f0-9]{12}$/);

  const { url, keys } = JSON.parse(readFileSync(manifest, "utf8"));
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.ok(endpoint.port);
  assert.notEqual(endpoint.port, "1933");
  for (const identity of [
    "man350_project_a:candidate",
    "man350_project_a:approved",
    "man350_project_a:history",
    "man350_project_b:approved",
  ]) assert.equal(typeof keys[identity], "string", `missing synthetic identity ${identity}`);

  const suffix = `${Date.now()}-${process.pid}`;
  const markers = {
    profile: `MAN350_APPROVED_PROFILE_${suffix}`,
    approved: `MAN350_APPROVED_RECALL_${suffix}`,
    candidate: `MAN350_CANDIDATE_PRIVATE_${suffix}`,
    history: `MAN350_HISTORY_PRIVATE_${suffix}`,
    other: `MAN350_OTHER_PROJECT_PRIVATE_${suffix}`,
  };
  const files = {
    approved: `approved-${suffix}.md`,
    candidate: `candidate-${suffix}.md`,
    history: `history-${suffix}.md`,
    other: `other-${suffix}.md`,
  };

  await seed("man350_project_a:approved", "profile.md", markers.profile);
  await seed("man350_project_a:approved", `entities/${files.approved}`, markers.approved);
  await seed("man350_project_a:candidate", `entities/${files.candidate}`, markers.candidate);
  await seed("man350_project_a:history", `entities/${files.history}`, markers.history);
  await seed("man350_project_b:approved", `entities/${files.other}`, markers.other);

  const ctx = new Context();
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber;
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: "native" });
  await toolsFiber;

  const routes = {
    candidate: route("man350_project_a:candidate", "candidate"),
    approved: route("man350_project_a:approved", "approved"),
    history: route("man350_project_a:history", "history"),
  };
  const config = {
    endpoint: url,
    workspacePeer: false,
    peerId: "man350-project-a",
    requestTimeoutMs: 10000,
    mcpToolCallTimeoutMs: 15000,
    memoryIsolation: routes,
  };
  const compositionFiber = ctx.plugin({
    name: "man350-synthetic-composition",
    inject: ["tools"],
    async apply(pluginCtx) {
      applyOpenViking(pluginCtx, config);
      await waitFor(() => {
        const names = new Set(pluginCtx.tools.schemas().map(tool => tool.name));
        return names.has("mcp__openviking__read")
          && names.has("mcp__openviking_history__read");
      }, 20000);
    },
  });

  let session;
  let agentDisposers = [];
  try {
    await compositionFiber;

    const approvedPrefix = `viking://user/approved/memories`;
    const candidateUri = `viking://user/candidate/memories/entities/${files.candidate}`;
    const historyUri = `viking://~/memories/entities/${files.history}`;
    const otherProjectUri = `viking://user/approved/memories/entities/${files.other}`;
    const assembly = await ctx.systemPrompt.assemble();
    const names = assembly.tools.map(tool => tool.name);
    assert.ok(names.includes("mcp__openviking__read"));
    assert.ok(names.includes("mcp__openviking_history__read"));
    const writableNames = names.filter(name => /__.*(?:write|edit|forget|remember|add_resource|add_skill|delete)/i.test(name));
    assert.deepEqual(writableNames, [], `write-capable DSH tools must stay hidden: ${writableNames.join(", ")}`);
    assert.ok(!names.some(name => name.includes("candidate")));
    const historySchema = assembly.tools.find(tool => tool.name === "mcp__openviking_history__read");
    assert.match(historySchema.description, /HISTORY ROUTE|historical|history/i);

    session = {
      id: `man350-${suffix}`,
      header: { cwd: process.cwd() },
      events: [],
    };
    const agent = {
      status: "idle",
      session,
      injected: [],
      inject(message) { this.injected.push(message); },
      ctx: {
        effect(execute) {
          const dispose = execute();
          if (typeof dispose === "function") agentDisposers.push(dispose);
          return async () => {};
        },
      },
    };

    await ctx.serial("agent/created", {
      agent,
      source: "startup",
      signal: new AbortController().signal,
    });
    assert.equal(agent.injected.length, 1);
    const profileText = agent.injected[0].content.map(part => part.text || "").join("\n");
    assert.match(profileText, new RegExp(markers.profile));
    assert.doesNotMatch(profileText, new RegExp(`${markers.candidate}|${markers.history}|${markers.other}`));

    const prompt = {
      role: "user",
      content: [{ type: "text", text: `Recall ${markers.approved}` }],
      source: { kind: "user" },
    };
    const step = await ctx.waterfall("agent/pre-step", {
      agent,
      messages: [prompt],
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: [prompt] }));
    const recallText = step.messages.flatMap(message => message.content || []).map(part => part.text || "").join("\n");
    assert.match(recallText, new RegExp(markers.approved));
    assert.doesNotMatch(recallText, new RegExp(`${markers.candidate}|${markers.history}|${markers.other}`));

    ctx.emit("session/event", session, {
      type: "user/message",
      data: { ...prompt, content: [{ type: "text", text: `Synthetic DSH capture ${markers.candidate}` }] },
    });
    await ctx.parallel("session/flush", session);

    const candidateClient = new OpenVikingClient({ endpoint: url, apiKey: keys["man350_project_a:candidate"], requestTimeoutMs: 5000 });
    const approvedClient = new OpenVikingClient({ endpoint: url, apiKey: keys["man350_project_a:approved"], requestTimeoutMs: 5000 });
    const sessionId = deriveDshSessionId(session.id);
    const candidateSession = await candidateClient.fetchJSON(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    const approvedSession = await approvedClient.fetchJSON(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(candidateSession.status, 200, JSON.stringify(candidateSession.error));
    assert.equal(candidateSession.result.user.user_id, "candidate");
    assert.equal(approvedSession.status, 200, JSON.stringify(approvedSession.error));
    assert.equal(approvedSession.result.user.user_id, "approved");
    assert.notEqual(candidateSession.result.uri, approvedSession.result.uri);

    const capturedConversation = await candidateClient.fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(`${candidateSession.result.uri}/messages.jsonl`)}`,
    );
    assert.equal(capturedConversation.status, 200, JSON.stringify(capturedConversation.error));
    assert.match(capturedConversation.result, new RegExp(markers.candidate));
    const crossIdentityRead = await approvedClient.fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(`${candidateSession.result.uri}/messages.jsonl`)}`,
    );
    assert.equal(crossIdentityRead.status, 403, JSON.stringify(crossIdentityRead.error));

    const approvedRead = await callTool(ctx, "mcp__openviking__read", { uris: [`${approvedPrefix}/profile.md`] });
    assert.equal(approvedRead.isError, false, JSON.stringify(approvedRead.error));
    assert.match(toolText(approvedRead), new RegExp(markers.profile));

    const candidateRead = await callTool(ctx, "mcp__openviking__read", { uris: [candidateUri] });
    const historyThroughApproved = await callTool(ctx, "mcp__openviking__read", { uris: [`viking://user/history/memories/entities/${files.history}`] });
    const otherProjectRead = await callTool(ctx, "mcp__openviking__read", { uris: [otherProjectUri] });
    assert.equal(candidateRead.isError, true);
    assert.equal(historyThroughApproved.isError, true);
    assert.equal(otherProjectRead.isError, true);

    const historyRead = await callTool(ctx, "mcp__openviking_history__read", { uris: [historyUri] });
    assert.equal(historyRead.isError, false, JSON.stringify(historyRead.error));
    assert.match(toolText(historyRead), new RegExp(markers.history));

    const hiddenWrite = await callTool(ctx, "mcp__openviking__write", {
      uri: "viking://~/memories/entities/must-not-be-written.md",
      content: "must remain unavailable to the DSH agent",
    });
    assert.equal(hiddenWrite.isError, true);
  } finally {
    for (const dispose of agentDisposers.reverse()) await dispose();
    await compositionFiber.dispose();
    await toolsFiber.dispose();
    await promptFiber.dispose();
  }
});

async function seed(identity, relativePath, content) {
  const { url, keys } = JSON.parse(readFileSync(realpathSync(manifestPath), "utf8"));
  const response = await fetch(`${url}/api/v1/content/write`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-Key": keys[identity],
    },
    body: JSON.stringify({
      uri: `viking://~/memories/${relativePath}`,
      content,
      mode: "replace",
      wait: true,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${identity} fixture seed failed: ${JSON.stringify(body.error || body)}`);
}

function route(identity, user) {
  const { url, keys } = JSON.parse(readFileSync(realpathSync(manifestPath), "utf8"));
  return {
    endpoint: url,
    apiKey: keys[identity],
    account: identity.split(":")[0],
    user,
  };
}

async function callTool(ctx, name, args) {
  return ctx.tools.execute({
    callId: `man350-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  });
}

function toolText(result) {
  return (result.content || []).map(part => part.text || "").join("\n");
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`DSH bridge did not publish the expected read-only tools within ${timeoutMs}ms`);
}
