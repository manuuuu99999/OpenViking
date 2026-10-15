import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { enqueue, listPending } from "./shared/pending-queue.mjs";
import { deriveWorkspacePeerId } from "./shared/workspace-peer.mjs";
import { OPENVIKING_PLUGIN_KIND } from "./capture.mjs";
import { OpenVikingRuntime } from "./runtime.mjs";

const originalPendingDir = process.env.OPENVIKING_PENDING_DIR;
const originalStateDir = process.env.OPENVIKING_STATE_DIR;
const tempDirs = [];

afterEach(async () => {
  if (originalPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR;
  else process.env.OPENVIKING_PENDING_DIR = originalPendingDir;
  if (originalStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
  else process.env.OPENVIKING_STATE_DIR = originalStateDir;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test("runtime uses a portable OpenViking id for DSH IM sessions", () => {
  const runtime = new OpenVikingRuntime({}, config(), { debug() {} });
  const state = runtime.stateFor({
    id: "im:weixin_fixture:dm:1790750070550:chat_fixture@im.wechat",
    header: { cwd: "/workspace" },
  });

  assert.equal(
    state.ovSessionId,
    "dsh-im_weixin_fixture_dm_1790750070550_chat_fixture@im.wechat__eb8b3dae7d74",
  );
});

test("capture queues retryable failures but drops permanent client errors", async () => {
  for (const [status, expectedPending] of [[400, 0], [503, 1]]) {
    const pendingDir = await mkdtemp(join(tmpdir(), `dsh-memory-${status}-`));
    tempDirs.push(pendingDir);
    process.env.OPENVIKING_PENDING_DIR = pendingDir;

    const runtime = new OpenVikingRuntime({
      async addMessage() {
        return { ok: false, status, error: { code: "FAILED" } };
      },
    }, config(), { debug() {} });
    const session = { id: `session-${status}`, header: { cwd: "/workspace" } };
    runtime.stateFor(session).ready = true;

    runtime.capture(session, userEvent(`Remember the ${status} behavior.`));
    await runtime.flush(session);

    assert.equal((await listPending()).length, expectedPending, `HTTP ${status}`);
  }
});

test("initialization queues capture only when the failure is retryable", async () => {
  for (const [status, expectedPending] of [[401, 0], [503, 1]]) {
    const pendingDir = await mkdtemp(join(tmpdir(), `dsh-memory-init-${status}-`));
    tempDirs.push(pendingDir);
    process.env.OPENVIKING_PENDING_DIR = pendingDir;

    const runtime = new OpenVikingRuntime({
      async healthResult() {
        return { ok: false, status, error: { code: "FAILED" } };
      },
    }, config(), { debug() {} });
    const session = { id: `init-${status}`, header: { cwd: "/workspace" } };

    runtime.capture(session, userEvent(`Remember the init ${status} behavior.`));
    await runtime.flush(session);

    assert.equal((await listPending()).length, expectedPending, `HTTP ${status}`);
  }
});

test("existing OpenViking sessions are reusable on DSH resume", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-resume-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;

  const runtime = new OpenVikingRuntime({
    async healthResult() {
      return { ok: true };
    },
    async ensureSessionResult() {
      return {
        ok: false,
        status: 409,
        error: { code: "ALREADY_EXISTS", message: "session exists" },
      };
    },
    async fetchJSON() {
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
  }, config(), { debug() {} });

  const state = await runtime.initialize({
    session: { id: "resume", header: { cwd: "/workspace" } },
  });

  assert.equal(state.ready, true);
  assert.equal(state.initializationRetryable, false);
});

test("a retryable threshold commit failure is queued", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-commit-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  const runtime = new OpenVikingRuntime({
    async getSession() {
      return { pending_tokens: 20000 };
    },
    async commitSession() {
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
  }, config(), { debug() {} });
  const session = { id: "commit-failure", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  runtime.maybeCommit(session, { type: "turn/end" });
  await runtime.flush(session);

  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "commitSession",
  ]);
});

test("compaction/start commits below the token threshold without reading session metadata", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-compaction-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  let getSessionCalls = 0;
  let commitCalls = 0;
  const runtime = new OpenVikingRuntime({
    async getSession() {
      getSessionCalls += 1;
      return { pending_tokens: 5 };
    },
    async commitSession() {
      commitCalls += 1;
      return { ok: true };
    },
  }, config(), { debug() {} });
  const session = { id: "compaction-commit", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  runtime.maybeCommit(session, { type: "compaction/start" });
  await runtime.flush(session);

  assert.equal(getSessionCalls, 0);
  assert.equal(commitCalls, 1);

  runtime.maybeCommit(session, { type: "compaction/end" });
  await runtime.flush(session);

  assert.equal(getSessionCalls, 0);
  assert.equal(commitCalls, 1);
});

test("once a write is queued, later messages and the final commit stay ordered on disk", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-order-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  let addCalls = 0;
  let commitCalls = 0;
  const runtime = new OpenVikingRuntime({
    async addMessage() {
      addCalls += 1;
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
    async commitSession() {
      commitCalls += 1;
      return { ok: true };
    },
  }, config(), { debug() {} });
  const session = { id: "ordered", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  runtime.capture(session, userEvent("First queued message."));
  runtime.capture(session, userEvent("Second queued message."));
  runtime.maybeCommit(session, { type: "turn/end" });
  await runtime.flush(session);
  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "addMessage",
    "addMessage",
  ]);
  await runtime.dispose(session);

  const pending = await listPending();
  assert.deepEqual(pending.map(item => item.entry.type), [
    "addMessage",
    "addMessage",
    "commitSession",
  ]);
  assert.deepEqual(
    pending.map(item => (
      item.entry.type === "commitSession"
        ? item.entry.payload
        : item.entry.payload.parts?.[0]?.text || item.entry.payload.content
    )),
    ["First queued message.", "Second queued message.", { keep_recent_count: 0 }],
  );
  assert.deepEqual(
    pending.map(item => item.entry.createdAt),
    [...pending.map(item => item.entry.createdAt)].sort((left, right) => left - right),
  );
  assert.equal(addCalls, 1);
  assert.equal(commitCalls, 0);
});

test("new queued messages move an older pending commit behind them", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-reorder-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  await enqueue("commitSession", "dsh-reorder", { keep_recent_count: 10 });
  const runtime = new OpenVikingRuntime({
    async healthResult() {
      return { ok: true };
    },
    async ensureSessionResult() {
      return { ok: true };
    },
    async fetchJSON() {
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
  }, config(), { debug() {} });
  const session = { id: "reorder", header: { cwd: "/workspace" } };

  runtime.capture(session, userEvent("Message after an offline commit."));
  await runtime.flush(session);
  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "addMessage",
  ]);

  await runtime.dispose(session);
  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "addMessage",
    "commitSession",
  ]);
});

