import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { extractTextFromContent } from "./shared/capture-utils.mjs";
import { stateDir } from "./shared/workspace-identity.mjs";
import { parseMemoryDiff } from "./runtime.mjs";

const PROPOSAL_FILE = "review-proposals.json";
const PROPOSAL_TOOL_PREFIX = "openviking_";
const PENDING_FILTER_NOTE = "El filtro busca formatos conocidos de credenciales; no detecta todo texto sensible.";
const COMMON_NEGATION_PATTERN = /\b(?:no|not|never|neither|nor|none|nobody|nothing|without|cannot|can't|couldn't|didn't|doesn't|don't|isn't|aren't|wasn't|weren't|won't|wouldn't|mustn't|sin|nunca|jamás|tampoco|ningún|ninguna|ninguno|ningunos|ningunas|nadie|nada|ni)\b/iu;

/** Mount the separate DSH proposal surface; it never writes to OpenViking. */
export function mountProposalTools(ctx, { runtime, candidateClient, approvedClient }) {
  if (!runtime || !candidateClient || !approvedClient) {
    throw new TypeError("Proposal tools require the runtime, candidate client, and approved client.");
  }

  const store = new ProposalStore();
  const disposers = [
    ctx.tools.register(reviewTool({ runtime, candidateClient, approvedClient, store })),
  ];
  ctx.effect(
    () => () => disposers.reverse().forEach(dispose => dispose()),
    "openvikingMemory.disposeProposalTools()",
  );
  return store;
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

  const evidence = await readEvidence(segment, candidateClient, approvedClient, signal);
  if (!evidence.ok) {
    const pending = pendingProposal({
      ...proposalMetadata(segment),
      id: proposalId(segment.projectId, segment.segmentId),
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

  const proposal = {
    ...proposalMetadata(segment),
    id: proposalId(segment.projectId, segment.segmentId, evidence.candidateUri),
    status: "reviewable",
    assertion: evidence.candidateText,
    originalPassage: evidence.originalPassage,
    coverage: summarizeCoverage(segment),
    approvedPrevious: evidence.approvedPrevious,
    proposedText: evidence.candidateText,
    reasonSuggested: "La afirmación aparece en el pasaje original comprobado de una conversación nueva; Sergi debe decidir si quiere conservarla como conocimiento vigente.",
    effect: `Si se aprueba en un flujo futuro, el texto podría entrar en la búsqueda ordinaria de ${segment.projectId}; esta propuesta no publica ni modifica el aprobado.`,
    filterNote: "Se comprobaron formatos conocidos de credenciales. Esto no detecta todo texto sensible.",
    pendingReason: "",
  };
  await store.save(proposal);
  return proposal;
}

async function openProposal(store, id) {
  const proposal = await store.get(id);
  if (!proposal) {
    return pendingProposal({ id, status: "pending", pendingReason: "proposal_not_found" });
  }
  const secretFilterProblem = await hasKnownSecret(proposal.assertion, proposal.originalPassage, proposal.approvedPrevious?.text);
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

async function readEvidence(segment, candidateClient, approvedClient, signal) {
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
  const originalPassage = findOriginalPassage(archive.value, candidateText, segment.eventCoverage);
  if (!originalPassage) {
    const filterProblem = await hasKnownSecret(candidateText);
    return {
      ok: false,
      reason: filterProblem || "original_passage_not_verified",
      ...(filterProblem ? {} : { safeAssertion: candidateText }),
    };
  }

  const approvedResponse = await approvedClient.fetchJSON(
    `/api/v1/content/read?uri=${encodeURIComponent(candidateUri)}`,
    {},
    { signal },
  );
  let approvedPrevious = { status: "none", text: "" };
  if (approvedResponse.ok) {
    if (typeof approvedResponse.result !== "string") {
      return {
        ok: false,
        reason: "approved_previous_unreadable",
        failure: await failureDetails("approved_memory", { ...approvedResponse, error: null }),
      };
    }
    approvedPrevious = { status: "found", text: approvedResponse.result };
  } else if (approvedResponse.status !== 404 && approvedResponse.error?.code !== "NOT_FOUND") {
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
      safeAssertion: candidateText,
      originalPassage,
      approvedPrevious,
      question: `La afirmación extraída («${candidateText}») contradice lo aprobado («${approvedPrevious.text}»). ¿Quieres revisar esta diferencia? No se ha modificado la memoria aprobada.`,
    };
  }
  if (approvedPrevious.status === "found") {
    return {
      ok: false,
      status: "question",
      reason: "already_approved_no_change",
      safeAssertion: candidateText,
      originalPassage,
      approvedPrevious,
      question: "Esta afirmación ya está aprobada sin cambios. ¿Quieres cerrar la revisión sin preparar otra alta?",
    };
  }
  return { ok: true, candidateUri, candidateText, originalPassage, approvedPrevious };
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

function findOriginalPassage(archive, candidateText, eventCoverage = []) {
  const sourceHashes = new Set(eventCoverage
    .map(event => event.sourceTextHash)
    .filter(hash => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)));
  if (sourceHashes.size === 0) return "";

  for (const text of extractArchiveTexts(archive)) {
    if (!sourceHashes.has(createHash("sha256").update(text).digest("hex"))) continue;
    let matchIndex = text.indexOf(candidateText);
    while (matchIndex >= 0) {
      if (!hasNegationOutsideCandidate(text, matchIndex, candidateText)) return text;
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
      if (text) values.push(text);
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
    `**Texto propuesto:** ${proposal.proposedText || "no preparado"}`,
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

function proposalId(projectId, segmentId, candidateUri = "") {
  const source = [projectId, segmentId, candidateUri].join("\n");
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

  async readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
