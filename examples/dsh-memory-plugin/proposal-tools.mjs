import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { extractTextFromContent } from "./shared/capture-utils.mjs";
import { stateDir } from "./shared/workspace-identity.mjs";
import { parseMemoryDiff } from "./runtime.mjs";
import {
  applyChange,
  buildChangeIntent,
  composeExtension,
  contentWithApprovalRecord,
  inspectChange,
  normalizeText,
  parseApprovalRecord,
  readPublication,
  sha256,
  sourcesOf,
  stripApprovalRecord,
  validateChangeTarget,
  versionOf,
} from "./approved-versions.mjs";

const CHANGE_KINDS = ["extend", "replace", "retire"];
const PROPOSAL_FILE = "review-proposals.json";
const PROPOSAL_TOOL_PREFIX = "openviking_";
const targetQueue = new Map();
const PENDING_FILTER_NOTE = "El filtro busca formatos conocidos de credenciales; no detecta todo texto sensible.";
const COMMON_NEGATION_PATTERN = /\b(?:no|not|never|neither|nor|none|nobody|nothing|without|cannot|can't|couldn't|didn't|doesn't|don't|isn't|aren't|wasn't|weren't|won't|wouldn't|mustn't|sin|nunca|jamás|tampoco|ningún|ninguna|ninguno|ningunos|ningunas|nadie|nada|ni)\b/iu;

/** Mount the DSH proposal surface; publication is available only behind DSH approval. */
export function mountProposalTools(ctx, {
  runtime,
  candidateClient,
  approvedClient,
  publisherClient,
  historyClient,
  approvalAuthorLabel,
}) {
  if (!runtime || !candidateClient || !approvedClient) {
    throw new TypeError("Proposal tools require the runtime, candidate client, and approved client.");
  }

  const store = new ProposalStore();
  const definitions = [reviewTool({ runtime, candidateClient, approvedClient, store })];
  if (publisherClient && ctx.approval && approvalAuthorLabel) {
    definitions.push(decisionTool({
      store,
      approval: ctx.approval,
      candidateClient,
      approvedClient,
      publisherClient,
      historyClient,
      approvalAuthorLabel,
    }));
  }
  const disposers = definitions.map(definition => ctx.tools.register(definition));
  ctx.effect(
    () => () => disposers.reverse().forEach(dispose => dispose()),
    "openvikingMemory.disposeProposalTools()",
  );
  return store;
}

function decisionTool(dependencies) {
  const inFlight = new Map();
  return {
    name: `${PROPOSAL_TOOL_PREFIX}decide_proposal`,
    description: "Approve, defer, revise the reason for, or discard one reviewed proposal. Approval requires a separate one-time DSH human confirmation; other actions never publish.",
    parameters: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Reviewed proposal ID." },
        action: { type: "string", enum: ["approve", "defer", "revise", "discard"] },
        reason: { type: "string", description: "Reason to confirm or revise; approval will show it in the human confirmation request." },
      },
      required: ["proposalId", "action"],
      additionalProperties: false,
    },
    output: decisionOutput(),
    async execute(args, exec) {
      const current = inFlight.get(args.proposalId);
      if (current) return current;
      const operation = (async () => {
        const proposal = args.action === "approve" ? await dependencies.store.get(args.proposalId) : null;
        const target = proposal?.change?.targetUri;
        if (!target) return decideProposal(args, exec, dependencies);
        const previous = targetQueue.get(target);
        const run = (async () => {
          if (previous) await previous;
          return decideProposal(args, exec, dependencies);
        })();
        const settled = run.then(() => {}, () => {});
        targetQueue.set(target, settled);
        try {
          return await run;
        } finally {
          if (targetQueue.get(target) === settled) targetQueue.delete(target);
        }
      })();
      inFlight.set(args.proposalId, operation);
      try {
        return await operation;
      } finally {
        if (inFlight.get(args.proposalId) === operation) inFlight.delete(args.proposalId);
      }
    },
  };
}

