import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import { createFakeOpenViking } from "./fake-openviking.mjs";
import { mountProposalTools } from "./proposal-tools.mjs";

const PROJECT = "man354-synthetic-project";
const APPROVED_PREFIX = `viking://resources/${PROJECT}/approved/memories/`;
const HISTORY_PREFIX = `viking://resources/${PROJECT}/history/memories/`;
const LABEL = "Sergi (etiqueta configurada)";

const originalStateDir = process.env.OPENVIKING_STATE_DIR;
const originalPendingDir = process.env.OPENVIKING_PENDING_DIR;

/** A project with a fake server, a segment catalogue and the DSH tool runtime mounted. */
async function createWorld() {
  const stateDir = mkdtempSync(join(tmpdir(), "man354-changes-"));
  process.env.OPENVIKING_STATE_DIR = stateDir;
  process.env.OPENVIKING_PENDING_DIR = join(stateDir, "pending");
  const server = createFakeOpenViking();
  const segments = [];
  const approvals = [];
  let approvalOutcome = "allowed-once";
  const runtime = {
    async listProposalSegments() { return segments; },
    async findProposalSegment(id) { return segments.find(item => item.segmentId === id) || null; },
  };

  const ctx = new Context();
  const fibers = [
    ctx.plugin(SystemPrompt, { includeHarnessIdentity: false }),
    ctx.plugin(ToolRuntime, { mode: "native" }),
    ctx.plugin(ApprovalService, { policy: "ask" }),
  ];
  await Promise.all(fibers);
  const mounted = ctx.plugin({
    name: "man354-changes-test",
    inject: ["tools", "approval"],
    apply(pluginCtx) {
      mountProposalTools(pluginCtx, {
        runtime,
        candidateClient: server.candidate,
        approvedClient: server.approved,
        publisherClient: server.publisher,
        historyClient: server.history,
        approvalAuthorLabel: LABEL,
      });
    },
  });
  await mounted;
  ctx.on("approval/request", request => {
    approvals.push(request);
    return approvalOutcome;
  });
  const session = {
    events: [{ type: "turn/start", data: {} }],
    append(type, data) { this.events.push({ type, data }); },
  };

  let counter = 0;
  const world = {
    server,
    approvals,
    setApproval(outcome) { approvalOutcome = outcome; },
    /** A new invented conversation whose extraction produced one candidate memory. */
    addConversation(sentence, { name = `fact-${counter + 1}`, quote = sentence } = {}) {
      counter += 1;
      const segmentId = `session-${counter}:1`;
      const archiveUri = `viking://~/sessions/session-${counter}/archive`;
      const diffUri = `viking://~/sessions/session-${counter}/memory_diff.json`;
      const candidateUri = `viking://user/candidate/peers/${PROJECT}/memories/entities/${name}.md`;
      const candidateText = ["# Summary", sentence, "", "# ChatLog", `User: ${quote}`].join("\n");
      server.candidateFiles.set(`${archiveUri}/messages.jsonl`, `${JSON.stringify({ parts: [{ type: "text", text: quote }] })}\n`);
      server.candidateFiles.set(diffUri, JSON.stringify({ operations: { adds: [{ uri: candidateUri }], updates: [], deletes: [] } }));
      server.candidateFiles.set(candidateUri, candidateText);
      segments.push({
        projectId: PROJECT,
        dshSessionId: `session-${counter}`,
        openVikingSessionId: `dsh-session-${counter}`,
        segmentId,
        archive: { status: "confirmed", uri: archiveUri },
        extraction: { status: "completed_non_empty", memoryDiffUri: diffUri },
        capture: { status: "captured" },
        coverageStatus: "complete",
        coveredEventIds: [`event-${counter}`],
        eventCoverage: [{
          eventId: `event-${counter}`,
          eventType: "user/message",
          captureStatus: "captured",
          truncated: false,
          sourceTextHash: createHash("sha256").update(quote).digest("hex"),
        }],
      });
      return { segmentId, candidateUri, candidateText, approvedUri: `${APPROVED_PREFIX}entities/${name}.md`, sentence };
    },
    async call(name, args) {
      const result = await ctx.tools.execute({
        callId: `man354-${name}-${Math.random()}`,
        name,
        arguments: args,
        agent: { session },
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, false, JSON.stringify(result.error));
      return result.value;
    },
    prepare(conversation, change) {
      return world.call("openviking_review_proposal", { segmentId: conversation.segmentId, ...(change || {}) });
    },
    decide(proposalId, action, reason) {
      return world.call("openviking_decide_proposal", { proposalId, action, ...(reason ? { reason } : {}) });
    },
    /** Approve one alta end to end and return its published URI. */
    async approveAlta(conversation, reason = "Keep this invented fact.") {
      const proposal = await world.prepare(conversation);
      assert.equal(proposal.status, "reviewable", JSON.stringify(proposal));
      const decision = await world.decide(proposal.id, "approve", reason);
      assert.equal(decision.status, "published", JSON.stringify(decision));
      return { proposal, uri: decision.uri };
    },
    approvedText(uri) {
      return server.resources.get(uri)?.content;
    },
    async dispose() {
      await mounted.dispose();
      for (const fiber of fibers) await fiber.dispose();
      if (originalStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
      else process.env.OPENVIKING_STATE_DIR = originalStateDir;
      if (originalPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR;
      else process.env.OPENVIKING_PENDING_DIR = originalPendingDir;
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
  return world;
}

async function withWorld(body) {
  const world = await createWorld();
  try {
    await body(world);
  } finally {
    await world.dispose();
  }
}

function historyEntries(world) {
  return [...world.server.resources.keys()].filter(uri => uri.startsWith(HISTORY_PREFIX));
}

function parseRecord(content, marker = "openviking-approval:v1") {
  const prefix = `<!-- ${marker}\n`;
  assert.ok(content.startsWith(prefix), `content must begin with ${marker}`);
  const end = content.indexOf("\n-->", prefix.length);
  return JSON.parse(content.slice(prefix.length, end));
}

const BASE_FACT = "Invented rule: MAN354_BASE_a1 ships on Mondays.";
const EXTRA_FACT = "Invented rule: MAN354_EXTRA_b2 also needs a signed note.";
const NEW_FACT = "Invented rule: MAN354_NEW_c3 ships on Fridays instead.";

test("an approved extension keeps one self-sufficient current memory and the complete previous version", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base, "Base rule confirmed by Sergi.");
  const baseContent = world.approvedText(uri);
  const later = world.addConversation(EXTRA_FACT, { name: "shipping-extra" });

  const proposal = await world.prepare(later, { changeKind: "extend", targetUri: uri });
  assert.equal(proposal.status, "reviewable", JSON.stringify(proposal));
  assert.equal(proposal.change.kind, "extend");
  assert.equal(proposal.change.targetUri, uri);
  assert.equal(proposal.originalPassage, EXTRA_FACT);
  assert.ok(proposal.approvedPrevious.text.includes(BASE_FACT), "the view shows the before text");
  assert.ok(proposal.proposedText.includes(BASE_FACT) && proposal.proposedText.includes(EXTRA_FACT), "the after text is self-sufficient");
  assert.equal(world.approvedText(uri), baseContent, "preparing must not change the current memory");
  assert.equal(historyEntries(world).length, 0);

  const before = world.approvals.length;
  const decision = await world.decide(proposal.id, "approve", "The signed note is part of the same rule.");
  assert.equal(decision.status, "published", JSON.stringify(decision));
  assert.equal(world.approvals.length, before + 1, "exactly one human confirmation");
  const current = world.approvedText(uri);
  const record = parseRecord(current);
  assert.equal(record.proposalId, proposal.id);
  assert.equal(record.reason, "The signed note is part of the same rule.");
  assert.equal(record.change.kind, "extend");
  assert.equal(record.change.version, 2);
  assert.equal(record.change.previous.version, 1);
  assert.equal(record.source.segment, later.segmentId);
  assert.ok(current.includes(BASE_FACT) && current.includes(EXTRA_FACT));

  const entries = historyEntries(world);
  assert.equal(entries.length, 1);
  assert.equal(record.change.previous.historyUri, entries[0]);
  const history = world.approvedText(entries[0]);
  assert.ok(history.endsWith(baseContent), "the previous version is preserved whole");
  const historyRecord = parseRecord(history, "openviking-history:v1");
  assert.equal(historyRecord.decision.proposalId, proposal.id);
  assert.equal(historyRecord.decision.reason, "The signed note is part of the same rule.");
  assert.equal(historyRecord.decision.kind, "extend");
  assert.equal(historyRecord.decision.supersededByVersion, 2);
  assert.equal((await world.server.history.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(entries[0])}`)).ok, true);
  const denied = await world.server.approved.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(entries[0])}`);
  assert.equal(denied.status, 403, "normal reading cannot open history");
  assert.deepEqual(world.server.normalReadable().map(item => item.uri), [uri], "normal reading sees only the current memory");
}));

test("an approved substitution replaces the current text and keeps the replaced one", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const baseContent = world.approvedText(uri);
  const later = world.addConversation(NEW_FACT, { name: "shipping-new" });
  const proposal = await world.prepare(later, { changeKind: "replace", targetUri: uri });
  assert.equal(proposal.status, "reviewable", JSON.stringify(proposal));
  const decision = await world.decide(proposal.id, "approve", "Fridays replaced Mondays.");
  assert.equal(decision.status, "published", JSON.stringify(decision));
  const current = world.approvedText(uri);
  assert.ok(current.includes(NEW_FACT));
  assert.equal(current.includes("MAN354_BASE_a1"), false, "the replaced text is no longer current");
  assert.equal(parseRecord(current).change.kind, "replace");
  assert.ok(world.approvedText(historyEntries(world)[0]).endsWith(baseContent));
}));