test("flush waits only for the requested session", async () => {
  const runtime = new OpenVikingRuntime({}, config(), { debug() {} });
  const first = { id: "first", header: { cwd: "/workspace/first" } };
  const second = { id: "second", header: { cwd: "/workspace/second" } };
  let releaseSecond;
  runtime.stateFor(first).writes = Promise.resolve();
  runtime.stateFor(second).writes = new Promise(resolve => {
    releaseSecond = resolve;
  });

  await runtime.flush(first);
  releaseSecond();
  await runtime.flush(second);
});

test("dispose waits for the final commit before deleting session state", async () => {
  let releaseCommit;
  let commitOptions;
  const committed = new Promise(resolve => {
    releaseCommit = resolve;
  });
  const runtime = new OpenVikingRuntime({
    async commitSession(_sessionId, _peerId, options) {
      commitOptions = options;
      await committed;
      return { ok: true, result: { trace_id: "shutdown" } };
    },
  }, config(), { debug() {} });
  const session = { id: "dispose", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  let settled = false;
  const disposing = runtime.dispose(session).then(() => {
    settled = true;
  });
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(runtime.states.has(session.id), true);
  assert.deepEqual(commitOptions, { timeoutMs: 3000 });
  releaseCommit();
  await disposing;
  assert.equal(runtime.states.has(session.id), false);
});

test("persisted profile delivery survives dispose and re-seed", async () => {
  const runtime = new OpenVikingRuntime({
    async commitSession() {
      return { ok: true };
    },
  }, config(), { debug() {} });
  const session = {
    id: "profile-resume",
    header: { cwd: "/workspace" },
    events: [],
  };
  const firstState = runtime.stateFor(session);
  firstState.ready = true;
  firstState.profileBlock = "profile v1";

  const profile = await runtime.profileMessage({ session });
  assert.equal(profile?.source?.kind, OPENVIKING_PLUGIN_KIND);
  assert.equal(profile?.source?.form, "instructions");
  session.events.push({ type: "user/message", data: profile });
  await runtime.dispose(session);

  const resumedSession = {
    id: session.id,
    header: session.header,
    events: [...session.events],
  };
  const resumedState = runtime.stateFor(resumedSession);
  resumedState.ready = true;
  resumedState.profileBlock = "profile v2";
  assert.equal(await runtime.profileMessage({ session: resumedSession }), null);
  assert.equal(resumedState.profileDelivered, true);

  const pendingSession = {
    id: "profile-pending",
    header: { cwd: "/workspace" },
    events: [],
  };
  const pendingState = runtime.stateFor(pendingSession);
  pendingState.ready = true;
  pendingState.profileBlock = "pending profile";
  assert.equal(await runtime.profileMessage({
    session: pendingSession,
    inbox: { nextTurn: [], nextStep: [profile] },
  }), null);

  const otherSession = {
    id: "profile-other",
    header: { cwd: "/workspace", seedLength: 1 },
    events: [{ type: "user/message", data: profile }],
  };
  const otherState = runtime.stateFor(otherSession);
  otherState.ready = true;
  otherState.profileBlock = "other profile";
  assert.equal(
    (await runtime.profileMessage({ session: otherSession }))?.source?.form,
    "instructions",
  );
});

test("profile delivery uses current DSH session-owned history on resume and fork", async () => {
  const profile = {
    type: "user/message",
    data: {
      role: "user",
      content: [{ type: "text", text: "stored profile" }],
      source: { kind: "plugin", plugin: "openviking-memory", form: "instructions" },
    },
  };
  for (const [id, ownEvents, expected] of [
    ["resumed", [profile], null],
    ["forked", [], "instructions"],
    ["forked-resumed", [profile], null],
  ]) {
    const runtime = new OpenVikingRuntime({}, config(), { debug() {} });
    let historyReads = 0;
    const session = {
      id,
      header: { cwd: "/workspace", isSeeded: id !== "resumed" },
      ownEvents() {
        historyReads += 1;
        return ownEvents;
      },
    };
    const state = runtime.stateFor(session);
    state.ready = true;
    state.profileBlock = "current profile";

    const message = await runtime.profileMessage({ session });

    assert.equal(message?.source?.form ?? null, expected, id);
    assert.equal(historyReads, 1, id);
    assert.equal(state.profileDelivered, true, id);
    assert.equal(await runtime.profileMessage({ session }), null, id);
  }
});

test("disposeAll drains every live session", async () => {
  const committed = [];
  const runtime = new OpenVikingRuntime({
    async commitSession(sessionId) {
      committed.push(sessionId);
      return { ok: true };
    },
  }, config(), { debug() {} });
  for (const id of ["one", "two"]) {
    runtime.stateFor({ id, header: { cwd: `/workspace/${id}` } }).ready = true;
  }

  await runtime.disposeAll();

  assert.deepEqual(committed.sort(), ["dsh-one", "dsh-two"]);
  assert.equal(runtime.states.size, 0);
});

// dsh and pi had no recall switch at all: every other harness could turn recall
// off and these two retrieved on every prompt regardless.
test("autoRecall false stops the recall request", async () => {
  const runtime = new OpenVikingRuntime({
    async fetchJSON() {
      throw new Error("recall must not reach the server when it is switched off");
    },
  }, { ...config(), autoRecall: false }, { debug() {} });
  runtime.initialize = async () => ({ ready: true, config: { ...config(), autoRecall: false } });

  assert.equal(await runtime.recallMessage({}, [{ role: "user", content: "what did we decide" }]), null);
});

// A batch of injected context alone (time-context, job notices) carries no
// user query, so it must not trigger a recall request.
test("injected context alone does not trigger recall", async () => {
  const runtime = new OpenVikingRuntime({
    async fetchJSON() {
      throw new Error("recall must not run without user input");
    },
  }, { ...config(), minQueryLength: 0 }, { debug() {} });
  runtime.initialize = async () => ({ ready: true, config: { ...config(), minQueryLength: 0 } });

  assert.equal(await runtime.recallMessage({}, [{
    role: "user",
    content: [{ type: "text", text: "Current time: 2026-10-05 21:20" }],
    source: { kind: "time-context" },
  }]), null);
});

// recall-core reads options.excludeUris, but the DSH runtime built its options
// without it, so nothing a user configured could stop a subtree from being
// recalled: generated directory files came back as ordinary hits.
test("recallExcludeUris reaches the search request", async () => {
  const bodies = [];
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path, init) {
      if (/\/search\/search$/.test(path)) bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        result: {
          context: "<openviking-context>\nrecalled\n</openviking-context>",
          stats: {},
        },
      };
    },
  }, { ...config(), recallExcludeUris: ["viking://user/default/skills", "viking://agent/skills"] }, { debug() {} });
  runtime.initialize = async () => ({
    ready: true,
    config: { ...config(), recallExcludeUris: ["viking://user/default/skills", "viking://agent/skills"] },
  });

  await runtime.recallMessage({}, [{ role: "user", content: "what did we decide" }]);

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].exclude_uris, ["viking://user/default/skills", "viking://agent/skills"]);
});

