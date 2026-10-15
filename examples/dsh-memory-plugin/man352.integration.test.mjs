import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { apply as applyOpenViking } from "./index.mjs";
import { OpenVikingClient } from "./client.mjs";

const SOURCE = "La conversación inventada confirma: el equipo revisa los cambios cada lunes.";
const NEGATED_SOURCE = "La conversación inventada aclara: no es cierto que el equipo revisa los cambios cada lunes.";
const CANDIDATE = "el equipo revisa los cambios cada lunes.";
const CANDIDATE_URI = "viking://~/memories/entities/man352-review-cadence.md";
const ARCHIVE_URI = "viking://~/sessions/man352-session/archive";
const DIFF_URI = "viking://~/sessions/man352-session/memory_diff.json";
const SECRET = ["sk_", "live_", "synthetic_test_value_12345"].join("");
const SECRET_SOURCE = `La conversación inventada contiene ${SECRET} para la prueba.`;
const SECRET_URI = "viking://~/memories/entities/man352-secret.md";
const SECRET_DIFF_URI = "viking://~/sessions/man352-secret-session/memory_diff.json";
const MISSING_ARCHIVE_URI = "viking://~/sessions/man352-missing-session/archive";
const PROJECT_ID = "synthetic-project";
const SESSION_ID = "synthetic-dsh-session";
const SEGMENT_ID = `${SESSION_ID}:1`;
const ROUTES = {
  candidate: { endpoint: "http://candidate.synthetic", apiKey: "candidate-key", account: PROJECT_ID, user: "candidate" },
  approved: { endpoint: "http://approved.synthetic", apiKey: "approved-key", account: PROJECT_ID, user: "approved" },
  history: { endpoint: "http://history.synthetic", apiKey: "history-key", account: PROJECT_ID, user: "history" },
};

const originalStateDir = process.env.OPENVIKING_STATE_DIR;
const originalPendingDir = process.env.OPENVIKING_PENDING_DIR;
const originalFetch = globalThis.fetch;