test("an approved retirement leaves normal reading and stays in deliberate history with its reason", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base, "Original reason for keeping it.");
  const baseContent = world.approvedText(uri);
  const later = world.addConversation("Invented rule: MAN354_BASE_a1 no longer applies.", { name: "shipping-retired" });
  const proposal = await world.prepare(later, { changeKind: "retire", targetUri: uri });
  assert.equal(proposal.status, "reviewable", JSON.stringify(proposal));
  assert.equal(proposal.proposedText, "");
  assert.ok(proposal.approvedPrevious.text.includes(BASE_FACT));
  assert.ok(world.approvedText(uri), "nothing is retired before the decision");

  const decision = await world.decide(proposal.id, "approve", "The rule was dropped on purpose.");
  assert.equal(decision.status, "published", JSON.stringify(decision));
  assert.equal(world.approvedText(uri), undefined, "normal reading no longer has it");
  assert.deepEqual(world.server.normalReadable(), []);
  const entries = historyEntries(world);
  assert.equal(entries.length, 1);
  const history = world.approvedText(entries[0]);
  assert.ok(history.endsWith(baseContent));
  const record = parseRecord(history, "openviking-history:v1");
  assert.equal(record.decision.kind, "retire");
  assert.equal(record.decision.reason, "The rule was dropped on purpose.");
  assert.equal(record.decision.supersededByVersion, null);
  assert.equal(record.decision.source.segment, later.segmentId);
}));