test("recall sends no exclude_uris when recallExcludeUris is unset", async () => {
  const bodies = [];
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path, init) {
      if (/\/search\/search$/.test(path)) bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        result: { context: "<openviking-context>\nrecalled\n</openviking-context>", stats: {} },
      };
    },
  }, config(), { debug() {} });
  runtime.initialize = async () => ({ ready: true, config: config() });

  await runtime.recallMessage({}, [{ role: "user", content: "what did we decide" }]);

  assert.equal(bodies.length, 1);
  assert.equal("exclude_uris" in bodies[0], false);
});

test("syncTurns false sends nothing: no capture, no commit, no dispose flush, no replay", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-sync-off-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  await enqueue("addMessage", "dsh-earlier", { content: "queued while capture was on" });

  const writes = [];
  const traces = [];
  const runtime = new OpenVikingRuntime({
    async healthResult() {
      return { ok: true };
    },
    async ensureSessionResult() {
      return { ok: true };
    },
    async fetchJSON(path, init) {
      if (init?.method === "POST" && /\/(messages|commit)$/.test(path)) writes.push(path);
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
    async addMessage() {
      writes.push("addMessage");
      return { ok: true };
    },
    async getSession() {
      return { pending_tokens: 1000000 };
    },
    async commitSession() {
      writes.push("commitSession");
      return { ok: true };
    },
  }, { ...config(), syncTurns: false }, traceLogger(traces));
  const session = { id: "sync-off", header: { cwd: "/workspace" } };

  runtime.capture(session, userEvent("Never sent."));
  runtime.maybeCommit(session, { type: "turn/end" });
  // The recall path reaches initialization even when nothing is captured, and
  // the toggle takes the replay out of it without taking the reads with it.
  assert.equal((await runtime.initialize({ session })).ready, true);
  await runtime.flush(session);
  assert.equal(traces.at(-1).capture.status, "disabled");
  assert.equal(traces.at(-1).archive.status, "pending");
  assert.equal(traces.at(-1).extraction.status, "not_started");
  await runtime.dispose(session);

  assert.deepEqual(writes, []);
  const pending = await listPending();
  assert.deepEqual(pending.map(item => item.entry.sessionId), ["dsh-earlier"]);
  assert.ok(!pending[0].entry.retries);
});

