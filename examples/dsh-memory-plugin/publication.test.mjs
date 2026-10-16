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
import { mountProposalTools } from "./proposal-tools.mjs";

const PROJECT_ID = "man353-synthetic-project";
const SESSION_ID = "man353-synthetic-session";
const SEGMENT_ID = `${SESSION_ID}:1`;
const SOURCE = "Invented delivery note: MAN353_FACT_7f2d9c happened in the test project.";
const CANDIDATE_URI = "viking://user/candidate/peers/man353-synthetic-project/memories/entities/man353-delivery.md";
const APPROVED_URI = "viking://resources/man353-synthetic-project/approved/memories/entities/man353-delivery.md";
const ARCHIVE_URI = "viking://~/sessions/man353-synthetic-session/archive";
const DIFF_URI = "viking://~/sessions/man353-synthetic-session/memory_diff.json";
const CANDIDATE_TEXT = [
  "# Summary",
  SOURCE,
  "",
  "# ChatLog",
  `User: ${SOURCE}`,
  "MEMORY_FIELDS: synthetic metadata only.",
].join("\n");
const SECOND_SEGMENT_ID = `${SESSION_ID}:2`;
const SECOND_SOURCE = "Invented follow-up note: MAN353_FACT_9c4e11 happened in the test project.";
const SECOND_CANDIDATE_URI = "viking://user/candidate/peers/man353-synthetic-project/memories/entities/man353-follow-up.md";
const SECOND_APPROVED_URI = "viking://resources/man353-synthetic-project/approved/memories/entities/man353-follow-up.md";
const SECOND_ARCHIVE_URI = "viking://~/sessions/man353-synthetic-session/archive-2";
const SECOND_DIFF_URI = "viking://~/sessions/man353-synthetic-session/memory_diff-2.json";
const SECOND_CANDIDATE_TEXT = [
  "# Summary",
  SECOND_SOURCE,
  "",
  "# ChatLog",
  `User: ${SECOND_SOURCE}`,
  "MEMORY_FIELDS: synthetic metadata only.",
].join("\n");

const originalStateDir = process.env.OPENVIKING_STATE_DIR;
const originalPendingDir = process.env.OPENVIKING_PENDING_DIR;