test("without an approval nothing changes", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const baseContent = world.approvedText(uri);
  world.server.clearCalls();
  for (const kind of ["extend", "replace", "retire"]) {
    const later = world.addConversation(`Invented rule: MAN354_${kind}_d4 changes things.`, { name: `later-${kind}` });
    const proposal = await world.prepare(later, { changeKind: kind, targetUri: uri });
    assert.equal(proposal.status, "reviewable", JSON.stringify(proposal));
    for (const outcome of ["rejected", "unavailable"]) {
      world.setApproval(outcome);
      const result = await world.decide(proposal.id, "approve", "Not confirmed.");
      assert.match(result.status, /^approval_/u);
    }
    world.setApproval("allowed-once");
    assert.equal((await world.decide(proposal.id, "defer")).status, "deferred_not_published");
    assert.equal((await world.decide(proposal.id, "discard")).status, "discarded");
  }
  assert.equal(world.approvedText(uri), baseContent);
  assert.equal(historyEntries(world).length, 0);
  assert.equal(world.server.callsBy("publisher-admin", "POST").length, 0);
  assert.equal(world.server.callsBy("publisher-admin", "DELETE").length, 0);
}));

test("a base version that changed since preparation asks for a new review and publishes nothing", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const first = world.addConversation(EXTRA_FACT, { name: "first-change" });
  const second = world.addConversation(NEW_FACT, { name: "second-change" });
  const firstProposal = await world.prepare(first, { changeKind: "extend", targetUri: uri });
  const secondProposal = await world.prepare(second, { changeKind: "replace", targetUri: uri });
  assert.equal((await world.decide(secondProposal.id, "approve", "Replace first.")).status, "published");
  const afterSecond = world.approvedText(uri);
  const approvalsBefore = world.approvals.length;
  const stale = await world.decide(firstProposal.id, "approve", "Extend the older base.");
  assert.equal(stale.status, "base_version_changed");
  assert.equal(world.approvals.length, approvalsBefore, "no confirmation is requested for a stale proposal");
  assert.equal(world.approvedText(uri), afterSecond, "the newer version is not overwritten");
  assert.equal(historyEntries(world).length, 1);
  const reopened = await world.call("openviking_review_proposal", { proposalId: firstProposal.id });
  assert.equal(reopened.status, "needs_new_review");
  assert.equal(reopened.pendingReason, "base_version_changed");
}));