async function decideProposal(args, exec, {
  store,
  approval,
  publisherClient,
  approvedClient,
  candidateClient,
  historyClient,
  approvalAuthorLabel,
}) {
  const proposal = await store.get(args.proposalId);
  if (!proposal) return { proposalId: args.proposalId, status: "proposal_not_found" };
  if (proposal.status === "approved") {
    return { proposalId: proposal.id, status: "already_published", uri: proposal.publishedUri };
  }
  // A change whose confirmed decision was interrupted is finished, not asked about again.
  const resuming = proposal.status === "publishing" && proposal.change && proposal.intent && args.action === "approve";
  if (proposal.status !== "reviewable" && !resuming) {
    return { proposalId: proposal.id, status: proposal.status || "proposal_not_reviewable" };
  }
  if (args.action === "defer") {
    return { proposalId: proposal.id, status: "deferred_not_published" };
  }
  if (args.action === "revise") {
    const draftReason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!draftReason) return { proposalId: proposal.id, status: "reason_required" };
    await store.save({ ...proposal, reasonDraft: draftReason, reasonSuggested: draftReason });
    return { proposalId: proposal.id, status: "reason_revised_not_published" };
  }
  if (args.action === "discard") {
    await store.save({ ...proposal, status: "discarded", discardedAt: new Date().toISOString() });
    return { proposalId: proposal.id, status: "discarded" };
  }
  if (args.action !== "approve") return { proposalId: proposal.id, status: "invalid_action" };
  const reason = resuming
    ? proposal.intent.approvalRecord.reason
    : typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim()
      : String(proposal.reasonDraft || "").trim();
  if (!reason) return { proposalId: proposal.id, status: "confirmed_reason_required" };
  if (!exec?.agent && !resuming) return { proposalId: proposal.id, status: "approval_context_unavailable" };
  if (proposal.change) {
    return decideChange(proposal, reason, resuming, exec, {
      store,
      approval,
      publisherClient,
      approvedClient,
      historyClient,
      approvalAuthorLabel,
    });
  }

  const targets = approvedMemoryTargets(proposal, candidateClient, approvedClient);
  const uri = targets?.resourceUri;
  if (!uri) return { proposalId: proposal.id, status: "project_scope_mismatch" };
  const existing = await checkForPublication(store, approvedClient, publisherClient, proposal, uri, exec.signal);
  if (existing) return existing;

  let outcome;
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: "openviking_decide_proposal",
      callId: exec.callId,
      signal: exec.signal,
      reason: approvalReason(proposal, reason, approvalAuthorLabel),
    });
  } catch {
    return { proposalId: proposal.id, status: "approval_unavailable" };
  }
  if (outcome !== "allowed-once") {
    return { proposalId: proposal.id, status: `approval_${outcome.replaceAll("-", "_")}` };
  }

  const appeared = await checkForPublication(store, approvedClient, publisherClient, proposal, uri, exec.signal);
  if (appeared) return appeared;

  const approvalRecord = {
    schema: "openviking.dsh.approval.v1",
    proposalId: proposal.id,
    authorLabel: approvalAuthorLabel,
    authorLabelIsConfigured: true,
    approvedAt: new Date().toISOString(),
    project: proposal.project,
    scope: `project:${proposal.project}`,
    source: {
      archiveUri: proposal.source?.archiveUri || "",
      session: proposal.session,
      segment: proposal.segment,
      eventIds: proposal.coverage?.eventIds || [],
    },
    sources: sourcesOf(proposal),
    reason,
  };
  const content = contentWithApprovalRecord(proposal.proposedText, approvalRecord);
  let write;
  try {
    write = await publisherClient.fetchJSON("/api/v1/content/write", {
      method: "POST",
      body: JSON.stringify({
        uri,
        content,
        mode: "replace",
        wait: true,
        acl: {
          acl_mode: "restricted",
          entries: [{ principal: `user:${approvedClient.config.user}`, level: "read" }],
        },
      }),
    }, { signal: exec.signal });
  } catch {
    return { proposalId: proposal.id, status: "publication_failed" };
  }
  if (!write.ok) return { proposalId: proposal.id, status: "publication_failed" };

  await store.save({
    ...proposal,
    status: "approved",
    publishedUri: uri,
    approvalRecord,
  });
  return { proposalId: proposal.id, status: "published", uri, approvedAt: approvalRecord.approvedAt };
}

/**
 * Approve an extension, substitution or retirement of an approved memory. The whole previous
 * version goes to history first, then the current memory is replaced (or removed) in one step.
 * The confirmed decision is stored before anything is written, so an interrupted publication
 * is finished from that record instead of being asked about again.
 */
async function decideChange(proposal, reason, resuming, exec, {
  store,
  approval,
  publisherClient,
  approvedClient,
  historyClient,
  approvalAuthorLabel,
}) {
  const answer = (status, extra = {}) => ({ proposalId: proposal.id, decisionId: proposal.id, status, ...extra });
  if (!historyClient) return answer("history_unavailable");
  const targetUri = validateChangeTarget(proposal.project, proposal.change.targetUri);
  if (!targetUri) return answer("project_scope_mismatch");
  const aclEnabled = await resourceAclEnabled(publisherClient, exec?.signal);
  if (aclEnabled === null) return answer("publication_check_failed");
  if (!aclEnabled) return answer("publication_acl_disabled");

  const settle = async state => {
    if (state.state === "check_failed") return answer("publication_check_failed", { failure: state.failure });
    if (state.state === "history_conflict") return answer("publication_conflict", { historyUri: state.historyUri });
    if (state.state === "base_changed") {
      await store.save({ ...proposal, status: "needs_new_review", pendingReason: "base_version_changed", intent: undefined });
      return answer("base_version_changed", { uri: targetUri });
    }
    if (state.state === "completed") {
      await store.save({
        ...proposal,
        status: "approved",
        publishedUri: proposal.change.kind === "retire" ? "" : targetUri,
        historyUri: state.historyUri,
        approvalRecord: state.record || proposal.intent?.approvalRecord,
        intent: undefined,
      });
      return answer("already_published", { uri: targetUri, historyUri: state.historyUri });
    }
    return null;
  };
  const inspect = () => inspectChange({ approvedClient, historyClient, proposal, signal: exec?.signal });

  let state = await inspect();
  const finished = await settle(state);
  if (finished) return finished;

  let intent = resuming ? proposal.intent : null;
  if (!intent) {
    let outcome;
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName: "openviking_decide_proposal",
        callId: exec.callId,
        signal: exec.signal,
        reason: `${approvalReason(proposal, reason, approvalAuthorLabel)}\n${changeApprovalLines(proposal)}`,
      });
    } catch {
      return answer("approval_unavailable");
    }
    if (outcome !== "allowed-once") return answer(`approval_${outcome.replaceAll("-", "_")}`);
    state = await inspect();
    const changedWhileAsking = await settle(state);
    if (changedWhileAsking) return changedWhileAsking;
    intent = buildChangeIntent(proposal, {
      reason,
      authorLabel: approvalAuthorLabel,
      approvedAt: new Date().toISOString(),
      approvedUser: approvedClient.config.user,
    });
    await store.save({ ...proposal, status: "publishing", intent });
  }

  const applied = await applyChange({
    publisherClient,
    historyUser: historyClient.config.user,
    intent,
    historyExists: state.historyExists,
    signal: exec?.signal,
  });
  if (!applied.ok) return answer("publication_failed", { recoverable: true, stage: applied.stage });
  await store.save({
    ...proposal,
    status: "approved",
    publishedUri: intent.kind === "retire" ? "" : intent.targetUri,
    historyUri: intent.historyUri,
    approvalRecord: intent.approvalRecord,
    intent: undefined,
  });
  return answer("published", {
    kind: intent.kind,
    ...(intent.kind === "retire" ? { retiredUri: intent.targetUri } : { uri: intent.targetUri }),
    historyUri: intent.historyUri,
    version: intent.approvalRecord.change.version,
    approvedAt: intent.approvalRecord.approvedAt,
  });
}

