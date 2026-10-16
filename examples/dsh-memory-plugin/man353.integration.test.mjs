import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { apply as applyOpenViking } from "./index.mjs";
import { OpenVikingClient } from "./client.mjs";
import { deriveDshSessionId } from "./session-id.mjs";

const manifestPath = process.env.MAN353_SYNTHETIC_MANIFEST || "";
const syntheticRootPath = process.env.MAN353_SYNTHETIC_ROOT || "";
const RUN_ID = randomUUID().replaceAll("-", "");
const PROJECT_ID = `man353-synthetic-${RUN_ID.slice(0, 12)}`;
const FIRST_MARKER = `MAN351_FACT_${RUN_ID}`;
const SECOND_MARKER = `MAN351_FACT_${randomUUID().replaceAll("-", "")}`;
const FIRST_SOURCE = `Invented delivery note: ${FIRST_MARKER} happened in the synthetic project.`;
const SECOND_SOURCE = `Invented follow-up note: ${SECOND_MARKER} happened in the synthetic project.`;
const APPROVER_LABEL = "Synthetic reviewer (configured label)";

const previousStateDir = process.env.OPENVIKING_STATE_DIR;
const previousPendingDir = process.env.OPENVIKING_PENDING_DIR;

test("MAN-353 publishes only the approved synthetic proposal for a later DSH recall", {
  skip: !manifestPath && "set MAN353_SYNTHETIC_MANIFEST and MAN353_SYNTHETIC_ROOT for the disposable fixture",
}, async () => {
  const manifest = realpathSync(manifestPath);
  assert.equal(basename(manifest), "identities.json");
  assert.ok(syntheticRootPath, "set MAN353_SYNTHETIC_ROOT to the disposable test folder");
  assert.equal(dirname(dirname(manifest)), realpathSync(syntheticRootPath));
  assert.match(basename(dirname(manifest)), /^run-[a-f0-9]{12}$/u);

  const fixtureManifest = JSON.parse(readFileSync(manifest, "utf8"));
  const { url, keys } = fixtureManifest;
  assert.equal(fixtureManifest.server_version, "0.5.0");
  assert.equal(fixtureManifest.extraction_fixture, "man351-deterministic-event-v1");
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.ok(endpoint.port);
  assert.notEqual(endpoint.port, "1933");
  for (const identity of [
    "man350_project_a:candidate",
    "man350_project_a:approved",
    "man350_project_a:history",
    "man350_project_a:admin",
  ]) assert.equal(typeof keys[identity], "string", `missing synthetic identity ${identity}`);

  const candidateRoute = route("man350_project_a:candidate", "candidate", url, keys);
  const approvedRoute = route("man350_project_a:approved", "approved", url, keys);
  const historyRoute = route("man350_project_a:history", "history", url, keys);
  const publisherRoute = route("man350_project_a:admin", "fixture_admin", url, keys);
  const candidateClient = new OpenVikingClient({ ...candidateRoute, peerId: PROJECT_ID, requestTimeoutMs: 10000 });
  const approvedClient = new OpenVikingClient({ ...approvedRoute, peerId: PROJECT_ID, requestTimeoutMs: 10000 });
  const historyClient = new OpenVikingClient({ ...historyRoute, peerId: PROJECT_ID, requestTimeoutMs: 10000 });
  const publisherClient = new OpenVikingClient({ ...publisherRoute, peerId: PROJECT_ID, requestTimeoutMs: 10000 });

  const stateDir = join(dirname(manifest), "man353-state");
  process.env.OPENVIKING_STATE_DIR = stateDir;
  process.env.OPENVIKING_PENDING_DIR = join(stateDir, "pending");

  const ctx = new Context();
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber;
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: "native" });
  await toolsFiber;
  const approvalFiber = ctx.plugin(ApprovalService, { policy: "ask" });
  await approvalFiber;

  const routes = {
    candidate: candidateRoute,
    approved: approvedRoute,
    history: historyRoute,
    publisher: publisherRoute,
    approvalAuthorLabel: APPROVER_LABEL,
  };
  const config = {
    endpoint: url,
    workspacePeer: false,
    peerId: PROJECT_ID,
    requestTimeoutMs: 10000,
    mcpToolCallTimeoutMs: 15000,
    memoryIsolation: routes,
  };

  let compositionFiber;
  try {
    compositionFiber = ctx.plugin({
      name: "man353-synthetic-composition",
      inject: ["tools", "approval"],
      async apply(pluginCtx) {
        applyOpenViking(pluginCtx, config);
        await waitFor(() => {
          const names = new Set(pluginCtx.tools.schemas().map(tool => tool.name));
          return names.has("mcp__openviking__read")
            && names.has("mcp__openviking_history__read")
            && names.has("openviking_review_proposal")
            && names.has("openviking_decide_proposal");
        }, 20000);
      },
    });
    await compositionFiber;

    const tools = new Set(ctx.tools.schemas().map(tool => tool.name));
    assert.equal(tools.has("mcp__openviking__write"), false);
    assert.equal([...tools].some(name => name.includes("publisher")), false);

    const first = await captureAndPrepare(ctx, candidateClient, FIRST_SOURCE, "first");
    const second = await captureAndPrepare(ctx, candidateClient, SECOND_SOURCE, "second");
    assert.notEqual(first.proposal.value.id, second.proposal.value.id);
    assert.equal(first.proposal.value.status, "reviewable");
    assert.equal(second.proposal.value.status, "reviewable");

    const batch = await callTool(ctx, "openviking_review_proposal", {});
    assert.equal(batch.isError, false, JSON.stringify(batch.error));
    assert.equal(batch.value.segments.length, 2);

    const candidateUri = first.candidateUri;
    const beforeRecall = await recallMarker(ctx, `man353-before-${RUN_ID}`, FIRST_MARKER);
    assert.equal(
      JSON.stringify(beforeRecall || "").includes(FIRST_MARKER),
      false,
      "the proposal must be absent from normal approved reads before approval",
    );

    const approvals = [];
    ctx.on("approval/request", request => {
      approvals.push(request);
      return "allowed-once";
    });
    addOpenTurn(first.session);
    const approved = await callTool(ctx, "openviking_decide_proposal", {
      proposalId: first.proposal.value.id,
      action: "approve",
      reason: "Keep only the verified delivery note in this project.",
    }, { agent: agentFor(first.session) });
    assert.equal(approved.isError, false, JSON.stringify(approved.error));
    assert.equal(approved.value.status, "published");
    assert.ok(
      approved.value.uri.startsWith(`viking://resources/${encodeURIComponent(PROJECT_ID)}/approved/`),
      "publication must stay under this project's approved resource prefix",
    );
    const publishedUri = approved.value.uri;
    assert.equal(approvals.length, 1);
    assert.match(approvals[0].reason, /Keep only the verified delivery note/u);

    const publishedText = await readContent(approvedClient, publishedUri);
    const record = parseApprovalRecord(publishedText);
    assert.equal(record.schema, "openviking.dsh.approval.v1");
    assert.equal(record.proposalId, first.proposal.value.id);
    assert.equal(record.authorLabel, APPROVER_LABEL);
    assert.equal(record.authorLabelIsConfigured, true);
    assert.equal(record.project, PROJECT_ID);
    assert.equal(record.scope, `project:${PROJECT_ID}`);
    assert.equal(record.source.archiveUri, first.archiveUri);
    assert.equal(record.source.session, first.session.id);
    assert.equal(record.source.segment, `${first.session.id}:1`);
    assert.deepEqual(record.source.eventIds, [first.eventId]);
    assert.equal(record.reason, "Keep only the verified delivery note in this project.");
    assert.ok(Number.isFinite(Date.parse(record.approvedAt)));
    assert.ok(publishedText.includes(FIRST_SOURCE));
    assert.equal(publishedText.includes(SECOND_SOURCE), false);

    const candidateAccess = await approvedClient.fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(candidateUri)}`,
    );
    assert.equal(candidateAccess.ok, false);
    assert.equal(candidateAccess.status, 403, "normal approved access must not read the candidate path");
    for (const isolatedClient of [candidateClient, historyClient]) {
      const isolatedRead = await isolatedClient.fetchJSON(
        `/api/v1/content/read?uri=${encodeURIComponent(publishedUri)}`,
      );
      assert.equal(isolatedRead.ok, false);
      assert.equal(isolatedRead.status, 403, "candidate and history identities must not read approved resources");
    }

    addOpenTurn(first.session);
    const repeated = await callTool(ctx, "openviking_decide_proposal", {
      proposalId: first.proposal.value.id,
      action: "approve",
      reason: "A retry must not replace the first confirmed reason.",
    }, { agent: agentFor(first.session) });
    assert.equal(repeated.value.status, "already_published");
    assert.equal(approvals.length, 1, "a repeated decision must not ask for a second approval");
    assert.equal(await readContent(approvedClient, publishedUri), publishedText);
    assert.equal((publishedText.match(/openviking-approval:v1/gu) || []).length, 1);

    addOpenTurn(second.session);
    const deferred = await callTool(ctx, "openviking_decide_proposal", {
      proposalId: second.proposal.value.id,
      action: "defer",
    }, { agent: agentFor(second.session) });
    assert.equal(deferred.value.status, "deferred_not_published");
    const stillReviewable = await callTool(ctx, "openviking_review_proposal", {
      proposalId: second.proposal.value.id,
    });
    assert.equal(stillReviewable.value.status, "reviewable");
    const deferredRecall = await recallMarker(ctx, `man353-deferred-${RUN_ID}`, SECOND_MARKER);
    assert.equal(
      JSON.stringify(deferredRecall || "").includes(SECOND_MARKER),
      false,
      "the deferred candidate must stay out of normal approved reads",
    );
    assert.equal(approvals.length, 1, "deferring the other proposal must not request publication approval");

    const laterSession = makeSession(`man353-later-${RUN_ID}`);
    const recalled = await compositionRuntime(ctx).recallMessage(
      agentFor(laterSession),
      [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: FIRST_MARKER }] }],
    );
    assert.ok(recalled, "a later DSH session should receive the approved memory");
    const recalledText = JSON.stringify(recalled);
    assert.ok(recalledText.includes(FIRST_MARKER));
    assert.equal(recalledText.includes(SECOND_MARKER), false, "the deferred candidate must stay out of normal recall");
    assert.equal(recalledText.includes(candidateUri), false, "normal recall must not return the candidate path");
  } finally {
    if (compositionFiber) await compositionFiber.dispose();
    await approvalFiber.dispose();
    await toolsFiber.dispose();
    await promptFiber.dispose();
    if (previousStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
    else process.env.OPENVIKING_STATE_DIR = previousStateDir;
    if (previousPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR;
    else process.env.OPENVIKING_PENDING_DIR = previousPendingDir;
  }
});

async function captureAndPrepare(ctx, candidateClient, sourceText, suffix) {
  const session = makeSession(`man353-origin-${RUN_ID}-${suffix}`);
  const eventId = `man353-event-${RUN_ID}-${suffix}`;
  const userEvent = {
    id: eventId,
    type: "user/message",
    time: Date.now(),
    data: {
      role: "user",
      content: [{ type: "text", text: sourceText }],
      source: { kind: "user" },
    },
  };
  session.events.push(userEvent);
  ctx.emit("session/event", session, userEvent);
  await ctx.parallel("session/flush", session);

  const compaction = { id: `man353-compaction-${suffix}`, type: "compaction/start", data: {} };
  session.events.push(compaction);
  ctx.emit("session/event", session, compaction);
  await ctx.parallel("session/flush", session);

  const openVikingSessionId = deriveDshSessionId(session.id);
  const task = await waitForSessionCommit(candidateClient, openVikingSessionId, 60000);
  assert.equal(task.status, "completed", task.error || JSON.stringify(task));
  assert.ok(task.result?.archive_uri);
  assert.ok(task.result?.memory_diff_uri);

  const archive = await readContent(candidateClient, `${task.result.archive_uri}/messages.jsonl`);
  assert.ok(archive.includes(sourceText));
  const diff = JSON.parse(await readContent(candidateClient, task.result.memory_diff_uri));
  const additions = diff.operations?.adds || [];
  assert.equal(additions.length, 1, "the synthetic extraction must yield one candidate");
  const candidateUri = additions[0].uri;
  const candidateText = await readContent(candidateClient, candidateUri);
  assert.ok(candidateText.includes(sourceText));

  await waitFor(() => compositionRuntime(ctx).listProposalSegments().some(segment => (
    segment.segmentId === `${session.id}:1`
    && segment.extraction?.status === "completed_non_empty"
  )), 60000);

  const proposal = await callTool(ctx, "openviking_review_proposal", {
    segmentId: `${session.id}:1`,
  });
  assert.equal(proposal.isError, false, JSON.stringify(proposal.error));
  assert.equal(proposal.value.status, "reviewable", JSON.stringify(proposal.value));
  assert.equal(proposal.value.session, session.id);
  assert.equal(proposal.value.segment, `${session.id}:1`);
  assert.equal(proposal.value.originalPassage, sourceText);
  assert.equal(proposal.value.proposedText, candidateText.trim());
  assert.equal(proposal.value.source.candidateUri, candidateUri);

  const opened = await callTool(ctx, "openviking_review_proposal", {
    proposalId: proposal.value.id,
  });
  assert.equal(opened.value.status, "reviewable");
  assert.ok(opened.content.map(part => part.text || "").join("\n").includes(sourceText));
  return { session, eventId, proposal, archiveUri: task.result.archive_uri, candidateUri };
}

function makeSession(id) {
  const session = {
    id,
    header: { cwd: process.cwd() },
    events: [],
    append(type, data) {
      this.events.push({ id: `man353-approval-${this.events.length}`, type, time: Date.now(), data });
    },
  };
  return session;
}

function addOpenTurn(session) {
  session.events.push({ id: `man353-turn-${session.events.length}`, type: "turn/start", time: Date.now(), data: {} });
}

function agentFor(session) {
  return { status: "idle", session, ctx: { effect() {} } };
}

function route(identity, user, endpoint, keys) {
  return {
    endpoint,
    apiKey: keys[identity],
    account: identity.split(":")[0],
    user,
  };
}

async function recallMarker(ctx, sessionId, marker) {
  return compositionRuntime(ctx).recallMessage(agentFor(makeSession(sessionId)), [
    {
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: marker }],
    },
  ]);
}

async function callTool(ctx, name, args, { agent } = {}) {
  return ctx.tools.execute({
    callId: `man353-${RUN_ID}-${randomUUID()}`,
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
    signal: new AbortController().signal,
  });
}

async function readContent(client, uri) {
  const response = await client.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result;
}

function parseApprovalRecord(content) {
  const prefix = "<!-- openviking-approval:v1\n";
  assert.ok(content.startsWith(prefix), "the published memory must include its approval record");
  const end = content.indexOf("\n-->", prefix.length);
  assert.ok(end > prefix.length);
  return JSON.parse(content.slice(prefix.length, end));
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
  throw new Error(`synthetic session commit did not finish: ${JSON.stringify(lastTask)}`);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Expected synthetic DSH condition was not reached within ${timeoutMs}ms`);
}

function compositionRuntime(ctx) {
  return ctx.get("openvikingMemory");
}