test("an uncertain contradiction stays a question and never replaces or retires", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const baseContent = world.approvedText(uri);
  const contradiction = world.addConversation("Invented rule: MAN354_BASE_a1 ships on Tuesdays.", { name: "shipping" });
  const question = await world.prepare(contradiction);
  assert.equal(question.status, "question");
  assert.equal(question.pendingReason, "possible_approved_contradiction");
  const result = await world.decide(question.id, "approve", "Try to force it.");
  assert.notEqual(result.status, "published");
  assert.equal(world.approvedText(uri), baseContent);
  assert.equal(historyEntries(world).length, 0);
  assert.equal(world.server.callsBy("publisher-admin", "POST").length, 1, "only the original alta was ever written");
}));

test("a change needs an approved target of this project and a complete request", () => withWorld(async world => {
  const later = world.addConversation(EXTRA_FACT, { name: "orphan-extra" });
  const missing = await world.prepare(later, { changeKind: "extend", targetUri: `${APPROVED_PREFIX}entities/not-approved.md` });
  assert.equal(missing.status, "pending");
  assert.equal(missing.pendingReason, "change_target_not_approved");
  const foreign = await world.prepare(later, { changeKind: "extend", targetUri: "viking://resources/other-project/approved/memories/entities/x.md" });
  assert.equal(foreign.pendingReason, "change_target_invalid");
  const traversal = await world.prepare(later, { changeKind: "retire", targetUri: `${APPROVED_PREFIX}../secret.md` });
  assert.equal(traversal.pendingReason, "change_target_invalid");
  const incomplete = await world.prepare(later, { changeKind: "replace" });
  assert.equal(incomplete.pendingReason, "change_target_required");
}));

test("pending duplicates gather sources, an approved repeat is not rewritten and a discard does not return with the same proof", () => withWorld(async world => {
  const first = world.addConversation(BASE_FACT, { name: "dup-a" });
  const second = world.addConversation(BASE_FACT, { name: "dup-b", quote: `Another chat says: ${BASE_FACT}` });
  const proposal = await world.prepare(first);
  const merged = await world.prepare(second);
  assert.equal(merged.id, proposal.id, "the same pending idea is one proposal");
  assert.deepEqual(merged.sources.map(source => source.segment), [first.segmentId, second.segmentId]);
  const reopened = await world.call("openviking_review_proposal", { proposalId: proposal.id });
  assert.equal(reopened.sources.length, 2);

  const decision = await world.decide(proposal.id, "approve", "Both chats agree.");
  assert.equal(decision.status, "published");
  const record = parseRecord(world.approvedText(decision.uri));
  assert.deepEqual(record.sources.map(source => source.segment), [first.segmentId, second.segmentId]);

  const writes = world.server.callsBy("publisher-admin", "POST").length;
  const approvedContent = world.approvedText(decision.uri);
  const repeat = world.addConversation(BASE_FACT, { name: "dup-c", quote: `A third chat repeats: ${BASE_FACT}` });
  const repeated = await world.prepare(repeat);
  assert.equal(repeated.status, "question");
  assert.equal(repeated.pendingReason, "already_approved_no_change");
  assert.equal(world.server.callsBy("publisher-admin", "POST").length, writes);
  assert.equal(world.approvedText(decision.uri), approvedContent);

  const other = world.addConversation(EXTRA_FACT, { name: "discarded" });
  const discardable = await world.prepare(other);
  assert.equal((await world.decide(discardable.id, "discard")).status, "discarded");
  const again = world.addConversation(EXTRA_FACT, { name: "discarded-again" });
  // The same original passage extracted again from a re-run of that chat.
  const sameProof = await world.prepare(again);
  assert.equal(sameProof.status, "discarded", "the same proof does not come back");
  assert.equal(sameProof.reappearance, "blocked_same_evidence");

  const newer = world.addConversation(EXTRA_FACT, { name: "discarded-new-proof", quote: `Later, with a new reason: ${EXTRA_FACT}` });
  const reproposed = await world.prepare(newer);
  assert.equal(reproposed.status, "reviewable");
  assert.equal(reproposed.reopens.proposalId, discardable.id);
  assert.match(reproposed.reopens.difference, /new evidence/iu);
}));