function changeApprovalLines(proposal) {
  const { kind, targetUri, base } = proposal.change;
  return [
    `Cambio: ${kind} de ${targetUri} (versión base ${base.version}).`,
    `Antes: ${proposal.approvedPrevious?.text || ""}`,
    `Después: ${kind === "retire" ? "retirada: sale de la lectura normal y la versión íntegra queda en historia" : proposal.proposedText}`,
    `Original comprobado: ${proposal.originalPassage || ""}`,
  ].join("\n");
}

function reviewTool({ runtime, candidateClient, approvedClient, store }) {
  return {
    name: `${PROPOSAL_TOOL_PREFIX}review_proposal`,
    description: "List extracted DSH segments, prepare one local review proposal, or open a saved proposal. Set segmentId to prepare or proposalId to open; no arguments list eligible segments. This tool never publishes to approved memory.",
    parameters: {
      type: "object",
      properties: {
        segmentId: { type: "string", description: "Segment ID to check and prepare as a proposal." },
        proposalId: { type: "string", description: "Saved proposal ID to open in the review view." },
        targetProjects: {
          type: "array",
          items: { type: "string" },
          description: "Optional requested project scope. An unverified scope remains a question, not a generalization.",
        },
        changeKind: {
          type: "string",
          enum: CHANGE_KINDS,
          description: "With segmentId and targetUri, prepare an extension, substitution or retirement of an already approved memory instead of a new one. Never inferred.",
        },
        targetUri: {
          type: "string",
          description: "Approved memory (viking://resources/<project>/approved/memories/...) that the change applies to.",
        },
        laterFactExplanation: {
          type: "string",
          description: "After a discard, explain the later fact using a passage present in the new original conversation.",
        },
      },
      additionalProperties: false,
    },
    output: proposalOutput(),
    async execute(args, exec) {
      if (args.proposalId && args.segmentId) {
        return pendingProposal({
          id: args.proposalId,
          status: "pending",
          pendingReason: "multiple_actions_requested",
        });
      }
      if (args.proposalId) return openProposal(store, args.proposalId);
      if (!args.segmentId) {
        return {
          kind: "segments",
          segments: (await runtime.listProposalSegments()).map(summarizeSegment),
        };
      }
      return prepareProposal({
        args,
        signal: exec?.signal,
        runtime,
        candidateClient,
        approvedClient,
        store,
      });
    },
    presentCall: args => ({
      card: "generic",
      title: args.proposalId
        ? "Abrir propuesta revisable"
        : args.segmentId ? "Preparar propuesta revisable" : "Tramos disponibles para revisar",
      ...(args.segmentId ? { content: `Comprobar el tramo ${args.segmentId} sin publicarlo.` } : {}),
    }),
    presentResult: (_args, result) => proposalView(result),
  };
}