test("a proposal is exposed to the human-gated decision surface", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "man353-publication-"));
  process.env.OPENVIKING_STATE_DIR = stateDir;
  process.env.OPENVIKING_PENDING_DIR = join(stateDir, "pending");

  const sourceHash = createHash("sha256").update(SOURCE).digest("hex");
  const segment = {
    projectId: PROJECT_ID,
    dshSessionId: SESSION_ID,
    openVikingSessionId: "dsh-man353-synthetic-session",
    segmentId: SEGMENT_ID,
    archive: { status: "confirmed", uri: ARCHIVE_URI },
    extraction: { status: "completed_non_empty", memoryDiffUri: DIFF_URI },
    capture: { status: "captured" },
    coverageStatus: "complete",
    coveredEventIds: ["man353-event-1"],
    eventCoverage: [{
      eventId: "man353-event-1",
      eventType: "user/message",
      captureStatus: "captured",
      truncated: false,
      sourceTextHash: sourceHash,
    }],
  };
  const secondSourceHash = createHash("sha256").update(SECOND_SOURCE).digest("hex");
  const secondSegment = {
    ...segment,
    segmentId: SECOND_SEGMENT_ID,
    archive: { status: "confirmed", uri: SECOND_ARCHIVE_URI },
    extraction: { status: "completed_non_empty", memoryDiffUri: SECOND_DIFF_URI },
    coveredEventIds: ["man353-event-2"],
    eventCoverage: [{ ...segment.eventCoverage[0], eventId: "man353-event-2", sourceTextHash: secondSourceHash }],
  };
  const candidateClient = {
    config: { account: "project-a", user: "candidate" },
    async fetchJSON(path) {
      const uri = new URL(`http://fixture${path}`).searchParams.get("uri");
      if (uri === `${ARCHIVE_URI}/messages.jsonl`) {
        return { ok: true, result: `${JSON.stringify({ parts: [{ type: "text", text: SOURCE }] })}\n` };
      }
      if (uri === DIFF_URI) {
        return { ok: true, result: JSON.stringify({ operations: { adds: [{ uri: CANDIDATE_URI }], updates: [], deletes: [] } }) };
      }
      if (uri === CANDIDATE_URI) return { ok: true, result: CANDIDATE_TEXT };
      if (uri === `${SECOND_ARCHIVE_URI}/messages.jsonl`) {
        return { ok: true, result: `${JSON.stringify({ parts: [{ type: "text", text: SECOND_SOURCE }] })}\n` };
      }
      if (uri === SECOND_DIFF_URI) {
        return { ok: true, result: JSON.stringify({ operations: { adds: [{ uri: SECOND_CANDIDATE_URI }], updates: [], deletes: [] } }) };
      }
      if (uri === SECOND_CANDIDATE_URI) return { ok: true, result: SECOND_CANDIDATE_TEXT };
      return { ok: false, status: 404, error: { code: "NOT_FOUND" } };
    },
  };
  const publisherCalls = [];
  const approvedReadUris = [];
  const publishedContent = new Map();
  let resourceAclIsEnabled = true;
  let createConflictAfterApproval = false;
  const approvedClient = {
    config: { account: "project-a", user: "approved" },
    async fetchJSON(path) {
      const uri = new URL(`http://fixture${path}`).searchParams.get("uri");
      approvedReadUris.push(uri);
      if (uri && publishedContent.has(uri)) {
        return { ok: true, status: 200, result: publishedContent.get(uri) };
      }
      return { ok: false, status: 404, error: { code: "NOT_FOUND" } };
    },
  };
  const approvalRequests = [];
  let approvalOutcome = "rejected";
  const publisherClient = {
    config: { account: "project-a", user: "publisher-admin" },
    async fetchJSON(path, init = {}) {
      const request = new URL(`http://fixture${path}`);
      const uri = request.searchParams.get("uri");
      const method = init.method || "GET";
      publisherCalls.push({ path, method, body: init.body });
      if (method === "GET" && request.pathname === "/api/v1/admin/accounts/project-a/settings") {
        return { ok: true, status: 200, result: { settings: { acl: { enabled: resourceAclIsEnabled } } } };
      }
      if (method === "POST" && path === "/api/v1/content/write") {
        const body = JSON.parse(init.body);
        publishedContent.set(body.uri, body.content);
        return { ok: true, status: 200, result: { uri: body.uri } };
      }
      if (uri && publishedContent.has(uri)) {
        return { ok: true, status: 200, result: publishedContent.get(uri) };
      }
      return { ok: false, status: 404, error: { code: "NOT_FOUND" } };
    },
  };
  const runtime = {
    async listProposalSegments() { return [segment, secondSegment]; },
    async findProposalSegment(id) {
      return [segment, secondSegment].find(item => item.segmentId === id) || null;
    },
  };

  const ctx = new Context();
  const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  const toolFiber = ctx.plugin(ToolRuntime, { mode: "native" });
  const approvalFiber = ctx.plugin(ApprovalService, { policy: "ask" });
  let proposalFiber;
  try {
    await Promise.all([promptFiber, toolFiber, approvalFiber]);
    proposalFiber = ctx.plugin({
      name: "man353-publication-test",
      inject: ["tools", "approval"],
      apply(pluginCtx) {
        mountProposalTools(pluginCtx, {
          runtime,
          candidateClient,
          approvedClient,
          publisherClient,
          approvalAuthorLabel: "Sergi (etiqueta configurada)",
        });
      },
    });
    await proposalFiber;

    const prepared = await ctx.tools.execute({
      callId: "man353-prepare-red-test",
      name: "openviking_review_proposal",
      arguments: { segmentId: SEGMENT_ID },
      signal: new AbortController().signal,
    });
    assert.equal(prepared.isError, false, JSON.stringify(prepared.error));
    assert.equal(prepared.value.status, "reviewable");
    assert.equal(prepared.value.proposedText, CANDIDATE_TEXT);
    const otherProposal = await ctx.tools.execute({
      callId: "man353-prepare-other-proposal",
      name: "openviking_review_proposal",
      arguments: { segmentId: SECOND_SEGMENT_ID },
      signal: new AbortController().signal,
    });
    assert.equal(otherProposal.value.status, "reviewable");
    assert.equal(otherProposal.value.proposedText, SECOND_CANDIDATE_TEXT);

    const toolNames = new Set(ctx.tools.schemas().map(tool => tool.name));
    assert.ok(toolNames.has("openviking_decide_proposal"), "DSH must expose the identified human-gated decision surface");

    ctx.on("approval/request", request => {
      approvalRequests.push(request);
      if (createConflictAfterApproval) {
        createConflictAfterApproval = false;
        publishedContent.set(SECOND_APPROVED_URI, "An unrelated approved item appeared during the human confirmation.");
      }
      return approvalOutcome;
    });
    const session = {
      events: [{ type: "turn/start", data: {} }],
      append(type, data) { this.events.push({ type, data }); },
    };
    const denied = await ctx.tools.execute({
      callId: "man353-denied-approval",
      name: "openviking_decide_proposal",
      arguments: {
        proposalId: prepared.value.id,
        action: "approve",
        reason: "Keep the invented delivery marker for this project only.",
      },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(denied.isError, false, JSON.stringify(denied.error));
    assert.equal(denied.value.status, "approval_rejected");
    assert.equal(approvalRequests.length, 1);
    assert.match(approvalRequests[0].reason, /this project only/i);
    assert.deepEqual(session.events.slice(-2).map(event => event.type), ["approval/asked", "approval/decided"]);
    assert.equal(session.events.at(-1).data.outcome, "rejected");
    assert.equal(publisherCalls.some(call => call.method === "POST"), false, "a rejected approval must never write");

    approvalOutcome = "allowed-once";
    const approved = await ctx.tools.execute({
      callId: "man353-approved-once",
      name: "openviking_decide_proposal",
      arguments: {
        proposalId: prepared.value.id,
        action: "approve",
        reason: "Keep the invented delivery marker for this project only.",
      },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(approved.isError, false, JSON.stringify(approved.error));
    assert.equal(approved.value.status, "published");
    assert.equal(approved.value.uri, APPROVED_URI);
    assert.equal(publisherCalls.filter(call => call.method === "POST").length, 1);
    const published = publishedContent.get(APPROVED_URI);
    assert.match(published, /<!-- openviking-approval:v1/u);
    assert.ok(published.includes('"authorLabel":"Sergi (etiqueta configurada)"'));
    assert.ok(published.includes('"project":"man353-synthetic-project"'));
    assert.ok(published.includes('"segment":"man353-synthetic-session:1"'));
    assert.ok(published.includes('"reason":"Keep the invented delivery marker for this project only."'));

    const repeated = await ctx.tools.execute({
      callId: "man353-repeat-approved-once",
      name: "openviking_decide_proposal",
      arguments: {
        proposalId: prepared.value.id,
        action: "approve",
        reason: "A different retry reason must not replace the confirmed record.",
      },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(repeated.value.status, "already_published");
    assert.equal(publishedContent.size, 1);
    assert.equal(publisherCalls.filter(call => call.method === "POST").length, 1);
    assert.equal(approvalRequests.length, 2, "a repeated decision must not ask for a second approval");

    const correctedReason = "Keep the second invented delivery marker only as an unapproved draft.";
    const revised = await ctx.tools.execute({
      callId: "man353-revise-other-proposal",
      name: "openviking_decide_proposal",
      arguments: { proposalId: otherProposal.value.id, action: "revise", reason: correctedReason },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(revised.value.status, "reason_revised_not_published");
    const reopenedOther = await ctx.tools.execute({
      callId: "man353-reopen-other-proposal",
      name: "openviking_review_proposal",
      arguments: { proposalId: otherProposal.value.id },
      signal: new AbortController().signal,
    });
    assert.equal(reopenedOther.value.status, "reviewable");
    assert.equal(reopenedOther.value.reasonSuggested, correctedReason);

    const deferred = await ctx.tools.execute({
      callId: "man353-defer-other-proposal",
      name: "openviking_decide_proposal",
      arguments: { proposalId: otherProposal.value.id, action: "defer" },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(deferred.value.status, "deferred_not_published");
    assert.equal(publisherCalls.filter(call => call.method === "POST").length, 1);
    assert.equal(approvalRequests.length, 2, "a draft-only action must not ask for publication approval");

    approvalOutcome = "unavailable";
    const unanswered = await ctx.tools.execute({
      callId: "man353-no-answer-other-proposal",
      name: "openviking_decide_proposal",
      arguments: { proposalId: otherProposal.value.id, action: "approve", reason: correctedReason },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(unanswered.value.status, "approval_unavailable");
    assert.equal(publisherCalls.filter(call => call.method === "POST").length, 1);

    approvalOutcome = "allowed-once";
    createConflictAfterApproval = true;
    const conflicted = await ctx.tools.execute({
      callId: "man353-conflict-after-approval",
      name: "openviking_decide_proposal",
      arguments: { proposalId: otherProposal.value.id, action: "approve", reason: correctedReason },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(conflicted.value.status, "publication_conflict");
    assert.equal(approvalRequests.length, 4);
    assert.equal(publisherCalls.filter(call => call.method === "POST").length, 1);
    assert.equal(
      publisherCalls.some(call => call.path.startsWith("/api/v1/content/read?")),
      false,
      "the publisher identity must not read approved content",
    );
    assert.ok(approvedReadUris.filter(uri => uri === SECOND_APPROVED_URI).length >= 3);

    resourceAclIsEnabled = false;
    const blockedWithoutResourceAcl = await ctx.tools.execute({
      callId: "man353-acl-disabled",
      name: "openviking_decide_proposal",
      arguments: { proposalId: otherProposal.value.id, action: "approve", reason: correctedReason },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(blockedWithoutResourceAcl.value.status, "publication_acl_disabled");
    assert.equal(approvalRequests.length, 4, "disabled resource ACL must not ask for approval");
    assert.equal(publisherCalls.filter(call => call.method === "POST").length, 1);
    resourceAclIsEnabled = true;

    const discarded = await ctx.tools.execute({
      callId: "man353-discard-other-proposal",
      name: "openviking_decide_proposal",
      arguments: { proposalId: otherProposal.value.id, action: "discard" },
      agent: { session },
      signal: new AbortController().signal,
    });
    assert.equal(discarded.value.status, "discarded");
    assert.equal(publisherCalls.filter(call => call.method === "POST").length, 1);
  } finally {
    if (proposalFiber) await proposalFiber.dispose();
    await approvalFiber.dispose();
    await toolFiber.dispose();
    await promptFiber.dispose();
    if (originalStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
    else process.env.OPENVIKING_STATE_DIR = originalStateDir;
    if (originalPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR;
    else process.env.OPENVIKING_PENDING_DIR = originalPendingDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