test("an interrupted publication never shows mixed versions, keeps the previous one and recovers on retry", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const baseContent = world.approvedText(uri);
  const later = world.addConversation(NEW_FACT, { name: "shipping-new" });
  const proposal = await world.prepare(later, { changeKind: "replace", targetUri: uri });

  world.server.failNext({ method: "POST", uriIncludes: "/approved/", status: 500 });
  const failed = await world.decide(proposal.id, "approve", "Fridays replaced Mondays.");
  assert.equal(failed.status, "publication_failed");
  assert.equal(failed.recoverable, true);
  assert.equal(failed.decisionId, proposal.id);
  assert.equal(world.approvedText(uri), baseContent, "normal reading still has the whole previous version");
  const publishing = await world.call("openviking_review_proposal", { proposalId: proposal.id });
  assert.equal(publishing.status, "publishing");
  const approvalsBefore = world.approvals.length;

  const retried = await world.decide(proposal.id, "approve");
  assert.equal(retried.status, "published", JSON.stringify(retried));
  assert.equal(world.approvals.length, approvalsBefore, "a retry completes the confirmed decision without asking again");
  assert.ok(world.approvedText(uri).includes(NEW_FACT));
  assert.equal(historyEntries(world).length, 1);
  assert.equal((await world.decide(proposal.id, "approve")).status, "already_published");
  assert.equal(historyEntries(world).length, 1);
}));

test("a lost response after the write is recovered without a second write", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const later = world.addConversation(EXTRA_FACT, { name: "shipping-extra" });
  const proposal = await world.prepare(later, { changeKind: "extend", targetUri: uri });

  world.server.failNext({ method: "POST", uriIncludes: "/approved/", applyBeforeFailing: true });
  const lost = await world.decide(proposal.id, "approve", "Same rule, one more condition.");
  assert.equal(lost.status, "publication_failed");
  const applied = world.approvedText(uri);
  assert.ok(applied.includes(EXTRA_FACT), "the server did apply the write");
  const writes = world.server.callsBy("publisher-admin", "POST").length;

  const recovered = await world.decide(proposal.id, "approve");
  assert.equal(recovered.status, "already_published");
  assert.equal(world.server.callsBy("publisher-admin", "POST").length, writes, "recovery does not write again");
  assert.equal(world.approvedText(uri), applied);
  assert.equal(historyEntries(world).length, 1);
  const stored = await world.call("openviking_review_proposal", { proposalId: proposal.id });
  assert.equal(stored.status, "approved");
}));

test("an interrupted retirement keeps the memory current until the retry completes it", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const baseContent = world.approvedText(uri);
  const later = world.addConversation("Invented rule: MAN354_BASE_a1 no longer applies.", { name: "shipping-retired" });
  const proposal = await world.prepare(later, { changeKind: "retire", targetUri: uri });

  world.server.failNext({ method: "DELETE", uriIncludes: "/approved/", status: 500 });
  const failed = await world.decide(proposal.id, "approve", "Dropped on purpose.");
  assert.equal(failed.status, "publication_failed");
  assert.equal(world.approvedText(uri), baseContent);
  const retried = await world.decide(proposal.id, "approve");
  assert.equal(retried.status, "published", JSON.stringify(retried));
  assert.equal(world.approvedText(uri), undefined);
  assert.equal(historyEntries(world).length, 1);
  assert.equal((await world.decide(proposal.id, "approve")).status, "already_published");
}));

test("changes need the history route and never read approved content through the publisher", () => withWorld(async world => {
  const base = world.addConversation(BASE_FACT, { name: "shipping" });
  const { uri } = await world.approveAlta(base);
  const later = world.addConversation(EXTRA_FACT, { name: "shipping-extra" });
  const proposal = await world.prepare(later, { changeKind: "extend", targetUri: uri });
  await world.decide(proposal.id, "approve", "Fine.");
  assert.equal(world.server.callsBy("publisher-admin", "GET").filter(call => call.path.startsWith("/api/v1/content/read")).length, 0);
  const historyWrite = world.server.callsBy("publisher-admin", "POST").find(call => JSON.parse(call.body).uri.includes("/history/"));
  assert.deepEqual(JSON.parse(historyWrite.body).acl.entries, [{ principal: "user:history", level: "read" }]);
}));
