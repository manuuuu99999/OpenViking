import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { apply as applyOpenViking } from "./index.mjs";
import { OpenVikingClient } from "./client.mjs";
import { deriveDshSessionId } from "./session-id.mjs";

const manifestPath = process.env.MAN351_SYNTHETIC_MANIFEST || process.env.MAN350_SYNTHETIC_MANIFEST || "";
const syntheticRootPath = process.env.MAN350_SYNTHETIC_ROOT || "";
const FIXTURE_RUN_ID = randomUUID().replaceAll("-", "");
const FACT_MARKER = `MAN351_FACT_${FIXTURE_RUN_ID}`;

test("MAN-351 extraction becomes an opened MAN-352 proposal without changing approved memory", {
  skip: !manifestPath && "set MAN351_SYNTHETIC_MANIFEST and MAN350_SYNTHETIC_ROOT for the disposable fixture",
}, async () => {
  const manifest = realpathSync(manifestPath);
  assert.equal(basename(manifest), "identities.json");
  assert.ok(syntheticRootPath, "set MAN350_SYNTHETIC_ROOT to the disposable test folder");
  assert.equal(dirname(dirname(manifest)), realpathSync(syntheticRootPath));
  assert.match(basename(dirname(manifest)), /^run-[a-f0-9]{12}$/);

  const fixture = JSON.parse(readFileSync(manifest, "utf8"));
  const { url, keys } = fixture;
  assert.equal(fixture.server_version, "0.5.0");
  assert.equal(fixture.extraction_fixture, "man351-deterministic-event-v1");
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.ok(endpoint.port);
  assert.notEqual(endpoint.port, "1933");
  for (const identity of [
    "man350_project_a:candidate",
    "man350_project_a:approved",
    "man350_project_a:history",
  ]) assert.equal(typeof keys[identity], "string", `missing synthetic identity ${identity}`);

  const candidateClient = new OpenVikingClient({
    endpoint: url,
    apiKey: keys["man350_project_a:candidate"],
    requestTimeoutMs: 10000,
  });
  const approvedClient = new OpenVikingClient({
    endpoint: url,
    apiKey: keys["man350_project_a:approved"],
    requestTimeoutMs: 10000,
  });
  const approvedUri = "viking://~/memories/entities/man351-approved-baseline.md";
  const approvedBefore = "Approved MAN-351 baseline; extraction must not change this exact text.";
  const seeded = await approvedClient.fetchJSON("/api/v1/content/write", {
    method: "POST",
    body: JSON.stringify({ uri: approvedUri, content: approvedBefore, mode: "replace", wait: true }),
  });
  assert.equal(seeded.ok, true, JSON.stringify(seeded.error));

  const previousStateDir = process.env.OPENVIKING_STATE_DIR;
  const previousPendingDir = process.env.OPENVIKING_PENDING_DIR;
  process.env.OPENVIKING_STATE_DIR = join(dirname(manifest), "man351-state");
  process.env.OPENVIKING_PENDING_DIR = join(dirname(manifest), "man351-pending");
  const ctx = new Context();
  const traceUpdates = [];
  const originalDebug = ctx.logger.debug;
  ctx.logger.debug = message => {
    const prefix = "[openviking:dsh] segment_trace ";
    if (message.startsWith(prefix)) traceUpdates.push(JSON.parse(message.slice(prefix.length)));
  };
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber;
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: "native" });
  await toolsFiber;
  const routes = {
    candidate: route("man350_project_a:candidate", "candidate", url, keys),
    approved: route("man350_project_a:approved", "approved", url, keys),
    history: route("man350_project_a:history", "history", url, keys),
  };
  const config = {
    endpoint: url,
    workspacePeer: false,
    peerId: "man351-synthetic-project",
    requestTimeoutMs: 10000,
    mcpToolCallTimeoutMs: 15000,
    memoryIsolation: routes,
  };
  const compositionFiber = ctx.plugin({
    name: "man351-synthetic-composition",
    inject: ["tools"],
    async apply(pluginCtx) {
      applyOpenViking(pluginCtx, config);
      await waitFor(() => {
        const names = new Set(pluginCtx.tools.schemas().map(tool => tool.name));
        return names.has("mcp__openviking__read")
          && names.has("mcp__openviking_history__read")
          && names.has("openviking_review_proposal");
      }, 20000);
    },
  });

  try {
    await compositionFiber;
    const session = {
      id: `man351-synthetic-conversation-${FIXTURE_RUN_ID}`,
      header: { cwd: process.cwd() },
      events: [],
    };
    const sourceText = `Invented observation: ${FACT_MARKER} happened in the synthetic project.`;
    const userEvent = {
      id: `man351-user-event-${FIXTURE_RUN_ID}`,
      type: "user/message",
      time: Date.now(),
      data: {
        role: "user",
        content: [{
          type: "text",
          text: sourceText,
        }],
        source: { kind: "user" },
      },
    };
    session.events.push(userEvent);
    ctx.emit("session/event", session, userEvent);
    await ctx.parallel("session/flush", session);

    const commitEvent = { id: "man351-compaction-1", type: "compaction/start", data: {} };
    session.events.push(commitEvent);
    ctx.emit("session/event", session, commitEvent);
    await ctx.parallel("session/flush", session);

    const sessionId = deriveDshSessionId(session.id);
    const task = await waitForSessionCommit(candidateClient, sessionId, 60000);
    assert.equal(task.status, "completed", task.error || JSON.stringify(task));
    assert.equal(task.task_type, "session_commit");
    assert.equal(task.resource_id, sessionId);
    assert.ok(task.result?.archive_uri, "completed extraction must identify its durable archive");

    const archived = await readContent(candidateClient, `${task.result.archive_uri}/messages.jsonl`);
    assert.match(archived, new RegExp(FACT_MARKER), "the archive must contain the captured DSH event");

    const memoryDiffText = await readContent(candidateClient, task.result.memory_diff_uri);
    const memoryDiff = JSON.parse(memoryDiffText);
    const additions = memoryDiff.operations?.adds || [];
    assert.equal(additions.length, 1, `the controlled extraction must create one unambiguous candidate: ${JSON.stringify(memoryDiff.operations)}`);
    const extractedMemory = await readContent(candidateClient, additions[0].uri);
    const candidateAssertion = `${FACT_MARKER} happened in the synthetic project.`;
    const summaryLine = extractedMemory.match(/^# Summary\r?\n([^\r\n]+)/u)?.[1];
    assert.equal(summaryLine, candidateAssertion);
    assert.ok(extractedMemory.length > candidateAssertion.length, "the server candidate must include the full Markdown memory, not only the summary");
    assert.match(extractedMemory, /^# .*ChatLog:/mu);

    const approvedAfter = await readContent(approvedClient, approvedUri);
    assert.equal(approvedAfter, approvedBefore, "candidate extraction must leave approved memory byte-for-byte unchanged");

    const trace = await waitForSegmentTrace(traceUpdates, item => (
      item.dshSessionId === session.id && item.extraction?.status === "completed_non_empty"
    ));
    assert.equal(trace.projectId, config.peerId);
    assert.equal(trace.openVikingSessionId, sessionId);
    assert.deepEqual(trace.coveredEventIds, [userEvent.id]);
    assert.equal(trace.capture.status, "captured");
    assert.equal(trace.archive.status, "confirmed");
    assert.equal(trace.archive.uri, task.result.archive_uri);
    assert.equal(trace.extraction.taskStatus, "completed");
    assert.equal(trace.extraction.taskId, task.task_id);
    assert.equal(trace.extraction.memoryDiffUri, task.result.memory_diff_uri);
    assert.ok(trace.extraction.operations.adds > 0);

    const segmentId = `${session.id}:1`;
    const prepared = await ctx.tools.execute({
      callId: `man352-prepare-${FIXTURE_RUN_ID}`,
      name: "openviking_review_proposal",
      arguments: { segmentId },
      signal: new AbortController().signal,
    });
    assert.equal(prepared.isError, false, JSON.stringify(prepared.error));
    assert.equal(prepared.value.status, "reviewable", JSON.stringify(prepared.value));
    assert.equal(prepared.value.project, config.peerId);
    assert.equal(prepared.value.session, session.id);
    assert.equal(prepared.value.segment, segmentId);
    assert.equal(prepared.value.assertion, candidateAssertion);
    assert.equal(prepared.value.originalPassage, sourceText);
    assert.deepEqual(prepared.value.coverage.eventIds, [userEvent.id]);
    assert.equal(prepared.value.approvedPrevious.status, "none");
    assert.equal(prepared.value.proposedText, extractedMemory.trim());

    const opened = await ctx.tools.execute({
      callId: `man352-open-${FIXTURE_RUN_ID}`,
      name: "openviking_review_proposal",
      arguments: { proposalId: prepared.value.id },
      signal: new AbortController().signal,
    });
    assert.equal(opened.isError, false, JSON.stringify(opened.error));
    const agentOutput = opened.content.map(part => part.text || "").join("\n");
    for (const visible of [config.peerId, session.id, segmentId, candidateAssertion, sourceText, extractedMemory.trim()]) {
      assert.ok(agentOutput.includes(visible), `the agent must receive ${visible.slice(0, 120)}`);
    }

    const proposalTool = ctx.tools.get("openviking_review_proposal");
    const view = proposalTool.presentResult(
      { proposalId: prepared.value.id },
      { content: opened.content, isError: false, meta: opened.meta },
    );
    assert.equal(view.card, "generic");
    assert.equal(view.title, "Propuesta de memoria");
    for (const visible of [config.peerId, session.id, segmentId, candidateAssertion, sourceText, extractedMemory.trim()]) {
      assert.ok(view.content.includes(visible), `the review view must show ${visible.slice(0, 120)}`);
    }

    const candidateUri = additions[0].uri;
    const candidateUserPrefix = `viking://user/${routes.candidate.user}/`;
    assert.ok(candidateUri.startsWith(candidateUserPrefix));
    const approvedCandidateUri = `viking://user/${routes.approved.user}/${candidateUri.slice(candidateUserPrefix.length)}`;
    const candidateInApproved = await approvedClient.fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(candidateUri)}`,
    );
    assert.equal(candidateInApproved.ok, false);
    assert.equal(candidateInApproved.status, 403, "the approved identity must not read the candidate user's private URI");
    const approvedCounterpart = await approvedClient.fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(approvedCandidateUri)}`,
    );
    assert.equal(approvedCounterpart.ok, false);
    assert.equal(approvedCounterpart.status, 404, "the equivalent approved path has no prior memory");
    assert.equal(await readContent(approvedClient, approvedUri), approvedBefore);
  } finally {
    await compositionFiber.dispose();
    await toolsFiber.dispose();
    await promptFiber.dispose();
    ctx.logger.debug = originalDebug;
    if (previousStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
    else process.env.OPENVIKING_STATE_DIR = previousStateDir;
    if (previousPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR;
    else process.env.OPENVIKING_PENDING_DIR = previousPendingDir;
  }
});

