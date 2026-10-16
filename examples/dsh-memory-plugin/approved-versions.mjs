import { createHash } from "node:crypto";

/**
 * Versioned approved memory (MAN-354).
 *
 * One approved memory is one file under `viking://resources/<project>/approved/memories/`.
 * A change never edits it in place without first copying the whole previous file to
 * `viking://resources/<project>/history/memories/`, readable only by the history identity.
 * The current file is then replaced (or deleted, for a retirement) in the same server-side
 * batch, only if it still has the reviewed bytes, so a normal read sees either the previous
 * version or the next one, never a mixture, and a moved base is refused (O2).
 */

export const APPROVAL_SCHEMA = "openviking.dsh.approval.v1";
const HISTORY_SCHEMA = "openviking.dsh.history.v1";
const APPROVAL_OPEN = "<!-- openviking-approval:v1\n";
const HISTORY_OPEN = "<!-- openviking-history:v1\n";
const RECORD_CLOSE = "\n-->";

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export function normalizeText(text) {
  return String(text || "").replace(/\s+/gu, " ").trim();
}

function parseRecord(content, open, schema) {
  if (typeof content !== "string" || !content.startsWith(open)) return null;
  const end = content.indexOf(RECORD_CLOSE, open.length);
  if (end < 0) return null;
  try {
    const record = JSON.parse(content.slice(open.length, end));
    return record?.schema === schema ? record : null;
  } catch {
    return null;
  }
}

export function parseApprovalRecord(content) {
  return parseRecord(content, APPROVAL_OPEN, APPROVAL_SCHEMA);
}

export function parseHistoryRecord(content) {
  return parseRecord(content, HISTORY_OPEN, HISTORY_SCHEMA);
}

export function contentWithApprovalRecord(text, record) {
  return `${APPROVAL_OPEN}${JSON.stringify(record)}\n-->\n\n${text}`;
}

/** The memory text without its approval record, as a reader should see it. */
export function stripApprovalRecord(content) {
  return String(content || "").replace(/^<!-- openviking-approval:v1\n[\s\S]*?\n-->\s*/u, "").trim();
}

/** Records written before versions existed (MAN-353 altas) are version 1. */
export function versionOf(record) {
  return Number.isInteger(record?.change?.version) && record.change.version > 0 ? record.change.version : 1;
}

export function approvedMemoryPrefix(project) {
  return `viking://resources/${encodeURIComponent(project)}/approved/memories/`;
}

