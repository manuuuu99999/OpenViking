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

const manifestPath = process.env.MAN354_SYNTHETIC_MANIFEST || "";
const syntheticRootPath = process.env.MAN354_SYNTHETIC_ROOT || "";
const RUN_ID = randomUUID().replaceAll("-", "");
const PROJECT_ID = `man354-synthetic-${RUN_ID.slice(0, 12)}`;
const marker = () => `MAN351_FACT_${randomUUID().replaceAll("-", "")}`;
const BASE = marker();
const EXTENSION = marker();
const REPLACEMENT = marker();
const RETIREMENT = marker();
const APPROVER_LABEL = "Synthetic reviewer (configured label)";

const previousStateDir = process.env.OPENVIKING_STATE_DIR;
const previousPendingDir = process.env.OPENVIKING_PENDING_DIR;
const realFetch = globalThis.fetch;

test("MAN-354 changes an approved memory in versions, keeps history and survives a failed publication", {
  skip: !manifestPath && "set MAN354_SYNTHETIC_MANIFEST and MAN354_SYNTHETIC_ROOT for the disposable fixture",
}, async () => {
  const manifest = realpathSync(manifestPath);
  assert.equal(basename(manifest), "identities.json");
  assert.ok(syntheticRootPath, "set MAN354_SYNTHETIC_ROOT to the disposable test folder");
  assert.equal(dirname(dirname(manifest)), realpathSync(syntheticRootPath));
  assert.match(basename(dirname(manifest)), /^run-[a-f0-9]{12}$/u);

  const { url, keys, server_version: serverVersion, extraction_fixture: extractionFixture } = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(serverVersion, "0.5.0");
  assert.equal(extractionFixture, "man351-deterministic-event-v1");
  const endpoint = new URL(url);
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.notEqual(endpoint.port, "1933");

  const route = (identity, user) => ({ endpoint: url, apiKey: keys[identity], account: identity.split(":")[0], user });
  const candidateRoute = route("man350_project_a:candidate", "candidate");
  const approvedRoute = route("man350_project_a:approved", "approved");
  const historyRoute = route("man350_project_a:history", "history");
  const publisherRoute = route("man350_project_a:admin", "fixture_admin");
  const clientFor = routeConfig => new OpenVikingClient({ ...routeConfig, peerId: PROJECT_ID, requestTimeoutMs: 10000 });
  const candidateClient = clientFor(candidateRoute);
  const approvedClient = clientFor(approvedRoute);
  const historyClient = clientFor(historyRoute);
  const publisherClient = clientFor(publisherRoute);

  // Publication needs real resource ACLs; the plugin refuses to publish without them.
  const acl = await publisherClient.fetchJSON(`/api/v1/admin/accounts/${publisherRoute.account}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ acl: { enabled: true } }),
  });
  assert.equal(acl.ok, true, JSON.stringify(acl.error));

  const stateDir = join(dirname(manifest), "man354-state");
  process.env.OPENVIKING_STATE_DIR = stateDir;
  process.env.OPENVIKING_PENDING_DIR = join(stateDir, "pending");

  const ctx = new Context();
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber;
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: "native" });
  await toolsFiber;
  const approvalFiber = ctx.plugin(ApprovalService, { policy: "ask" });
  await approvalFiber;

  const config = {
    endpoint: url,
    workspacePeer: false,
    peerId: PROJECT_ID,
    requestTimeoutMs: 10000,
    mcpToolCallTimeoutMs: 15000,
    memoryIsolation: {
      candidate: candidateRoute,
      approved: approvedRoute,
      history: historyRoute,
      publisher: publisherRoute,
      approvalAuthorLabel: APPROVER_LABEL,
    },
  };

  // The only injected fault: the publisher's next write or delete to approved memory fails.
  let fault = null;
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = String(input?.url || input);
    const publisherCall = String(init.headers?.Authorization || "").includes(keys["man350_project_a:admin"]);
    if (fault && publisherCall && requestUrl.includes("/api/v1/content/write")
      && JSON.parse(init.body || "{}").uri?.includes("/approved/")) {
      const current = fault;
      fault = null;
      if (current === "before-write") throw new TypeError("injected: connection dropped before the write");
      await realFetch(input, init);
      throw new TypeError("injected: connection dropped after the write was applied");
    }
    return realFetch(input, init);
  };

  let compositionFiber;
  try {
    compositionFiber = ctx.plugin({
      name: "man354-synthetic-composition",
      inject: ["tools", "approval"],
      async apply(pluginCtx) {
        applyOpenViking(pluginCtx, config);
        await waitFor(() => {
          const names = new Set(pluginCtx.tools.schemas().map(tool => tool.name));
          return names.has("openviking_review_proposal") && names.has("openviking_decide_proposal");
        }, 20000);
      },
    });
    await compositionFiber;

    const approvals = [];
    let approvalOutcome = "allowed-once";
    ctx.on("approval/request", request => {
      approvals.push(request);
      return approvalOutcome;
    });
    const decide = async (conversation, proposalId, action, reason) => {
      addOpenTurn(conversation.session);
      const result = await callTool(ctx, "openviking_decide_proposal", {
        proposalId,
        action,
        ...(reason ? { reason } : {}),
      }, { agent: agentFor(conversation.session) });
      assert.equal(result.isError, false, JSON.stringify(result.error));
      return result.value;
    };
    const readHistory = uri => readContent(historyClient, uri);
    const normalRecall = text => recallMarker(ctx, `man354-${randomUUID()}`, text);

    // 1. An approved alta is the base (version 1).
    const base = await captureAndPrepare(ctx, candidateClient, sentence("Invented delivery note", BASE), "base");
    const baseDecision = await decide(base, base.proposal.value.id, "approve", "Base rule confirmed.");
    assert.equal(baseDecision.status, "published", JSON.stringify(baseDecision));
    const currentUri = baseDecision.uri;
    const version1 = await readContent(approvedClient, currentUri);
    assert.ok(version1.includes(BASE));

    // 2. Extension: nothing changes before approval; a refused confirmation changes nothing either.
    const extension = await captureAndPrepare(ctx, candidateClient, sentence("Invented follow-up note", EXTENSION), "extension");
    const extend = await prepareChange(ctx, extension, "extend", currentUri);
    assert.equal(extend.status, "reviewable", JSON.stringify(extend));
    assert.ok(extend.approvedPrevious.text.includes(BASE));
    assert.ok(extend.proposedText.includes(BASE) && extend.proposedText.includes(EXTENSION));
    assert.equal(await readContent(approvedClient, currentUri), version1);
    approvalOutcome = "rejected";
    const refused = await decide(extension, extend.id, "approve", "Add the follow-up condition.");
    assert.equal(refused.status, "approval_rejected");
    assert.equal(await readContent(approvedClient, currentUri), version1, "a rejected approval changes nothing");
    approvalOutcome = "allowed-once";

    // 3. The first real publication attempt fails before the current memory is written.
    fault = "before-write";
    const interrupted = await decide(extension, extend.id, "approve", "Add the follow-up condition.");
    assert.equal(interrupted.status, "publication_failed", JSON.stringify(interrupted));
    assert.equal(interrupted.recoverable, true);
    const afterInterruption = await readContent(approvedClient, currentUri);
    assert.equal(afterInterruption, version1, "normal reading still has the whole previous version");
    assert.equal(afterInterruption.includes(EXTENSION), false);
    const confirmations = approvals.length;
    const completed = await decide(extension, extend.id, "approve");
    assert.equal(completed.status, "published", JSON.stringify(completed));
    assert.equal(approvals.length, confirmations, "the retry finished the confirmed decision without asking again");
    assert.equal(completed.version, 2);
    const version2 = await readContent(approvedClient, currentUri);
    assert.ok(version2.includes(BASE) && version2.includes(EXTENSION), "the current memory is self-sufficient");
    const record2 = parseApprovalRecord(version2);
    assert.equal(record2.change.kind, "extend");
    assert.equal(record2.change.version, 2);
    assert.equal(record2.reason, "Add the follow-up condition.");
    assert.equal(record2.source.segment, `${extension.session.id}:1`);
    const history1 = await readHistory(record2.change.previous.historyUri);
    assert.ok(history1.endsWith(version1), "version 1 is preserved whole");
    assert.equal(parseApprovalRecord(history1.slice(history1.indexOf("\n-->\n\n") + 6)).proposalId, base.proposal.value.id);
    const denied = await approvedClient.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(record2.change.previous.historyUri)}`);
    assert.equal(denied.status, 403, "normal reading cannot open history");
    const recalledExtended = JSON.stringify(await normalRecall(EXTENSION));
    assert.ok(recalledExtended.includes(BASE) && recalledExtended.includes(EXTENSION));
    const repeated = await decide(extension, extend.id, "approve");
    assert.equal(repeated.status, "already_published");

    // 4. Two changes prepared from the same version: the first one wins, the second asks for a new review.
    const replacement = await captureAndPrepare(ctx, candidateClient, sentence("Invented correction note", REPLACEMENT), "replacement");
    const retirement = await captureAndPrepare(ctx, candidateClient, sentence("Invented withdrawal note", RETIREMENT), "retirement");
    const replace = await prepareChange(ctx, replacement, "replace", currentUri);
    const retire = await prepareChange(ctx, retirement, "retire", currentUri);
    assert.equal(replace.status, "reviewable", JSON.stringify(replace));
    assert.equal(retire.status, "reviewable", JSON.stringify(retire));
    assert.equal(retire.proposedText, "");

    // The server applies the replacement but the answer is lost: the retry must not write again.
    fault = "after-write";
    const lost = await decide(replacement, replace.id, "approve", "The rule changed.");
    assert.equal(lost.status, "publication_failed");
    const version3 = await readContent(approvedClient, currentUri);
    assert.ok(version3.includes(REPLACEMENT), "the server applied the write");
    assert.equal(version3.includes(BASE), false, "the replaced text is gone from normal reading");
    assert.equal(version3.includes(EXTENSION), false);
    const recovered = await decide(replacement, replace.id, "approve");
    assert.equal(recovered.status, "already_published", JSON.stringify(recovered));
    assert.equal(await readContent(approvedClient, currentUri), version3);
    const record3 = parseApprovalRecord(version3);
    assert.equal(record3.change.version, 3);
    const history2 = await readHistory(record3.change.previous.historyUri);
    assert.ok(history2.endsWith(version2));

    const stale = await decide(retirement, retire.id, "approve", "Retire the old rule.");
    assert.equal(stale.status, "base_version_changed");
    assert.equal(await readContent(approvedClient, currentUri), version3, "the stale proposal changed nothing");
    const reopened = await callTool(ctx, "openviking_review_proposal", { proposalId: retire.id });
    assert.equal(reopened.value.status, "needs_new_review");

    // 5. A new review against the current version, then the approved retirement.
    const renewed = await prepareChange(ctx, retirement, "retire", currentUri);
    assert.equal(renewed.status, "reviewable", JSON.stringify(renewed));
    assert.equal(renewed.change.base.version, 3);
    const retired = await decide(retirement, renewed.id, "approve", "Retire the old rule.");
    assert.equal(retired.status, "published", JSON.stringify(retired));
    const gone = await approvedClient.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(currentUri)}`);
    assert.equal(gone.status, 404, "a retired memory leaves normal reading");
    const afterRetirement = JSON.stringify(await normalRecall(REPLACEMENT) || "");
    assert.equal(afterRetirement.includes(REPLACEMENT), false);
    assert.equal(afterRetirement.includes(BASE), false);

    const history3 = await readHistory(retired.historyUri);
    assert.ok(history3.endsWith(version3));
    const retireRecord = JSON.parse(history3.slice("<!-- openviking-history:v1\n".length, history3.indexOf("\n-->")));
    assert.equal(retireRecord.decision.kind, "retire");
    assert.equal(retireRecord.decision.reason, "Retire the old rule.");
    assert.equal(retireRecord.decision.supersededByVersion, null);
    const historyFolder = retired.historyUri.slice(0, retired.historyUri.lastIndexOf("/"));
    const historyListing = await historyClient.fetchJSON(
      `/api/v1/fs/ls?uri=${encodeURIComponent(historyFolder)}&simple=true`,
    );
    assert.equal(historyListing.ok, true, JSON.stringify(historyListing.error));
    assert.equal(historyListing.result.length, 3, "all three superseded versions persist in deliberate history");
    for (const isolated of [candidateClient, historyClient]) {
      const read = await isolated.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(currentUri)}`);
      assert.equal(read.ok, false);
    }
  } finally {
    globalThis.fetch = realFetch;
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

const sentence = (label, factMarker) => `${label}: ${factMarker} happened in the synthetic project.`;

async function prepareChange(ctx, conversation, changeKind, targetUri) {
  const prepared = await callTool(ctx, "openviking_review_proposal", {
    segmentId: `${conversation.session.id}:1`,
    changeKind,
    targetUri,
  });
  assert.equal(prepared.isError, false, JSON.stringify(prepared.error));
  return prepared.value;
}

async function captureAndPrepare(ctx, candidateClient, sourceText, suffix) {
  const session = makeSession(`man354-origin-${RUN_ID}-${suffix}`);
  const userEvent = {
    id: `man354-event-${RUN_ID}-${suffix}`,
    type: "user/message",
    time: Date.now(),
    data: { role: "user", content: [{ type: "text", text: sourceText }], source: { kind: "user" } },
  };
  session.events.push(userEvent);
  ctx.emit("session/event", session, userEvent);
  await ctx.parallel("session/flush", session);
  const compaction = { id: `man354-compaction-${suffix}`, type: "compaction/start", data: {} };
  session.events.push(compaction);
  ctx.emit("session/event", session, compaction);
  await ctx.parallel("session/flush", session);

  const task = await waitForSessionCommit(candidateClient, deriveDshSessionId(session.id), 60000);
  assert.equal(task.status, "completed", task.error || JSON.stringify(task));
  await waitFor(() => compositionRuntime(ctx).listProposalSegments().some(segment => (
    segment.segmentId === `${session.id}:1` && segment.extraction?.status === "completed_non_empty"
  )), 60000);

  const proposal = await callTool(ctx, "openviking_review_proposal", { segmentId: `${session.id}:1` });
  assert.equal(proposal.isError, false, JSON.stringify(proposal.error));
  // A base alta is reviewable; a follow-up note is later used only as evidence for a change.
  return { session, proposal };
}

function makeSession(id) {
  return {
    id,
    header: { cwd: process.cwd() },
    events: [],
    append(type, data) {
      this.events.push({ id: `man354-approval-${this.events.length}`, type, time: Date.now(), data });
    },
  };
}

function addOpenTurn(session) {
  session.events.push({ id: `man354-turn-${session.events.length}`, type: "turn/start", time: Date.now(), data: {} });
}

function agentFor(session) {
  return { status: "idle", session, ctx: { effect() {} } };
}

async function recallMarker(ctx, sessionId, text) {
  return compositionRuntime(ctx).recallMessage(agentFor(makeSession(sessionId)), [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
  ]);
}

async function callTool(ctx, name, args, { agent } = {}) {
  return ctx.tools.execute({
    callId: `man354-${RUN_ID}-${randomUUID()}`,
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
    signal: new AbortController().signal,
  });
}

async function readContent(client, uri) {
  const response = await client.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
  assert.equal(response.ok, true, `${uri}: ${JSON.stringify(response.error)}`);
  return response.result;
}

function parseApprovalRecord(content) {
  const prefix = "<!-- openviking-approval:v1\n";
  assert.ok(content.startsWith(prefix), "the memory must include its approval record");
  return JSON.parse(content.slice(prefix.length, content.indexOf("\n-->", prefix.length)));
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