test("the per-session peer honors peerSource", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "dsh-memory-peer-")));
  tempDirs.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(
    join(root, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:volcengine/OpenViking.git\n',
  );
  process.env.OPENVIKING_STATE_DIR = join(root, ".state");
  const session = { id: "peer", header: { cwd: root } };

  const byGit = new OpenVikingRuntime({}, {
    ...config(),
    workspacePeer: true,
  }, { debug() {} }).stateFor(session).config;
  const byCwd = new OpenVikingRuntime({}, {
    ...config(),
    workspacePeer: true,
    peerSource: "cwd",
  }, { debug() {} }).stateFor(session).config;

  assert.equal(byGit.peerId, "github.com-volcengine-openviking");
  assert.equal(byGit.legacyPeerId, deriveWorkspacePeerId(root));
  assert.equal(byCwd.peerId, deriveWorkspacePeerId(root));
});

function config() {
  return {
    explicitPeerId: "",
    workspacePeer: false,
    peerId: "",
    syncTurns: true,
    captureAssistantTurns: true,
    captureToolResults: false,
    captureToolMaxChars: 1000000,
    captureMaxLength: 24000,
    captureMode: "semantic",
    commitKeepRecentCount: 10,
  };
}

function userEvent(text) {
  return {
    type: "user/message",
    data: {
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    },
  };
}