function route(identity, user, endpoint, keys) {
  return {
    endpoint,
    apiKey: keys[identity],
    account: identity.split(":")[0],
    user,
  };
}

async function readContent(client, uri) {
  const response = await client.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result;
}

async function waitForSessionCommit(client, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTask = null;
  while (Date.now() < deadline) {
    const response = await client.fetchJSON(
      `/api/v1/tasks?task_type=session_commit&resource_id=${encodeURIComponent(sessionId)}&limit=20`,
    );
    assert.equal(response.ok, true, JSON.stringify(response.error));
    const task = response.result?.find(item => item.resource_id === sessionId);
    if (task) {
      lastTask = task;
      if (["completed", "failed", "cancelled"].includes(task.status)) return task;
      const current = await client.fetchJSON(`/api/v1/tasks/${encodeURIComponent(task.task_id)}`);
      assert.equal(current.ok, true, JSON.stringify(current.error));
      lastTask = current.result;
      if (["completed", "failed", "cancelled"].includes(lastTask?.status)) return lastTask;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`session commit did not reach a terminal task state: ${JSON.stringify(lastTask)}`);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`DSH bridge did not publish the expected read-only tools within ${timeoutMs}ms`);
}

async function waitForSegmentTrace(traceUpdates, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const trace = [...traceUpdates].reverse().find(predicate);
    if (trace) return trace;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`segment trace did not reach the expected result within ${timeoutMs}ms`);
}