test("DSH prepara y abre una propuesta solo tras cotejar el evento con su archivo", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "man352-proposals-"));
  process.env.OPENVIKING_STATE_DIR = stateDir;
  process.env.OPENVIKING_PENDING_DIR = join(stateDir, "pending");
  const serverCalls = [];
  const archivedMessages = [];
  const approvedMemories = new Map();
  const taskPlans = new Map();
  const commitPlans = [
    { archiveUri: ARCHIVE_URI, diffUri: DIFF_URI, candidateUri: CANDIDATE_URI },
    { archiveUri: ARCHIVE_URI, diffUri: DIFF_URI, candidateUri: CANDIDATE_URI },
    { archiveUri: ARCHIVE_URI, diffUri: SECRET_DIFF_URI, candidateUri: SECRET_URI },
    { archiveUri: null, diffUri: DIFF_URI, candidateUri: CANDIDATE_URI },
    { archiveUri: MISSING_ARCHIVE_URI, diffUri: DIFF_URI, candidateUri: CANDIDATE_URI },
  ];
  let approvedPrevious = "";
  let missingArchiveMessage = "Archive path was not found.";
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const token = new Headers(init.headers).get("authorization") || "";
    const route = Object.entries(ROUTES).find(([, value]) => token === `Bearer ${value.apiKey}`)?.[0];
    assert.ok(route, `unexpected or unisolated credential: ${token}`);
    const method = init.method || "GET";
    const uri = parsed.searchParams.get("uri");
    serverCalls.push({ route, method, path: parsed.pathname, uri });

    if (parsed.pathname === "/health") return response({});
    if (parsed.pathname === "/api/v1/system/status") return response({ user: "synthetic-user" });
    if (parsed.pathname === "/api/v1/fs/ls") return response([]);
    if (parsed.pathname === "/api/v1/skills") return response({ skills: [] });
    if (parsed.pathname === "/api/v1/sessions" && method === "POST") return response({});
    if (/\/api\/v1\/sessions\/[^/]+\/messages$/.test(parsed.pathname) && method === "POST") {
      archivedMessages.push(JSON.parse(init.body));
      return response({});
    }
    if (/\/api\/v1\/sessions\/[^/]+\/commit$/.test(parsed.pathname) && method === "POST") {
      const plan = commitPlans[taskPlans.size];
      assert.ok(plan, "unexpected synthetic commit");
      const taskId = `task-man352-${taskPlans.size + 1}`;
      taskPlans.set(taskId, plan);
      return response({
        task_id: taskId,
        ...(plan.archiveUri ? { archive_uri: plan.archiveUri } : {}),
      });
    }
    if (/^\/api\/v1\/tasks\/task-man352-\d+$/u.test(parsed.pathname)) {
      const plan = taskPlans.get(parsed.pathname.split("/").at(-1));
      assert.ok(plan, `unexpected synthetic task ${parsed.pathname}`);
      return response({
        status: "completed",
        result: {
          ...(plan.archiveUri ? { archive_uri: plan.archiveUri } : {}),
          memory_diff_uri: plan.diffUri,
          memories_extracted: 1,
        },
      });
    }
    if (parsed.pathname === "/api/v1/content/read" && route === "candidate") {
      if (uri === `${ARCHIVE_URI}/messages.jsonl`) {
        return response(archivedMessages.map(value => JSON.stringify(value)).join("\n"));
      }
      if (uri === `${MISSING_ARCHIVE_URI}/messages.jsonl`) {
        return response({
          code: "NOT_FOUND",
          message: missingArchiveMessage,
          trace_id: "trace-missing-archive",
        }, 404);
      }
      if (uri === DIFF_URI) {
        return response(JSON.stringify({ operations: { adds: [{ uri: CANDIDATE_URI }], updates: [], deletes: [] } }));
      }
      if (uri === SECRET_DIFF_URI) {
        return response(JSON.stringify({ operations: { adds: [{ uri: SECRET_URI }], updates: [], deletes: [] } }));
      }
      if (uri === CANDIDATE_URI) return response(CANDIDATE);
      if (uri === SECRET_URI) return response(SECRET);
    }
    if (parsed.pathname === "/api/v1/content/read" && route === "approved") {
      if (uri === CANDIDATE_URI && approvedPrevious) return response(approvedPrevious);
      return response({ code: "NOT_FOUND" }, 404);
    }
    if (parsed.pathname === "/api/v1/content/write" && route === "approved" && method === "POST") {
      const body = JSON.parse(init.body);
      approvedMemories.set(body.uri, body.content);
      return response({});
    }
    if (parsed.pathname === "/api/v1/search/search" && route === "approved") {
      const query = String(JSON.parse(init.body).query || "").toLowerCase();
      const items = [...approvedMemories.entries()]
        .filter(([, content]) => String(content).toLowerCase().includes(query))
        .map(([memoryUri, content]) => ({ uri: memoryUri, content }));
      return response({ items });
    }
    return response({ code: "UNEXPECTED_FIXTURE_REQUEST" }, 500);
  };

  const ctx = new Context();
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber;
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: "native" });
  await toolsFiber;
  const fixture = composePlugin(ctx, {
    endpoint: ROUTES.candidate.endpoint,
    workspacePeer: false,
    peerId: PROJECT_ID,
    requestTimeoutMs: 10000,
    memoryIsolation: ROUTES,
  });

  try {
    const names = new Set(ctx.tools.schemas().map(tool => tool.name));
    assert.ok(names.has("openviking_review_proposal"), "the real DSH plugin must expose its review tool");

    const session = { id: SESSION_ID, header: { cwd: "/synthetic/project" }, events: [] };
    const agent = {
      status: "idle",
      session,
      inject() {},
      ctx: { effect() {} },
    };
    await fixture.handlers.get("agent/created")({ agent, source: "startup", signal: new AbortController().signal });

    const userEvent = {
      id: "synthetic-event-1",
      type: "user/message",
      time: Date.now(),
      data: { role: "user", content: [{ type: "text", text: SOURCE }], source: { kind: "user" } },
    };
    session.events.push(userEvent);
    fixture.handlers.get("session/event")(session, userEvent);
    await fixture.handlers.get("session/flush")(session);

    const compaction = { id: "synthetic-compaction-1", type: "compaction/start", data: {} };
    session.events.push(compaction);
    fixture.handlers.get("session/event")(session, compaction);
    await fixture.handlers.get("session/flush")(session);
    await waitUntil(async () => {
      const result = await callTool(ctx, "openviking_review_proposal", {});
      return result.value?.segments?.[0]?.extractionStatus === "completed_non_empty";
    });

    const listed = await callTool(ctx, "openviking_review_proposal", {});
    assert.equal(listed.isError, false, JSON.stringify(listed.error));
    assert.equal(listed.value.segments.length, 1);
    assert.equal(listed.value.segments[0].segment, SEGMENT_ID);
    assert.equal(listed.value.segments[0].archiveStatus, "confirmed");
    assert.equal(listed.value.segments[0].extractionStatus, "completed_non_empty");

    const unavailableFilterHooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "./known-secret-filter.mjs" && context.parentURL?.endsWith("/proposal-tools.mjs")) {
          throw new Error("Synthetic filter unavailable.");
        }
        return nextResolve(specifier, context);
      },
    });
    let withoutFilter;
    try {
      withoutFilter = await callTool(ctx, "openviking_review_proposal", { segmentId: SEGMENT_ID });
    } finally {
      unavailableFilterHooks.deregister();
    }
    assert.equal(withoutFilter.value.status, "pending");
    assert.equal(withoutFilter.value.pendingReason, "secret_filter_unavailable");

    const prepared = await callTool(ctx, "openviking_review_proposal", { segmentId: SEGMENT_ID });
    assert.equal(prepared.isError, false, JSON.stringify(prepared.error));
    assert.equal(prepared.value.status, "reviewable", JSON.stringify(prepared.value));
    assert.equal(prepared.value.project, PROJECT_ID);
    assert.equal(prepared.value.session, SESSION_ID);
    assert.equal(prepared.value.segment, SEGMENT_ID);
    assert.equal(prepared.value.assertion, CANDIDATE);
    assert.equal(prepared.value.originalPassage, SOURCE);
    assert.deepEqual(prepared.value.coverage.eventIds, [userEvent.id]);
    assert.equal(prepared.value.approvedPrevious.status, "none");
    assert.equal(prepared.value.proposedText, CANDIDATE);
    assert.ok(prepared.value.reasonSuggested);
    assert.ok(prepared.value.effect);
    assert.match(prepared.value.filterNote, /no detecta todo|no detecta todos/i);

    const opened = await callTool(ctx, "openviking_review_proposal", { proposalId: prepared.value.id });
    assert.equal(opened.isError, false, JSON.stringify(opened.error));
    assert.equal(opened.value.id, prepared.value.id);
    assert.equal(opened.value.originalPassage, SOURCE);
    const agentOutput = opened.content.map(part => part.text || "").join("\n");
    for (const visible of [PROJECT_ID, SESSION_ID, SEGMENT_ID, CANDIDATE, SOURCE]) {
      assert.ok(agentOutput.includes(visible), `the agent output must show ${visible}`);
    }
    for (const label of [
      /afirmación/i,
      /pasaje original comprobado/i,
      /cobertura/i,
      /aprobado anterior/i,
      /texto propuesto/i,
      /motivo sugerido/i,
      /efecto previsto/i,
    ]) assert.match(agentOutput, label);
    const presenter = ctx.tools.get("openviking_review_proposal");
    const view = presenter.presentResult(
      { proposalId: prepared.value.id },
      { content: opened.content, isError: false, meta: opened.meta },
    );
    assert.equal(view.card, "generic");
    assert.match(view.title, /propuesta/i);
    assert.match(view.content, /lunes/);
    for (const visible of [PROJECT_ID, SESSION_ID, SEGMENT_ID, CANDIDATE, SOURCE]) {
      assert.ok(view.content.includes(visible), `the review view must show ${visible}`);
    }
    for (const label of [
      /afirmación/i,
      /pasaje original comprobado/i,
      /cobertura/i,
      /aprobado anterior/i,
      /texto propuesto/i,
      /motivo sugerido/i,
      /efecto previsto/i,
    ]) assert.match(view.content, label);

    const approvedClient = new OpenVikingClient({ ...ROUTES.approved, requestTimeoutMs: 10000 });
    const search = await approvedClient.fetchJSON("/api/v1/search/search", {
      method: "POST",
      body: JSON.stringify({ query: CANDIDATE }),
    });
    assert.deepEqual(search.result.items, []);
    assert.equal(approvedMemories.has(CANDIDATE_URI), false);
    assert.equal(serverCalls.some(call => call.method === "POST" && call.path === "/api/v1/content/write"), false);
    assert.ok(serverCalls.some(call => call.route === "candidate" && call.uri === `${ARCHIVE_URI}/messages.jsonl`));
    assert.ok(serverCalls.some(call => call.route === "approved" && call.uri === CANDIDATE_URI));

    const crossProject = await callTool(ctx, "openviking_review_proposal", {
      segmentId: SEGMENT_ID,
      targetProjects: [PROJECT_ID, "unverified-project"],
    });
    assert.equal(crossProject.value.status, "question");
    assert.equal(crossProject.value.pendingReason, "project_scope_unverified");
    assert.equal(crossProject.value.proposedText, "");
    assert.match(crossProject.value.question, /\?/u);
    assert.match(crossProject.value.filterNote, /El filtro busca/i);
    assert.doesNotMatch(crossProject.value.filterNote, /Se comprobaron/i);

    approvedPrevious = "El equipo revisa los cambios cada martes.";
    const contradiction = await callTool(ctx, "openviking_review_proposal", { segmentId: SEGMENT_ID });
    assert.equal(contradiction.value.status, "question");
    assert.equal(contradiction.value.pendingReason, "possible_approved_contradiction");
    assert.equal(contradiction.value.approvedPrevious.status, "found");
    assert.equal(contradiction.value.approvedPrevious.text, approvedPrevious);
    assert.equal(contradiction.value.originalPassage, SOURCE);
    assert.equal(contradiction.value.proposedText, "");
    assert.match(contradiction.value.question, /¿.*\?/u);
    const contradictionView = presenter.presentResult(
      { segmentId: SEGMENT_ID },
      { content: contradiction.content, isError: false, meta: contradiction.meta },
    );
    assert.match(contradictionView.title, /pregunta/i);
    assert.match(contradictionView.content, /martes/);
    approvedPrevious = "";

    const negatedEvent = {
      id: "synthetic-event-2",
      type: "user/message",
      time: Date.now(),
      data: { role: "user", content: [{ type: "text", text: NEGATED_SOURCE }], source: { kind: "user" } },
    };
    session.events.push(negatedEvent);
    fixture.handlers.get("session/event")(session, negatedEvent);
    await fixture.handlers.get("session/flush")(session);
    const secondCompaction = { id: "synthetic-compaction-2", type: "compaction/start", data: {} };
    session.events.push(secondCompaction);
    fixture.handlers.get("session/event")(session, secondCompaction);
    await fixture.handlers.get("session/flush")(session);
    const secondSegmentId = `${SESSION_ID}:2`;
    await waitUntil(async () => {
      const result = await callTool(ctx, "openviking_review_proposal", {});
      return result.value?.segments?.some(segment => (
        segment.segment === secondSegmentId && segment.extractionStatus === "completed_non_empty"
      ));
    });
    const negated = await callTool(ctx, "openviking_review_proposal", { segmentId: secondSegmentId });
    assert.equal(negated.value.status, "pending");
    assert.equal(negated.value.pendingReason, "original_passage_not_verified");
    assert.equal(negated.value.originalPassage, "");

    const secretSession = { id: "synthetic-dsh-secret-session", header: { cwd: "/synthetic/project" }, events: [] };
    const secretAgent = { status: "idle", session: secretSession, inject() {}, ctx: { effect() {} } };
    await fixture.handlers.get("agent/created")({
      agent: secretAgent,
      source: "startup",
      signal: new AbortController().signal,
    });
    const secretEvent = {
      id: "synthetic-secret-event",
      type: "user/message",
      time: Date.now(),
      data: { role: "user", content: [{ type: "text", text: SECRET_SOURCE }], source: { kind: "user" } },
    };
    secretSession.events.push(secretEvent);
    fixture.handlers.get("session/event")(secretSession, secretEvent);
    await fixture.handlers.get("session/flush")(secretSession);
    const secretCompaction = { id: "synthetic-secret-compaction", type: "compaction/start", data: {} };
    secretSession.events.push(secretCompaction);
    fixture.handlers.get("session/event")(secretSession, secretCompaction);
    await fixture.handlers.get("session/flush")(secretSession);
    const secretSegmentId = `${secretSession.id}:1`;
    await waitUntil(async () => {
      const result = await callTool(ctx, "openviking_review_proposal", {});
      return result.value?.segments?.some(segment => (
        segment.segment === secretSegmentId && segment.extractionStatus === "completed_non_empty"
      ));
    });
    const secretProposal = await callTool(ctx, "openviking_review_proposal", { segmentId: secretSegmentId });
    assert.equal(secretProposal.value.status, "pending");
    assert.equal(secretProposal.value.pendingReason, "known_secret_format_detected");
    assert.equal(JSON.stringify(secretProposal.value).includes(SECRET), false);

    const stillAvailable = await callTool(ctx, "openviking_review_proposal", { segmentId: SEGMENT_ID });
    assert.equal(stillAvailable.value.status, "reviewable");
    assert.equal(stillAvailable.value.originalPassage, SOURCE);

    const unlinkedEvent = {
      id: "synthetic-unlinked-event",
      type: "user/message",
      time: Date.now(),
      data: { role: "user", content: [{ type: "text", text: "Unlinked archive source for synthetic verification." }], source: { kind: "user" } },
    };
    secretSession.events.push(unlinkedEvent);
    fixture.handlers.get("session/event")(secretSession, unlinkedEvent);
    await fixture.handlers.get("session/flush")(secretSession);
    const unlinkedCompaction = { id: "synthetic-unlinked-compaction", type: "compaction/start", data: {} };
    secretSession.events.push(unlinkedCompaction);
    fixture.handlers.get("session/event")(secretSession, unlinkedCompaction);
    await fixture.handlers.get("session/flush")(secretSession);
    const unlinkedSegmentId = `${secretSession.id}:2`;
    await waitUntil(async () => {
      const result = await callTool(ctx, "openviking_review_proposal", {});
      return result.value?.segments?.some(segment => (
        segment.segment === unlinkedSegmentId && segment.extractionStatus === "completed_non_empty"
      ));
    });
    const unlinked = await callTool(ctx, "openviking_review_proposal", { segmentId: unlinkedSegmentId });
    assert.equal(unlinked.value.status, "pending");
    assert.equal(unlinked.value.pendingReason, "original_archive_not_confirmed");
    assert.equal(unlinked.value.originalPassage, "");

    const missingEvent = {
      id: "synthetic-missing-archive-event",
      type: "user/message",
      time: Date.now(),
      data: { role: "user", content: [{ type: "text", text: "Missing archive source for synthetic verification." }], source: { kind: "user" } },
    };
    secretSession.events.push(missingEvent);
    fixture.handlers.get("session/event")(secretSession, missingEvent);
    await fixture.handlers.get("session/flush")(secretSession);
    const missingCompaction = { id: "synthetic-missing-archive-compaction", type: "compaction/start", data: {} };
    secretSession.events.push(missingCompaction);
    fixture.handlers.get("session/event")(secretSession, missingCompaction);
    await fixture.handlers.get("session/flush")(secretSession);
    const missingSegmentId = `${secretSession.id}:3`;
    await waitUntil(async () => {
      const result = await callTool(ctx, "openviking_review_proposal", {});
      return result.value?.segments?.some(segment => (
        segment.segment === missingSegmentId && segment.extractionStatus === "completed_non_empty"
      ));
    });
    const missing = await callTool(ctx, "openviking_review_proposal", { segmentId: missingSegmentId });
    assert.equal(missing.value.status, "pending");
    assert.equal(missing.value.pendingReason, "original_unavailable");
    assert.deepEqual(missing.value.failure, {
      source: "original_archive",
      status: 404,
      code: "NOT_FOUND",
      message: "Archive path was not found.",
      traceId: "trace-missing-archive",
    });
    assert.equal(missing.value.originalPassage, "");
    const missingView = presenter.presentResult(
      { segmentId: missingSegmentId },
      { content: missing.content, isError: false, meta: missing.meta },
    );
    assert.match(missingView.content, /HTTP 404.*NOT_FOUND/);
    assert.match(missingView.content, /Archive path was not found\./);

    missingArchiveMessage = `Archive path was not found. ${SECRET}`;
    const redactedError = await callTool(ctx, "openviking_review_proposal", { segmentId: missingSegmentId });
    assert.equal(redactedError.value.status, "pending");
    assert.equal(redactedError.value.failure.message, undefined);
    assert.equal(JSON.stringify(redactedError.value).includes(SECRET), false);
  } finally {
    for (const dispose of fixture.cleanups.reverse()) await dispose();
    await toolsFiber.dispose();
    await promptFiber.dispose();
    globalThis.fetch = originalFetch;
    if (originalStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
    else process.env.OPENVIKING_STATE_DIR = originalStateDir;
    if (originalPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR;
    else process.env.OPENVIKING_PENDING_DIR = originalPendingDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function composePlugin(dshContext, config) {
  const handlers = new Map();
  const cleanups = [];
  const provided = new Map();
  const pluginContext = {
    logger: { debug() {} },
    tools: dshContext.tools,
    provide(name, value) { provided.set(name, value); },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") cleanups.push(dispose);
      return async () => {};
    },
    on(name, handler) { handlers.set(name, handler); },
    plugin() { return { dispose: async () => {} }; },
  };
  applyOpenViking(pluginContext, config);
  return { handlers, cleanups, runtime: provided.get("openvikingMemory") };
}

async function callTool(ctx, name, args) {
  return ctx.tools.execute({
    callId: `man352-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  });
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

function response(result, status = 200) {
  const body = status < 400
    ? { status: "ok", result }
    : { status: "error", error: result };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