async function prepareProposal({ args, signal, runtime, candidateClient, approvedClient, store }) {
  const segment = await runtime.findProposalSegment(args.segmentId);
  if (!segment) {
    return pendingProposal({
      id: proposalId("missing", args.segmentId),
      status: "pending",
      segment: args.segmentId,
      pendingReason: "segment_not_available",
    });
  }

  let change = null;
  if (args.changeKind !== undefined || args.targetUri !== undefined) {
    const label = `${args.changeKind || ""}:${args.targetUri || ""}`;
    const pendingChange = async reason => {
      const pending = pendingProposal({
        ...proposalMetadata(segment),
        id: proposalId(segment.projectId, segment.segmentId, "", label),
        status: "pending",
        pendingReason: reason,
      });
      await store.save(pending);
      return pending;
    };
    if (!CHANGE_KINDS.includes(args.changeKind) || !args.targetUri) return pendingChange("change_target_required");
    const targetUri = validateChangeTarget(String(segment.projectId || ""), args.targetUri);
    if (!targetUri) return pendingChange("change_target_invalid");
    change = { kind: args.changeKind, targetUri };
  }

  const targetProjects = Array.isArray(args.targetProjects) && args.targetProjects.length > 0
    ? [...new Set(args.targetProjects.map(value => String(value).trim()).filter(Boolean))]
    : [String(segment.projectId || "")];
  if (targetProjects.length !== 1 || targetProjects[0] !== String(segment.projectId || "")) {
    const question = pendingProposal({
      ...proposalMetadata(segment),
      id: proposalId(segment.projectId, segment.segmentId),
      status: "question",
      pendingReason: "project_scope_unverified",
      question: `Solo se ha comprobado el proyecto ${segment.projectId}. ¿Quieres revisar la propuesta limitada a ese proyecto?`,
    });
    await store.save(question);
    return question;
  }

  const coverageProblem = segmentProblem(segment);
  if (coverageProblem) {
    const pending = pendingProposal({
      ...proposalMetadata(segment),
      id: proposalId(segment.projectId, segment.segmentId),
      status: "pending",
      pendingReason: coverageProblem,
    });
    await store.save(pending);
    return pending;
  }

  const evidence = await readEvidence(segment, candidateClient, approvedClient, signal, change);
  if (!evidence.ok) {
    const pending = pendingProposal({
      ...proposalMetadata(segment),
      id: proposalId(segment.projectId, segment.segmentId, "", change ? `${change.kind}:${change.targetUri}` : ""),
      status: evidence.status === "question" ? "question" : "pending",
      pendingReason: evidence.reason,
      ...(evidence.safeAssertion ? { assertion: evidence.safeAssertion } : {}),
      ...(evidence.question ? { question: evidence.question } : {}),
      ...(evidence.originalPassage ? { originalPassage: evidence.originalPassage } : {}),
      ...(evidence.approvedPrevious ? { approvedPrevious: evidence.approvedPrevious } : {}),
      ...(evidence.failure ? { failure: evidence.failure } : {}),
    });
    await store.save(pending);
    return pending;
  }

  const kind = change ? change.kind : "add";
  const id = proposalId(
    segment.projectId,
    segment.segmentId,
    evidence.candidateUri,
    change ? `${change.kind}:${change.targetUri}` : "",
  );
  const previous = await store.get(id);
  if (["approved", "discarded", "publishing"].includes(previous?.status)) return previous;

  const source = {
    session: String(segment.dshSessionId || ""),
    segment: String(segment.segmentId || ""),
    archiveUri: segment.archive.uri,
    candidateUri: evidence.candidateUri,
    eventIds: summarizeCoverage(segment).eventIds,
    evidenceKey: sha256(evidence.originalPassage),
  };
  const contentKey = sha256([
    segment.projectId,
    kind,
    change?.targetUri || "",
    normalizeText(evidence.candidateAssertion),
  ].join("\n"));
  const duplicate = await resolveDuplicate({
    store, approvedClient, signal, id, contentKey, source, evidence, segment,
    laterFactExplanation: args.laterFactExplanation,
  });
  if (duplicate.result) return duplicate.result;

  const proposal = {
    ...proposalMetadata(segment),
    id,
    status: "reviewable",
    contentKey,
    assertion: evidence.candidateAssertion,
    originalPassage: evidence.originalPassage,
    coverage: summarizeCoverage(segment),
    approvedPrevious: evidence.approvedPrevious,
    proposedText: evidence.proposedText ?? evidence.candidateText,
    source: {
      archiveUri: segment.archive.uri,
      candidateUri: evidence.candidateUri,
    },
    sources: previous?.status === "reviewable" && Array.isArray(previous.sources)
      ? [...previous.sources.filter(item => item.segment !== source.segment), source]
      : [source],
    ...(change ? { change: evidence.change } : {}),
    ...(duplicate.reopens ? { reopens: duplicate.reopens } : {}),
    ...(previous?.reasonDraft ? { reasonDraft: previous.reasonDraft } : {}),
    reasonSuggested: previous?.reasonDraft || "La afirmación aparece en el pasaje original comprobado de una conversación nueva; Sergi debe decidir si quiere conservarla como conocimiento vigente.",
    effect: change
      ? `Si Sergi aprueba esta ${change.kind === "extend" ? "ampliación" : change.kind === "replace" ? "sustitución" : "retirada"}, ${change.kind === "retire" ? "el recuerdo saldrá de la búsqueda ordinaria" : "la búsqueda ordinaria leerá la versión nueva completa"} de ${segment.projectId} y la versión anterior íntegra quedará en historia. Hasta entonces no cambia nada.`
      : `Si se aprueba en un flujo futuro, el texto podría entrar en la búsqueda ordinaria de ${segment.projectId}; esta propuesta no publica ni modifica el aprobado.`,
    filterNote: "Se comprobaron formatos conocidos de credenciales. Esto no detecta todo texto sensible.",
    pendingReason: "",
  };
  await store.save(proposal);
  return proposal;
}

/**
 * Repeated ideas: a pending twin gathers the new source, an approved twin is not rewritten and a
 * discarded twin requires a different proof and an explained later fact in its original passage.
 */
async function resolveDuplicate({ store, approvedClient, signal, id, contentKey, source, evidence, segment, laterFactExplanation }) {
  const twins = (await store.all()).filter(record => record.contentKey === contentKey && record.id !== id);

  for (const twin of twins.filter(record => record.status === "approved" && record.publishedUri)) {
    const current = await readPublication(approvedClient, twin.publishedUri, signal);
    if (current.exists && parseApprovalRecord(current.content)?.proposalId === twin.id) {
      const question = pendingProposal({
        ...proposalMetadata(segment),
        id,
        status: "question",
        pendingReason: "already_approved_no_change",
        assertion: evidence.candidateAssertion,
        originalPassage: evidence.originalPassage,
        approvedPrevious: { status: "found", text: stripApprovalRecord(current.content) },
        question: "Esta afirmación ya está aprobada sin cambios. ¿Quieres cerrar la revisión sin preparar otra alta?",
        duplicateOf: twin.id,
      });
      await store.save(question);
      return { result: question };
    }
  }

  const pending = twins.find(record => record.status === "reviewable");
  if (pending) {
    const known = sourcesOf(pending);
    if (known.some(item => item.evidenceKey === source.evidenceKey && item.segment === source.segment)) {
      return { result: pending };
    }
    const merged = { ...pending, sources: [...known, source] };
    await store.save(merged);
    return { result: merged };
  }

  const discarded = twins.filter(record => record.status === "discarded");
  if (discarded.length > 0) {
    const sameProof = discarded.find(record => sourcesOf(record).some(item => item.evidenceKey === source.evidenceKey));
    if (sameProof) return { result: { ...sameProof, reappearance: "blocked_same_evidence" } };
    const explanation = typeof laterFactExplanation === "string" ? laterFactExplanation.trim() : "";
    if (
      !/[.!?。！？]$/u.test(explanation)
      || !evidence.originalPassage.includes(explanation)
      || !hasCompleteAssertionBoundaries(evidence.originalPassage, evidence.originalPassage.indexOf(explanation), explanation)
      || discarded.some(record => record.originalPassage?.includes(explanation))
      || !Number.isFinite(Date.parse(evidence.originalCreatedAt))
      || discarded.some(record => !Number.isFinite(Date.parse(record.discardedAt))
        || Date.parse(evidence.originalCreatedAt) <= Date.parse(record.discardedAt))
    ) {
      const question = pendingProposal({
        ...proposalMetadata(segment),
        id,
        status: "question",
        pendingReason: "later_fact_explanation_required",
        originalPassage: evidence.originalPassage,
        question: "Indica qué hecho posterior explica reabrir el descarte y señala el pasaje original que lo contiene.",
      });
      await store.save(question);
      return { result: question };
    }
    return {
      reopens: {
        proposalId: discarded[0].id,
        difference: `Later fact from ${source.segment}: ${explanation}`,
      },
    };
  }
  return {};
}