test("runtime reports captured coverage, archive confirmation, and observed extraction separately", async () => {
  const archiveUri = "viking://~/memories/sessions/man351-archive";
  const memoryDiffUri = `${archiveUri}/memory_diff.json`;
  const taskStatuses = [];
  const traceUpdates = [];
  let taskReadCount = 0;
  const runtime = new OpenVikingRuntime({
    async addMessage() {
      return { ok: true };
    },
    async commitSession() {
      return {
        ok: true,
        result: { trace_id: "trace-synthetic", task_id: "task-synthetic", archive_uri: archiveUri },
      };
    },
    async fetchJSON(path) {
      if (path.startsWith("/api/v1/tasks/")) {
        taskReadCount += 1;
        const status = taskReadCount === 1 ? "running" : "completed";
        taskStatuses.push(status);
        return {
          ok: true,
          result: {
            task_id: "task-synthetic",
            task_type: "session_commit",
            resource_id: "dsh-man351-session",
            status,
            ...(status === "completed" ? {
              result: { archive_uri: archiveUri, memory_diff_uri: memoryDiffUri, memories_extracted: 1 },
            } : {}),
          },
        };
      }
      if (path.startsWith("/api/v1/content/read")) {
        return {
          ok: true,
          result: JSON.stringify({ operations: { adds: [{ uri: "viking://~/memories/events/man351.md" }], updates: [], deletes: [] } }),
        };
      }
      assert.fail(`unexpected OpenViking request: ${path}`);
    },
  }, { ...config(), peerId: "man351-synthetic-project", explicitPeerId: "man351-synthetic-project" }, {
    debug(message) {
      const prefix = "[openviking:dsh] segment_trace ";
      if (message.startsWith(prefix)) traceUpdates.push(JSON.parse(message.slice(prefix.length)));
    },
  });
  const session = { id: "man351-session", header: { cwd: "/synthetic/project" } };
  runtime.stateFor(session).ready = true;

  runtime.capture(session, { ...userEvent("MAN351_FACT_fixturealpha happened in the synthetic project."), id: "event-1" });
  runtime.maybeCommit(session, { id: "compaction-1", type: "compaction/start" });
  await runtime.flush(session);
  await waitUntil(() => traceUpdates.at(-1)?.extraction?.status === "completed_non_empty");

  const trace = traceUpdates.at(-1);
  assert.equal(trace.projectId, "man351-synthetic-project");
  assert.equal(trace.dshSessionId, session.id);
  assert.deepEqual(trace.coveredEventIds, ["event-1"]);
  assert.equal(trace.archive.status, "confirmed");
  assert.equal(trace.archive.uri, archiveUri);
  assert.equal(trace.extraction.status, "completed_non_empty");
  assert.deepEqual(trace.extraction.operations, { adds: 1, updates: 0, deletes: 0 });
  assert.ok(taskStatuses.includes("running"), "an accepted task ID is not a completed extraction");
  assert.ok(taskStatuses.includes("completed"));
});

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