/** The URI itself when it names an approved memory file of this project, otherwise null. */
export function validateChangeTarget(project, uri) {
  if (typeof uri !== "string" || !project) return null;
  const prefix = approvedMemoryPrefix(project);
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  if (!rest || /[?#\\]/u.test(rest) || rest.endsWith("/")) return null;
  if (rest.split("/").some(part => !part || part === "." || part === "..")) return null;
  return uri;
}

/** `approved/memories/a/b.md` at version 3 for decision D becomes `history/memories/a/b.v3.D.md`. */
export function historyUriFor(approvedUri, version, decisionId) {
  const marker = "/approved/memories/";
  const index = approvedUri.indexOf(marker);
  const head = approvedUri.slice(0, index);
  const path = approvedUri.slice(index + marker.length);
  const stem = path.replace(/\.md$/u, "");
  return `${head}/history/memories/${stem}.v${version}.${decisionId}.md`;
}

/** Combine the approved text with one new verified assertion into a self-sufficient memory. */
export function composeExtension(baseBody, assertion) {
  return `${String(baseBody).trimEnd()}\n\n# Extension\n${assertion}`;
}

export function sourcesOf(proposal) {
  if (Array.isArray(proposal.sources) && proposal.sources.length > 0) return proposal.sources;
  return [{
    session: proposal.session,
    segment: proposal.segment,
    archiveUri: proposal.source?.archiveUri || "",
    candidateUri: proposal.source?.candidateUri || "",
    eventIds: proposal.coverage?.eventIds || [],
  }];
}

/**
 * Everything a publication must write, decided once at approval time and stored with the
 * proposal so that a retry completes exactly what the human confirmed.
 */
export function buildChangeIntent(proposal, { reason, authorLabel, approvedAt, approvedUser }) {
  const { kind, targetUri, base } = proposal.change;
  const decisionId = proposal.id;
  const sources = sourcesOf(proposal).map(source => ({ ...source }));
  const version = base.version + 1;
  const historyUri = historyUriFor(targetUri, base.version, decisionId);
  const decision = {
    proposalId: decisionId,
    kind,
    approvedAt,
    authorLabel,
    authorLabelIsConfigured: true,
    reason,
    source: sources[0],
    sources,
    supersededByVersion: kind === "retire" ? null : version,
  };
  const historyRecord = {
    schema: HISTORY_SCHEMA,
    project: proposal.project,
    approvedUri: targetUri,
    version: base.version,
    contentHash: base.hash,
    decision,
  };
  const approvalRecord = {
    schema: APPROVAL_SCHEMA,
    proposalId: decisionId,
    authorLabel,
    authorLabelIsConfigured: true,
    approvedAt,
    project: proposal.project,
    scope: `project:${proposal.project}`,
    source: sources[0],
    sources,
    reason,
    change: {
      kind,
      version,
      targetUri,
      previous: {
        version: base.version,
        proposalId: base.proposalId,
        contentHash: base.hash,
        historyUri,
      },
    },
  };
  return {
    decisionId,
    kind,
    targetUri,
    historyUri,
    baseHash: base.hash,
    approvalRecord,
    currentAcl: { acl_mode: "restricted", entries: [{ principal: `user:${approvedUser}`, level: "read" }] },
    historyContent: `${HISTORY_OPEN}${JSON.stringify(historyRecord)}\n-->\n\n${base.content}`,
    newContent: kind === "retire" ? null : contentWithApprovalRecord(proposal.proposedText, approvalRecord),
  };
}

export async function readPublication(client, uri, signal, source = "approved_memory") {
  try {
    const response = await client.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`, {}, { signal });
    if (response.ok && typeof response.result === "string") return { ok: true, exists: true, content: response.result };
    if (!response.ok && response.status === 404) return { ok: true, exists: false };
    return {
      ok: false,
      exists: false,
      failure: {
        source,
        status: response.status || 0,
        code: response.error?.code || (response.error?.aborted
          ? "TIMEOUT"
          : response.status === 0 ? "NETWORK_ERROR" : response.ok ? "INVALID_RESPONSE" : "REQUEST_FAILED"),
      },
    };
  } catch (error) {
    return {
      ok: false,
      exists: false,
      failure: { source, status: 0, code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR" },
    };
  }
}

/**
 * Where a change stands on the server: finished, ready to apply (from scratch or resuming
 * after the history copy was written), or no longer applicable because the base moved.
 */
export async function inspectChange({ approvedClient, historyClient, proposal, signal }) {
  const { kind, targetUri, base } = proposal.change;
  const current = await readPublication(approvedClient, targetUri, signal);
  const historyUri = historyUriFor(targetUri, base.version, proposal.id);
  const history = await readPublication(historyClient, historyUri, signal, "history_memory");
  if (!current.ok || !history.ok) return { state: "check_failed", failure: current.failure || history.failure };

  const historyRecord = history.exists ? parseHistoryRecord(history.content) : null;
  const historyIsOurs = historyRecord?.decision?.proposalId === proposal.id;
  if (history.exists && !historyIsOurs) return { state: "history_conflict", historyUri };

  if (!current.exists) {
    return kind === "retire" && historyIsOurs
      ? { state: "completed", historyUri, record: historyRecord.decision }
      : { state: "base_changed" };
  }
  const record = parseApprovalRecord(current.content);
  if (kind !== "retire" && record?.proposalId === proposal.id) {
    return { state: "completed", historyUri, record };
  }
  if (sha256(current.content) !== base.hash) return { state: "base_changed" };
  return { state: "ready", historyUri, historyExists: history.exists };
}

/**
 * Apply a stored intent as ONE conditional batch on the server: the whole previous version
 * goes to history, then the current memory is replaced (or deleted, for a retirement) only if
 * its bytes still hash to the version the human reviewed. The server checks that hash and
 * performs every write while it holds the lock on both files, orders the history copy first,
 * and refuses the whole batch with a conflict when the base moved. There is no fallback to
 * separate unconditional writes: any answer other than success is a failed publication.
 */
export async function applyChange({ publisherClient, historyUser, intent, signal }) {
  const marker = "/approved/memories/";
  const rootUri = intent.targetUri.slice(0, intent.targetUri.indexOf(marker));
  const operations = [{
    uri: intent.historyUri,
    content: intent.historyContent,
    mode: "create",
    acl: { acl_mode: "restricted", entries: [{ principal: `user:${historyUser}`, level: "read" }] },
  }];
  operations.push(intent.kind === "retire"
    ? { uri: intent.targetUri, mode: "delete", expected_sha256: intent.baseHash }
    : {
      uri: intent.targetUri,
      content: intent.newContent,
      mode: "replace",
      expected_sha256: intent.baseHash,
      acl: intent.currentAcl,
    });
  return sendConditionalBatch(publisherClient, rootUri, operations, signal);
}

/** An absent retired file needs one safe server pass to finish index and reference cleanup. */
export async function reconcileRetirement({ publisherClient, targetUri, baseHash, signal }) {
  const rootUri = targetUri.slice(0, targetUri.indexOf("/approved/memories/"));
  return sendConditionalBatch(publisherClient, rootUri, [{
    uri: targetUri,
    mode: "reconcile_delete",
    expected_sha256: baseHash,
  }], signal);
}

async function sendConditionalBatch(client, rootUri, operations, signal) {
  try {
    const response = await client.fetchJSON("/api/v1/content/batch-write", {
      method: "POST",
      body: JSON.stringify({ root_uri: rootUri, operations, wait: true }),
    }, { signal });
    if (response.ok) return { ok: true };
    return { ok: false, stage: "publish", status: response.status || 0, code: response.error?.code || "" };
  } catch {
    return { ok: false, stage: "publish", status: 0, code: "NETWORK_ERROR" };
  }
}