async function openProposal(store, id) {
  const proposal = await store.get(id);
  if (!proposal) {
    return pendingProposal({ id, status: "pending", pendingReason: "proposal_not_found" });
  }
  const secretFilterProblem = await hasKnownSecret(
    proposal.assertion,
    proposal.proposedText,
    proposal.originalPassage,
    proposal.approvedPrevious?.text,
  );
  if (secretFilterProblem) {
    return pendingProposal({
      ...proposalMetadata(proposal),
      id: proposal.id,
      status: "pending",
      pendingReason: secretFilterProblem,
    });
  }
  return proposal;
}

function approvedMemoryTargets(proposal, candidateClient, approvedClient) {
  const candidateUser = candidateClient?.config?.user;
  const candidateAccount = candidateClient?.config?.account;
  const approvedUser = approvedClient?.config?.user;
  const approvedAccount = approvedClient?.config?.account;
  const candidateUri = proposal.source?.candidateUri;
  const project = String(proposal.project || "");
  if (
    !candidateUser
    || !approvedUser
    || !candidateAccount
    || candidateAccount !== approvedAccount
    || !candidateUri
    || !project
    || project === "."
    || project === ".."
    || /[\\/?#]/u.test(project + candidateUser + approvedUser)
  ) return null;

  const prefix = `viking://user/${candidateUser}/peers/`;
  if (!candidateUri.startsWith(prefix)) return null;
  const rest = candidateUri.slice(prefix.length);
  const peerEnd = rest.indexOf("/");
  if (peerEnd < 1) return null;
  let peer;
  try {
    peer = decodeURIComponent(rest.slice(0, peerEnd));
  } catch {
    return null;
  }
  const candidatePath = rest.slice(peerEnd + 1);
  if (peer !== project || !candidatePath.startsWith("memories/") || !candidatePath.slice("memories/".length)) {
    return null;
  }
  if (candidatePath.split("/").some(part => part === "." || part === "..") || /[?#]/u.test(candidatePath)) {
    return null;
  }
  const projectPath = encodeURIComponent(project);
  return {
    resourceUri: `viking://resources/${projectPath}/approved/${candidatePath}`,
    peerUri: `viking://user/${approvedUser}/peers/${projectPath}/${candidatePath}`,
  };
}

async function checkForPublication(store, approvedClient, publisherClient, proposal, uri, signal) {
  const aclEnabled = await resourceAclEnabled(publisherClient, signal);
  if (aclEnabled === null) return { proposalId: proposal.id, status: "publication_check_failed" };
  if (!aclEnabled) return { proposalId: proposal.id, status: "publication_acl_disabled" };

  const existing = await readPublication(approvedClient, uri, signal);
  if (!existing.ok) return { proposalId: proposal.id, status: "publication_check_failed" };
  if (!existing.exists) return null;

  const approvalRecord = parseApprovalRecord(existing.content);
  if (approvalRecord?.proposalId !== proposal.id) {
    return { proposalId: proposal.id, status: "publication_conflict", uri };
  }
  await store.save({ ...proposal, status: "approved", publishedUri: uri, approvalRecord });
  return { proposalId: proposal.id, status: "already_published", uri };
}

async function resourceAclEnabled(client, signal) {
  const account = client?.config?.account;
  if (!account) return null;
  try {
    const response = await client.fetchJSON(
      `/api/v1/admin/accounts/${encodeURIComponent(account)}/settings`,
      {},
      { signal },
    );
    if (!response.ok) return null;
    const enabled = response.result?.settings?.acl?.enabled;
    return typeof enabled === "boolean" ? enabled : null;
  } catch {
    return null;
  }
}

function approvalReason(proposal, reason, authorLabel) {
  return [
    `Publicar solo la propuesta ${proposal.id}.`,
    `Proyecto: ${proposal.project || "sin comprobar"}.`,
    `Fuente: sesión ${proposal.session || "sin comprobar"}, tramo ${proposal.segment || "sin comprobar"}.`,
    `Alcance: únicamente el proyecto ${proposal.project || "sin comprobar"}.`,
    `Autor registrado: ${authorLabel} (etiqueta configurada, no identidad verificada).`,
    `Motivo confirmado: ${reason}`,
  ].join("\n");
}

function decisionOutput() {
  return {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => [{ type: "text", text: [
      `**Estado:** ${value.status || "pending"}`,
      ...(value.reason ? [`**Motivo:** ${value.reason}`] : []),
    ].join("\n\n") }],
    presentationMeta: (_args, value) => ({
      id: value.proposalId || "",
      status: value.status || "pending",
      title: value.status === "published" ? "Propuesta publicada" : "Decisión de propuesta",
    }),
  };
}

function proposalOutput() {
  return {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => [{ type: "text", text: renderProposal(value) }],
    presentationMeta: (_args, value) => ({
      id: value.id || "",
      status: value.status || "pending",
      title: value.status === "reviewable"
        ? "Propuesta de memoria"
        : value.status === "question" ? "Pregunta para revisar" : "Propuesta pendiente de comprobación",
    }),
  };
}

function proposalView(result) {
  const title = result.meta?.title || "Propuesta de memoria";
  return {
    card: "generic",
    title,
    content: result.content.map(part => part.text || "").join("\n"),
  };
}

async function readEvidence(segment, candidateClient, approvedClient, signal, change = null) {
  const archiveUri = segment.archive?.uri;
  const diffUri = segment.extraction?.memoryDiffUri;
  if (!archiveUri || !diffUri) return { ok: false, reason: "source_or_extraction_reference_missing" };

  const archive = await readContent(candidateClient, `${archiveUri}/messages.jsonl`, signal, "original_archive");
  if (!archive.ok) return { ok: false, reason: "original_unavailable", failure: archive.failure };
  const diff = await readContent(candidateClient, diffUri, signal, "candidate_diff");
  if (!diff.ok) return { ok: false, reason: "candidate_diff_unavailable", failure: diff.failure };
  const operations = parseMemoryDiff(diff.value);
  if (!operations) return { ok: false, reason: "candidate_diff_incomplete" };
  const additions = operations.adds;
  if (additions.length !== 1 || typeof additions[0]?.uri !== "string") {
    return { ok: false, reason: "candidate_set_is_not_unambiguous" };
  }

  const candidateUri = additions[0].uri;
  const candidate = await readContent(candidateClient, candidateUri, signal, "candidate_memory");
  if (!candidate.ok || typeof candidate.value !== "string" || !candidate.value.trim()) {
    return {
      ok: false,
      reason: "candidate_unavailable",
      ...(candidate.failure ? { failure: candidate.failure } : {}),
    };
  }
  const candidateText = candidate.value.trim();
  const candidateAssertion = extractCandidateAssertion(candidateText);
  if (!candidateAssertion) {
    const filterProblem = await hasKnownSecret(candidateText);
    return {
      ok: false,
      reason: filterProblem || "candidate_assertion_not_unambiguous",
    };
  }

  const originalEvidence = findOriginalPassage(archive.value, candidateAssertion, segment.eventCoverage);
  const originalPassage = originalEvidence?.text;
  if (!originalPassage) {
    const filterProblem = await hasKnownSecret(candidateText);
    return {
      ok: false,
      reason: filterProblem || "original_passage_not_verified",
      ...(filterProblem ? {} : { safeAssertion: candidateAssertion }),
    };
  }

  const targets = approvedMemoryTargets({
    project: segment.projectId,
    source: { candidateUri },
  }, candidateClient, approvedClient);
  if (!targets) return { ok: false, reason: "project_scope_mismatch" };
  if (change) {
    return changeEvidence({ change, approvedClient, signal, candidateUri, candidateText, candidateAssertion, originalPassage });
  }
  let approvedPrevious = { status: "none", text: "" };
  for (const approvedUri of [targets.resourceUri, targets.peerUri]) {
    const approvedResponse = await approvedClient.fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(approvedUri)}`,
      {},
      { signal },
    );
    if (approvedResponse.ok) {
      if (typeof approvedResponse.result !== "string") {
        return {
          ok: false,
          reason: "approved_previous_unreadable",
          failure: await failureDetails("approved_memory", { ...approvedResponse, error: null }),
        };
      }
      approvedPrevious = { status: "found", text: stripApprovalRecord(approvedResponse.result) };
      break;
    }
    if (approvedResponse.status === 404 || approvedResponse.error?.code === "NOT_FOUND") continue;
    return {
      ok: false,
      reason: "approved_lookup_failed",
      failure: await failureDetails("approved_memory", approvedResponse),
    };
  }

  const filterProblem = await hasKnownSecret(candidateText, originalPassage, approvedPrevious.text);
  if (filterProblem) return { ok: false, reason: filterProblem };
  if (approvedPrevious.status === "found" && approvedPrevious.text.trim() !== candidateText) {
    return {
      ok: false,
      status: "question",
      reason: "possible_approved_contradiction",
      safeAssertion: candidateAssertion,
      originalPassage,
      approvedPrevious,
      question: `La afirmación extraída («${candidateAssertion}») contradice lo aprobado («${approvedPrevious.text}»). ¿Quieres revisar esta diferencia? No se ha modificado la memoria aprobada.`,
    };
  }
  if (approvedPrevious.status === "found") {
    return {
      ok: false,
      status: "question",
      reason: "already_approved_no_change",
      safeAssertion: candidateAssertion,
      originalPassage,
      approvedPrevious,
      question: "Esta afirmación ya está aprobada sin cambios. ¿Quieres cerrar la revisión sin preparar otra alta?",
    };
  }
  return {
    ok: true, candidateUri, candidateText, candidateAssertion, originalPassage, approvedPrevious,
    originalCreatedAt: originalEvidence.createdAt,
  };
}

/** Compare the verified candidate with the one approved memory the human named as the target. */
async function changeEvidence({
  change,
  approvedClient,
  signal,
  candidateUri,
  candidateText,
  candidateAssertion,
  originalPassage,
}) {
  const target = await readPublication(approvedClient, change.targetUri, signal);
  if (!target.ok) return { ok: false, reason: "approved_lookup_failed" };
  if (!target.exists) return { ok: false, reason: "change_target_not_approved" };

  const record = parseApprovalRecord(target.content);
  const body = stripApprovalRecord(target.content);
  const filterProblem = await hasKnownSecret(candidateText, originalPassage, target.content);
  if (filterProblem) return { ok: false, reason: filterProblem };

  const noChange = change.kind === "extend"
    ? normalizeText(body).includes(normalizeText(candidateAssertion))
    : change.kind === "replace" && normalizeText(body) === normalizeText(candidateText);
  if (noChange) {
    return {
      ok: false,
      status: "question",
      reason: "already_approved_no_change",
      safeAssertion: candidateAssertion,
      originalPassage,
      approvedPrevious: { status: "found", text: body },
      question: "La memoria aprobada ya dice lo mismo. ¿Quieres cerrar la revisión sin preparar el cambio?",
    };
  }
  const proposedText = change.kind === "retire"
    ? ""
    : change.kind === "extend" ? composeExtension(body, candidateAssertion) : candidateText;
  return {
    ok: true,
    candidateUri,
    candidateText,
    candidateAssertion,
    originalPassage,
    proposedText,
    approvedPrevious: { status: "found", text: body },
    change: {
      kind: change.kind,
      targetUri: change.targetUri,
      base: {
        hash: sha256(target.content),
        version: versionOf(record),
        proposalId: record?.proposalId || "",
        content: target.content,
      },
    },
  };
}

async function readContent(client, uri, signal, source) {
  try {
    const response = await client.fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
      {},
      { signal },
    );
    if (!response.ok || typeof response.result !== "string") {
      return { ok: false, failure: await failureDetails(source, response) };
    }
    return { ok: true, value: response.result };
  } catch (error) {
    return {
      ok: false,
      failure: {
        source,
        status: 0,
        code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
      },
    };
  }
}

async function failureDetails(source, response) {
  const status = Number.isInteger(response.status) ? response.status : 0;
  const code = typeof response.error?.code === "string"
    ? response.error.code
    : response.error?.aborted
      ? "TIMEOUT"
      : status === 0
        ? "NETWORK_ERROR"
        : response.ok
          ? "INVALID_RESPONSE"
          : "REQUEST_FAILED";
  const message = typeof response.error?.message === "string"
    ? response.error.message.replace(/\s+/gu, " ").trim().slice(0, 300)
    : "";
  const safeMessage = message && !(await hasKnownSecret(message)) ? message : "";
  return {
    source,
    status,
    code,
    ...(safeMessage ? { message: safeMessage } : {}),
    ...(response.traceId ? { traceId: response.traceId } : {}),
  };
}

function extractCandidateAssertion(candidateText) {
  const headings = [...candidateText.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)];
  let assertionText = candidateText;
  if (headings.length > 0) {
    const summaries = headings.filter(([, title]) => title.trim() === "Summary");
    if (summaries.length !== 1) return "";
    const summary = summaries[0];
    const start = summary.index + summary[0].length;
    const nextHeading = headings.find(heading => heading.index > summary.index);
    assertionText = candidateText.slice(start, nextHeading?.index ?? candidateText.length);
  }

  const lines = assertionText.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) return "";
  const assertion = lines[0];
  if (!/[.!?。！？]$/u.test(assertion) || /[.!?。！？]\s+\S/u.test(assertion.slice(0, -1))) return "";
  return assertion;
}

function hasCompleteAssertionBoundaries(source, start, assertion) {
  let contextStart = 0;
  for (let cursor = start - 1; cursor >= 0; cursor -= 1) {
    if (/[.!?。！？;\n:]/u.test(source[cursor])) {
      contextStart = cursor + 1;
      break;
    }
  }
  const before = source.slice(contextStart, start).trim();
  const nextCharacter = source[start + assertion.length];
  const afterBoundary = nextCharacter === undefined || /[\s"'”’)}\]]/u.test(nextCharacter);
  return before === "" && afterBoundary;
}

function findOriginalPassage(archive, candidateText, eventCoverage = []) {
  const sourceHashes = new Set(eventCoverage
    .map(event => event.sourceTextHash)
    .filter(hash => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)));
  if (sourceHashes.size === 0) return "";

  for (const { text, createdAt } of extractArchiveTexts(archive)) {
    if (!sourceHashes.has(createHash("sha256").update(text).digest("hex"))) continue;
    let matchIndex = text.indexOf(candidateText);
    while (matchIndex >= 0) {
      if (
        hasCompleteAssertionBoundaries(text, matchIndex, candidateText)
        && !hasNegationOutsideCandidate(text, matchIndex, candidateText)
      ) return { text, createdAt };
      matchIndex = text.indexOf(candidateText, matchIndex + 1);
    }
  }
  return "";
}

function hasNegationOutsideCandidate(source, candidateStart, candidateText) {
  const candidateEnd = candidateStart + candidateText.length;
  const sentenceStart = findPreviousSentenceBoundary(source, candidateStart);
  const sentenceEnd = findNextSentenceBoundary(source, candidateEnd);
  const context = [
    source.slice(sentenceStart, candidateStart),
    source.slice(candidateEnd, sentenceEnd),
  ].join(" ");
  return COMMON_NEGATION_PATTERN.test(context);
}

function findPreviousSentenceBoundary(text, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (/[.!?。！？;\n]/u.test(text[cursor])) return cursor + 1;
  }
  return 0;
}

function findNextSentenceBoundary(text, index) {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (/[.!?。！？;\n]/u.test(text[cursor])) return cursor;
  }
  return text.length;
}

function extractArchiveTexts(archive) {
  if (typeof archive !== "string") return [];
  const values = [];
  for (const line of archive.split(/\r?\n/u).filter(Boolean)) {
    try {
      const message = JSON.parse(line);
      const text = extractTextFromContent(message?.parts ?? message?.content ?? "");
      if (text) values.push({ text, createdAt: message.created_at });
    } catch {
      // Malformed archive rows cannot establish which DSH event they came from.
    }
  }
  return values;
}

async function hasKnownSecret(...values) {
  try {
    const { findKnownSecretFormats } = await import("./known-secret-filter.mjs");
    return values.some(value => findKnownSecretFormats(value).length > 0)
      ? "known_secret_format_detected"
      : "";
  } catch {
    return "secret_filter_unavailable";
  }
}

function segmentProblem(segment) {
  if (segment.archive?.status !== "confirmed") return "original_archive_not_confirmed";
  if (segment.extraction?.status !== "completed_non_empty") return "extraction_not_completed_non_empty";
  const coverage = Array.isArray(segment.eventCoverage) ? segment.eventCoverage : [];
  if (coverage.length === 0) return "event_coverage_missing";
  if (coverage.some(event => event.captureStatus !== "captured" || event.truncated)) return "event_coverage_incomplete";
  if (segment.capture?.status !== "captured" || segment.coverageStatus === "truncated") return "event_coverage_incomplete";
  return "";
}

function summarizeSegment(segment) {
  return {
    project: String(segment.projectId || ""),
    session: String(segment.dshSessionId || ""),
    segment: String(segment.segmentId || ""),
    archiveStatus: String(segment.archive?.status || "unknown"),
    extractionStatus: String(segment.extraction?.status || "unknown"),
    eventCount: Array.isArray(segment.eventCoverage) ? segment.eventCoverage.length : 0,
    coverageStatus: String(segment.coverageStatus || "unknown"),
  };
}

function summarizeCoverage(segment) {
  return {
    status: String(segment.capture?.status || "unknown"),
    coverageStatus: String(segment.coverageStatus || "unknown"),
    eventIds: Array.isArray(segment.coveredEventIds)
      ? segment.coveredEventIds.filter(Boolean)
      : (segment.eventCoverage || []).map(item => item.eventId).filter(Boolean),
    events: Array.isArray(segment.eventCoverage) ? segment.eventCoverage.map(item => ({
      eventId: item.eventId || "",
      eventType: item.eventType || "unknown",
      captureStatus: item.captureStatus || "unknown",
      truncated: Boolean(item.truncated),
    })) : [],
  };
}

function proposalMetadata(segment) {
  return {
    project: String(segment.projectId || ""),
    session: String(segment.dshSessionId || ""),
    openVikingSession: String(segment.openVikingSessionId || ""),
    segment: String(segment.segmentId || ""),
    coverage: summarizeCoverage(segment),
    assertion: "",
    originalPassage: "",
    approvedPrevious: { status: "unknown", text: "" },
    proposedText: "",
    question: "",
    failure: null,
    reasonSuggested: "",
    effect: "",
    filterNote: PENDING_FILTER_NOTE,
  };
}

function pendingProposal(fields) {
  return {
    project: "",
    session: "",
    openVikingSession: "",
    segment: "",
    coverage: { status: "unknown", coverageStatus: "unknown", eventIds: [], events: [] },
    assertion: "",
    originalPassage: "",
    approvedPrevious: { status: "unknown", text: "" },
    proposedText: "",
    question: "",
    failure: null,
    reasonSuggested: "",
    effect: "",
    filterNote: PENDING_FILTER_NOTE,
    ...fields,
  };
}

function renderProposal(proposal) {
  const lines = [
    `**Estado:** ${proposal.status || "pending"}`,
    `**Proyecto:** ${proposal.project || "sin comprobar"}`,
    `**Sesión:** ${proposal.session || "sin comprobar"}`,
    `**Tramo:** ${proposal.segment || "sin comprobar"}`,
    `**Afirmación:** ${proposal.assertion || "pendiente de comprobar"}`,
    `**Pasaje original comprobado:** ${proposal.originalPassage || "no disponible"}`,
    `**Cobertura:** ${proposal.coverage?.status || "sin comprobar"}; eventos ${proposal.coverage?.eventIds?.join(", ") || "no disponibles"}`,
    `**Aprobado anterior:** ${proposal.approvedPrevious?.status === "found" ? proposal.approvedPrevious.text : proposal.approvedPrevious?.status || "no comprobado"}`,
    ...(proposal.change ? [`**Cambio:** ${proposal.change.kind} sobre ${proposal.change.targetUri} (versión base ${proposal.change.base?.version})`] : []),
    ...(Array.isArray(proposal.sources) && proposal.sources.length > 1
      ? [`**Fuentes reunidas:** ${proposal.sources.map(item => `${item.session} / ${item.segment}`).join("; ")}`]
      : []),
    ...(proposal.reopens ? [`**Reabre un descarte anterior:** ${proposal.reopens.proposalId} · ${proposal.reopens.difference}`] : []),
    ...(proposal.reappearance ? [`**No vuelve a proponerse:** misma prueba que un descarte (${proposal.reappearance})`] : []),
    `**Texto propuesto:** ${proposal.change?.kind === "retire" ? "retirada: sale de la lectura normal y queda en historia" : proposal.proposedText || "no preparado"}`,
    `**Motivo sugerido:** ${proposal.reasonSuggested || "no disponible"}`,
    `**Efecto previsto:** ${proposal.effect || "no comprobado"}`,
    `**Pendiente:** ${proposal.pendingReason || "no"}`,
    ...(proposal.question ? [`**Pregunta para Sergi:** ${proposal.question}`] : []),
    ...(proposal.failure ? [`**Fallo de comprobación:** ${renderFailure(proposal.failure)}`] : []),
    `**Límite del filtro:** ${proposal.filterNote}`,
  ];
  return lines.join("\n\n");
}

function renderFailure(failure) {
  return [
    failure.source,
    failure.status ? `HTTP ${failure.status}` : "",
    failure.code,
    failure.message || "",
    failure.traceId ? `traza ${failure.traceId}` : "",
  ].filter(Boolean).join(" · ");
}

function proposalId(projectId, segmentId, candidateUri = "", change = "") {
  const source = (change ? [projectId, segmentId, candidateUri, change] : [projectId, segmentId, candidateUri]).join("\n");
  return `proposal-${createHash("sha256").update(source).digest("hex").slice(0, 20)}`;
}

class ProposalStore {
  constructor(path = join(stateDir(), PROPOSAL_FILE)) {
    this.path = path;
    this.pending = Promise.resolve();
  }

  async save(proposal) {
    const operation = this.pending.then(async () => {
      const records = await this.readAll();
      const next = records.filter(record => record.id !== proposal.id);
      next.push(proposal);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.pending = operation.catch(() => {});
    await operation;
  }

  async get(id) {
    await this.pending;
    return (await this.readAll()).find(record => record.id === id) || null;
  }

  async all() {
    await this.pending;
    return this.readAll();
  }

  async readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