test("runtime keeps below-threshold and handoff segments pending until session close", async () => {
  const traces = [];
  let commits = 0;
  const runtime = new OpenVikingRuntime({
    async addMessage() { return { ok: true }; },
    async getSession() { return { pending_tokens: 5 }; },
    async commitSession() {
      commits += 1;
      return { ok: true, result: { archive_uri: "viking://~/sessions/close-archive" } };
    },
  }, {
    ...config(),
    peerId: "man351-project",
    explicitPeerId: "man351-project",
    commitTokenThreshold: 100,
  }, traceLogger(traces));
  const session = { id: "threshold-session", header: { cwd: "/project" } };
  runtime.stateFor(session).ready = true;

  runtime.capture(session, { ...userEvent("A captured event below the threshold."), id: "event-threshold" });
  runtime.maybeCommit(session, { type: "turn/end" });
  await runtime.flush(session);

  const belowThreshold = traces.at(-1);
  assert.equal(belowThreshold.commitCheck.status, "not_reached");
  assert.equal(belowThreshold.archive.status, "pending");
  assert.equal(belowThreshold.extraction.status, "not_started");
  assert.equal(commits, 0);

  runtime.maybeCommit(session, { type: "session/handoff" });
  await runtime.flush(session);
  assert.equal(commits, 0, "a handoff event must not archive the mother session");

  await runtime.dispose(session);
  const closed = traces.at(-1);
  assert.equal(commits, 1);
  assert.equal(closed.trigger, "session_close");
  assert.equal(closed.archive.status, "confirmed");
  assert.equal(closed.extraction.status, "not_started");
});

test("runtime gives later captured events a separate segment and marks truncation", async () => {
  const traces = [];
  let commits = 0;
  const runtime = new OpenVikingRuntime({
    async addMessage() { return { ok: true }; },
    async commitSession() {
      commits += 1;
      return { ok: true, result: { archive_uri: `viking://~/sessions/segment-${commits}` } };
    },
  }, {
    ...config(),
    peerId: "man351-project",
    explicitPeerId: "man351-project",
    captureMaxLength: 32,
  }, traceLogger(traces));
  const session = { id: "multi-segment", header: { cwd: "/project" } };
  runtime.stateFor(session).ready = true;

  runtime.capture(session, { ...userEvent("This invented conversation event is deliberately much longer than the capture limit."), id: "event-long" });
  await runtime.flush(session);
  const firstObserved = traces.at(-1);
  assert.equal(firstObserved.coverageStatus, "truncated");
  assert.equal(firstObserved.eventCoverage[0].truncated, true);
  runtime.maybeCommit(session, { type: "compaction/start" });
  await runtime.flush(session);

  runtime.capture(session, { ...userEvent("A second independently captured segment."), id: "event-second" });
  await runtime.flush(session);
  runtime.maybeCommit(session, { type: "compaction/start" });
  await runtime.flush(session);

  const segmentTraces = traces.filter(item => item.archive.status === "confirmed");
  assert.equal(commits, 2);
  assert.deepEqual(segmentTraces.map(item => item.coveredEventIds), [["event-long"], ["event-second"]]);
  assert.notEqual(segmentTraces[0].segmentId, segmentTraces[1].segmentId);
});

test("runtime distinguishes disabled, failed, and completed-empty extraction", async () => {
  const scenarios = [
    ["disabled", {
      status: "completed",
      result: { memory_extraction: { enabled: false, skip_reason: "provider_disabled" } },
    }, null, "disabled"],
    ["failed", { status: "failed", error_code: "PROVIDER_UNAVAILABLE" }, null, "failed"],
    ["empty", {
      status: "completed",
      result: { memory_diff_uri: "viking://~/sessions/empty/memory_diff.json", memories_extracted: {} },
    }, { operations: { adds: [], updates: [], deletes: [] } }, "completed_empty"],
    ["unverified", { status: "completed", result: { memories_extracted: {} } }, null, "completed_unverified"],
    ["invalid-diff", {
      status: "completed",
      result: { memory_diff_uri: "viking://~/sessions/invalid/memory_diff.json" },
    }, "not-json", "completed_unverified"],
    ["partial-diff", {
      status: "completed",
      result: { memory_diff_uri: "viking://~/sessions/partial/memory_diff.json" },
    }, { operations: {} }, "completed_unverified"],
  ];

  for (const [name, task, diff, expectedStatus] of scenarios) {
    const traces = [];
    const runtime = new OpenVikingRuntime({
      async addMessage() { return { ok: true }; },
      async commitSession() {
        return { ok: true, result: { task_id: `task-${name}`, archive_uri: `viking://~/sessions/${name}` } };
      },
      async fetchJSON(path) {
        if (path.startsWith("/api/v1/tasks/")) return { ok: true, result: task };
        if (path.startsWith("/api/v1/content/read")) return { ok: true, result: JSON.stringify(diff) };
        assert.fail(`unexpected OpenViking request: ${path}`);
      },
    }, {
      ...config(),
      peerId: "man351-project",
      explicitPeerId: "man351-project",
    }, traceLogger(traces));
    const session = { id: `scenario-${name}`, header: { cwd: "/project" } };
    runtime.stateFor(session).ready = true;

    runtime.capture(session, { ...userEvent(`Scenario ${name} covers one synthetic event.`), id: `event-${name}` });
    runtime.maybeCommit(session, { type: "compaction/start" });
    await runtime.flush(session);
    await waitUntil(() => traces.at(-1)?.extraction?.status === expectedStatus);

    const trace = traces.at(-1);
    assert.equal(trace.extraction.status, expectedStatus, name);
    assert.equal(trace.archive.status, "confirmed", name);
    if (name === "empty") assert.deepEqual(trace.extraction.operations, { adds: 0, updates: 0, deletes: 0 });
  }
});

test("isolated capture without a project remains pending and sends nothing", async () => {
  const traces = [];
  let sends = 0;
  const runtime = new OpenVikingRuntime({
    async addMessage() { sends += 1; return { ok: true }; },
    async commitSession() { sends += 1; return { ok: true }; },
  }, {
    ...config(),
    peerId: "",
    explicitPeerId: "",
    memoryIsolation: { candidate: { account: "unattributed" } },
  }, traceLogger(traces));
  const session = { id: "unattributed-session", header: { cwd: "/unknown" } };
  runtime.stateFor(session).ready = true;

  runtime.capture(session, { ...userEvent("This event has no project attribution."), id: "event-unattributed" });
  runtime.maybeCommit(session, { type: "compaction/start" });
  await runtime.flush(session);

  const trace = traces.at(-1);
  assert.equal(sends, 0);
  assert.equal(trace.projectId, null);
  assert.equal(trace.capture.status, "pending_project");
  assert.equal(trace.pendingReason, "project_unassigned");
  assert.equal(trace.archive.status, "pending");
  assert.equal(trace.extraction.status, "not_started");
});

function traceLogger(traces) {
  return {
    debug(message) {
      const prefix = "[openviking:dsh] segment_trace ";
      if (message.startsWith(prefix)) traces.push(JSON.parse(message.slice(prefix.length)));
    },
  };
}
