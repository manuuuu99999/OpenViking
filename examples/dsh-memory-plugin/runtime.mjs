import { createHash } from "node:crypto";

import { extractTextFromContent, isCaptureEnabled } from "./shared/capture-utils.mjs";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { buildRecallBlock, isRecallEnabled } from "./shared/recall-core.mjs";
import {
  dequeue,
  enqueue,
  listPending,
  replayPending,
} from "./shared/pending-queue.mjs";
import { isRetryableFailure } from "./shared/retryable.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";
import {
  captureEventDetails,
  isOpenVikingPluginMessage,
  pluginMessage,
  promptText,
} from "./capture.mjs";
import { deriveDshSessionId } from "./session-id.mjs";

export class OpenVikingRuntime {
  constructor(client, config, logger = console, resolveSessionPeer = null, { approvedClient = client } = {}) {
    this.client = client;
    this.readClient = approvedClient;
    this.config = config;
    this.logger = logger;
    this.resolveSessionPeer = resolveSessionPeer;
    this.states = new Map();
    this.drainTimer = null;
    this.drainRunning = false;
    this.drainPromise = Promise.resolve();
    this.drainHealth = null;
  }

  stateFor(session) {
    let state = this.states.get(session.id);
    if (state) return state;
    const cwd = session.header?.cwd || process.cwd();
    const peer = this.resolveSessionPeer?.(cwd) ?? resolveEffectivePeerId({
      cfg: {
        peerId: this.config.explicitPeerId,
        peerSource: this.config.peerSource,
        workspacePeer: this.config.workspacePeer,
        harness: this.config.harness,
      },
      cwd,
    });
    state = {
      dshSessionId: String(session.id),
      ovSessionId: deriveDshSessionId(session.id),
      config: { ...this.config, peerId: peer.peerId, legacyPeerId: peer.legacyPeerId },
      ready: false,
      profileBlock: "",
      profileDelivered: false,
      toolNames: new Map(),
      writes: Promise.resolve(),
      initializationRetryable: false,
      hasPendingWrites: false,
      pendingCreatedAt: 0,
      segmentSequence: 0,
      segments: [],
      currentSegment: null,
      disposing: null,
    };
    this.states.set(session.id, state);
    return state;
  }

  listProposalSegments() {
    return [...this.states.values()].flatMap(state => state.segments.map(segment => ({
      projectId: String(segment.projectId || ""),
      dshSessionId: state.dshSessionId,
      openVikingSessionId: state.ovSessionId,
      segmentId: segment.segmentId,
      coveredEventIds: segment.eventCoverage.map(item => item.eventId).filter(Boolean),
      eventCoverage: segment.eventCoverage.map(item => ({ ...item })),
      coverageStatus: segment.coverageStatus || "observed",
      capture: {
        status: summarizeCaptureStatus(segment.eventCoverage),
        capturedEvents: segment.eventCoverage.filter(item => item.captureStatus === "captured").length,
        pendingEvents: segment.eventCoverage.filter(item => item.captureStatus === "pending" || item.captureStatus === "pending_queue").length,
        truncatedEvents: segment.eventCoverage.filter(item => item.truncated).length,
      },
      archive: { ...segment.archive },
      extraction: { ...segment.extraction },
    })));
  }

  async findProposalSegment(segmentId) {
    return this.listProposalSegments().find(segment => segment.segmentId === segmentId) || null;
  }

  async initialize(agent) {
    const state = this.stateFor(agent.session);
    return this.ensureState(state);
  }

  async ensureState(state) {
    if (state.ready) return state;
    if (state.initializing) return state.initializing;
    state.initializing = this.initializeState(state).finally(() => {
      state.initializing = null;
    });
    return state.initializing;
  }

  async initializeState(state) {
    state.initializationRetryable = false;
    const health = await this.client.healthResult();
    if (!health.ok) {
      state.initializationRetryable = isRetryableFailure(health);
      return state;
    }
    const ensured = await this.client.ensureSessionResult(
      state.ovSessionId,
      state.config.peerId,
    );
    if (
      !ensured.ok
      && !(ensured.status === 409 && ensured.error?.code === "ALREADY_EXISTS")
    ) {
      state.initializationRetryable = isRetryableFailure(ensured);
      return state;
    }
    // Replay is a write, so it stays behind the same toggle: a backlog queued
    // while capture was on waits for a session that still writes.
    if (isCaptureEnabled(state.config)) {
      await this.replayPendingQueue();
    }
    await this.refreshPendingState(state);
    const profile = await buildProfileBlock(
      (path, init, options) => this.readClient.fetchJSON(path, init, options),
      state.config.profileTokenBudget,
      state.config.peerId,
      state.config,
    );
    state.profileBlock = profile?.block
      ? [
          '<openviking-context source="profile">',
          profile.block,
          "</openviking-context>",
        ].join("\n")
      : "";
    state.ready = true;
    return state;
  }

  async profileMessage(agent) {
    const state = await this.initialize(agent);
    if (!state.ready || !state.profileBlock || state.profileDelivered) return null;
    if (hasStartupProfile(agent)) {
      state.profileDelivered = true;
      return null;
    }
    state.profileDelivered = true;
    return pluginMessage(state.profileBlock, { form: "instructions" });
  }

  async recallMessage(agent, messages) {
    const state = await this.initialize(agent);
    if (!state.ready || !isRecallEnabled(state.config)) return null;
    const query = promptText(messages);
    if (!query || query.length < state.config.minQueryLength) return null;
    const block = await buildRecallBlock(
      (path, init, options) => this.readClient.fetchJSON(path, init, options),
      state.config,
      query,
      {
        actorPeerId: state.config.peerId,
        legacyPeerId: state.config.legacyPeerId,
        sessionId: state.ovSessionId,
        excludeUris: state.config.recallExcludeUris,
        log: (stage, data) => this.log(stage, data),
      },
    );
    return block ? pluginMessage(block, { form: "recall" }) : null;
  }

  capture(session, event) {
    const state = this.stateFor(session);
    const captured = captureEventDetails(event, state.config, state.toolNames);
    if (!captured.payload) return;

    const sourceText = extractTextFromContent(
      captured.payload.parts ?? captured.payload.content ?? "",
      { toolMaxChars: state.config.captureToolMaxChars },
    );
    const sourceTextHash = sourceText
      ? createHash("sha256").update(sourceText).digest("hex")
      : "";
    const segment = this.currentSegment(state);
    const coverage = this.addCoveredEvent(session, segment, event, captured.truncated, sourceTextHash);
    if (isUnattributedIsolatedSession(state.config)) {
      coverage.captureStatus = "pending_project";
      segment.pendingReason = "project_unassigned";
      this.emitSegmentTrace(state, segment);
      return;
    }
    if (!isCaptureEnabled(state.config)) {
      coverage.captureStatus = "disabled";
      segment.pendingReason = "capture_disabled";
      this.emitSegmentTrace(state, segment);
      return;
    }

    coverage.captureStatus = "pending";
    this.emitSegmentTrace(state, segment);
    this.enqueueWrite(state, async () => {
      try {
        if (state.hasPendingWrites) {
          const queued = await this.enqueuePendingMessage(state, captured.payload);
          coverage.captureStatus = queued.ok ? "pending_queue" : "failed";
          this.emitSegmentTrace(state, segment);
          return;
        }
        if (!state.ready && !(await this.ensureState(state)).ready) {
          if (state.initializationRetryable) {
            const queued = await this.enqueuePendingMessage(state, captured.payload);
            coverage.captureStatus = queued.ok ? "pending_queue" : "failed";
          } else {
            coverage.captureStatus = "failed";
            segment.pendingReason = "session_initialization_failed";
          }
          this.emitSegmentTrace(state, segment);
          return;
        }
        if (state.hasPendingWrites) {
          const queued = await this.enqueuePendingMessage(state, captured.payload);
          coverage.captureStatus = queued.ok ? "pending_queue" : "failed";
          this.emitSegmentTrace(state, segment);
          return;
        }
        const response = await this.client.addMessage(
          state.ovSessionId,
          captured.payload,
          state.config.peerId,
        );
        if (response.ok) {
          coverage.captureStatus = "captured";
        } else if (isRetryableFailure(response)) {
          const queued = await this.enqueuePendingMessage(state, captured.payload);
          coverage.captureStatus = queued.ok ? "pending_queue" : "failed";
        } else {
          coverage.captureStatus = "failed";
          segment.pendingReason = response.error?.code || "capture_write_failed";
        }
        this.emitSegmentTrace(state, segment);
      } catch (error) {
        coverage.captureStatus = "failed";
        segment.pendingReason = "capture_write_error";
        this.emitSegmentTrace(state, segment);
        throw error;
      }
    });
  }

  maybeCommit(session, event) {
    // DSH appends compaction/start before it summarizes and rewrites history,
    // so commit there regardless of the threshold, like PreCompact elsewhere.
    const boundary = event.type === "compaction/start";
    if (event.type !== "turn/end" && !boundary) return;
    const state = this.stateFor(session);
    const segment = state.currentSegment;
    if (isUnattributedIsolatedSession(state.config)) {
      if (segment) {
        segment.pendingReason = "project_unassigned";
        this.emitSegmentTrace(state, segment);
      }
      return;
    }
    if (!isCaptureEnabled(state.config)) return;
    this.enqueueWrite(state, async () => {
      if (state.hasPendingWrites) {
        if (segment) {
          segment.pendingReason = "capture_queue_not_replayed";
          this.emitSegmentTrace(state, segment);
        }
        return;
      }
      if (!state.ready && !(await this.ensureState(state)).ready) {
        if (segment) {
          segment.pendingReason = "session_initialization_failed";
          this.emitSegmentTrace(state, segment);
        }
        return;
      }
      if (!boundary) {
        const metadata = await this.client.getSession(
          state.ovSessionId,
          state.config.peerId,
        );
        const pendingTokens = Number(metadata?.pending_tokens || 0);
        if (pendingTokens < state.config.commitTokenThreshold) {
          if (segment) {
            segment.trigger = "threshold_check";
            segment.commitCheck = {
              status: "not_reached",
              pendingTokens,
              threshold: Number(state.config.commitTokenThreshold) || 0,
            };
            this.emitSegmentTrace(state, segment);
          }
          return;
        }
      }
      await this.commitSegment(state, segment, boundary ? "compaction" : "threshold");
    });
  }

  currentSegment(state) {
    if (state.currentSegment) return state.currentSegment;
    state.segmentSequence += 1;
    state.currentSegment = {
      segmentId: `${state.dshSessionId}:${state.segmentSequence}`,
      projectId: state.config.peerId || null,
      eventCoverage: [],
      captureStatus: "pending",
      pendingReason: null,
      trigger: null,
      commitCheck: null,
      archive: { status: "pending" },
      extraction: { status: "not_started" },
    };
    state.segments.push(state.currentSegment);
    return state.currentSegment;
  }

  addCoveredEvent(session, segment, event, truncated, sourceTextHash) {
    const reference = eventReference(session, event);
    const hasStableReference = reference.eventId !== null || reference.eventSequence !== null;
    const existing = hasStableReference
      ? segment.eventCoverage.find(item => (
          (reference.eventId && item.eventId === reference.eventId)
          || (reference.eventId === null && item.eventSequence === reference.eventSequence)
        ))
      : null;
    if (existing) return existing;
    const coverage = {
      ...reference,
      eventType: String(event?.type || "unknown"),
      captureStatus: "pending",
      truncated: Boolean(truncated),
      sourceTextHash,
    };
    segment.eventCoverage.push(coverage);
    if (truncated) segment.coverageStatus = "truncated";
    return coverage;
  }

  emitSegmentTrace(state, segment) {
    this.log("segment_trace", {
      projectId: segment.projectId,
      dshSessionId: state.dshSessionId,
      openVikingSessionId: state.ovSessionId,
      segmentId: segment.segmentId,
      trigger: segment.trigger,
      coveredEventIds: segment.eventCoverage.map(item => item.eventId).filter(Boolean),
      eventCoverage: segment.eventCoverage.map(({ sourceTextHash, ...item }) => ({ ...item })),
      coverageStatus: segment.coverageStatus || "observed",
      capture: {
        status: summarizeCaptureStatus(segment.eventCoverage),
        capturedEvents: segment.eventCoverage.filter(item => item.captureStatus === "captured").length,
        pendingEvents: segment.eventCoverage.filter(item => item.captureStatus === "pending" || item.captureStatus === "pending_queue").length,
        truncatedEvents: segment.eventCoverage.filter(item => item.truncated).length,
      },
      commitCheck: segment.commitCheck ? { ...segment.commitCheck } : null,
      pendingReason: segment.pendingReason,
      archive: { ...segment.archive },
      extraction: { ...segment.extraction },
    });
  }

  async commitSegment(state, segment, trigger, options = {}) {
    if (segment) {
      segment.trigger = trigger;
      segment.pendingReason = null;
      segment.archive = { status: "requesting" };
      this.emitSegmentTrace(state, segment);
    }
    const response = await this.client.commitSession(
      state.ovSessionId,
      state.config.peerId,
      options,
    );
    this.log(trigger === "compaction" ? "compaction_commit" : trigger === "session_close" ? "shutdown_commit" : "commit", {
      sessionId: state.ovSessionId,
      ok: response.ok,
      trace_id: response.result?.trace_id || response.traceId,
      error: response.ok ? undefined : response.error?.code,
    });
    if (segment) {
      if (response.ok) {
        const result = response.result || {};
        segment.archive = {
          status: result.archive_uri ? "confirmed" : "accepted_unconfirmed",
          uri: result.archive_uri || null,
        };
        const taskId = result.task_id || null;
        segment.extraction = taskId
          ? { status: "pending", taskId, taskStatus: "pending" }
          : { status: "not_started", reason: "task_id_missing" };
        this.emitSegmentTrace(state, segment);
        if (state.currentSegment === segment) state.currentSegment = null;
        if (taskId) {
          void this.observeExtractionTask(state, segment, taskId).catch(error => {
            segment.extraction = {
              ...segment.extraction,
              status: "unobserved",
              reason: "task_observation_error",
              errorName: error instanceof Error ? error.name : "Error",
            };
            this.emitSegmentTrace(state, segment);
          });
        }
      } else {
        segment.archive = {
          status: isRetryableFailure(response) ? "pending_retry" : "failed",
          errorCode: response.error?.code || null,
        };
        segment.extraction = { status: "not_started" };
        this.emitSegmentTrace(state, segment);
      }
    }
    if (isRetryableFailure(response)) {
      await this.enqueueFinalCommit(state, { keep_recent_count: 0 });
    }
    return response;
  }

  async observeExtractionTask(state, segment, taskId) {
    const timeoutMs = Number(this.config.extractionTrackingTimeoutMs) || 300000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.client.fetchJSON(
        `/api/v1/tasks/${encodeURIComponent(taskId)}`,
        {},
        { timeoutMs: Math.min(10000, Number(state.config.requestTimeoutMs) || 10000), actorPeerId: state.config.peerId },
      );
      if (!response.ok) {
        if (isRetryableFailure(response)) {
          segment.extraction = { ...segment.extraction, status: "pending", observationError: response.error?.code || "retryable_http_error" };
          this.emitSegmentTrace(state, segment);
          await wait(250);
          continue;
        }
        segment.extraction = {
          ...segment.extraction,
          status: "unobserved",
          reason: "task_lookup_failed",
          errorCode: response.error?.code || null,
        };
        this.emitSegmentTrace(state, segment);
        return;
      }

      const task = response.result || {};
      segment.extraction = { ...segment.extraction, taskStatus: task.status || "unknown" };
      if (["pending", "running", "cancelling"].includes(task.status)) {
        this.emitSegmentTrace(state, segment);
        await wait(250);
        continue;
      }
      if (task.status === "failed") {
        segment.extraction = { ...segment.extraction, status: "failed", errorCode: task.error_code || null };
        this.emitSegmentTrace(state, segment);
        return;
      }
      if (task.status === "cancelled") {
        segment.extraction = { ...segment.extraction, status: "cancelled" };
        this.emitSegmentTrace(state, segment);
        return;
      }
      if (task.status !== "completed") {
        segment.extraction = { ...segment.extraction, status: "unobserved", reason: "unknown_task_status" };
        this.emitSegmentTrace(state, segment);
        return;
      }

      const result = task.result || {};
      if (result.archive_uri && segment.archive.status !== "confirmed") {
        segment.archive = { status: "confirmed", uri: result.archive_uri };
      }
      if (isExtractionDisabled(result)) {
        segment.extraction = { status: "disabled", taskId, taskStatus: "completed", reason: result.memory_extraction?.skip_reason || "provider_disabled" };
        this.emitSegmentTrace(state, segment);
        return;
      }
      if (!result.memory_diff_uri) {
        segment.extraction = {
          status: "completed_unverified",
          taskId,
          taskStatus: "completed",
          reason: "memory_diff_missing",
          memoriesExtracted: result.memories_extracted ?? null,
        };
        this.emitSegmentTrace(state, segment);
        return;
      }
      const diffResponse = await this.client.fetchJSON(
        `/api/v1/content/read?uri=${encodeURIComponent(result.memory_diff_uri)}`,
        {},
        { timeoutMs: Math.min(10000, Number(state.config.requestTimeoutMs) || 10000), actorPeerId: state.config.peerId },
      );
      if (!diffResponse.ok) {
        segment.extraction = {
          status: "completed_unverified",
          taskId,
          taskStatus: "completed",
          reason: "memory_diff_unreadable",
          errorCode: diffResponse.error?.code || null,
        };
        this.emitSegmentTrace(state, segment);
        return;
      }
      const operations = countMemoryOperations(diffResponse.result);
      if (!operations) {
        segment.extraction = {
          status: "completed_unverified",
          taskId,
          taskStatus: "completed",
          reason: "memory_diff_invalid",
          memoryDiffUri: result.memory_diff_uri,
        };
        this.emitSegmentTrace(state, segment);
        return;
      }
      segment.extraction = {
        status: operations.adds + operations.updates + operations.deletes > 0
          ? "completed_non_empty"
          : "completed_empty",
        taskId,
        taskStatus: "completed",
        memoryDiffUri: result.memory_diff_uri,
        operations,
        memoriesExtracted: result.memories_extracted ?? null,
      };
      this.emitSegmentTrace(state, segment);
      return;
    }
    segment.extraction = { ...segment.extraction, status: "pending", reason: "task_observation_timeout" };
    this.emitSegmentTrace(state, segment);
  }

  dispose(session) {
    const state = this.states.get(session.id);
    if (!state) return;
    if (state.disposing) return state.disposing;
    state.disposing = (async () => {
      this.enqueueWrite(state, async () => {
        const segment = state.currentSegment;
        if (isUnattributedIsolatedSession(state.config)) {
          if (segment) {
            segment.pendingReason = "project_unassigned";
            this.emitSegmentTrace(state, segment);
          }
          return;
        }
        if (!isCaptureEnabled(state.config)) return;
        const commitPayload = { keep_recent_count: 0 };
        if (state.hasPendingWrites) {
          await this.enqueueFinalCommit(state, commitPayload);
          if (segment) {
            segment.archive = { status: "pending_queue" };
            segment.pendingReason = "capture_queue_not_replayed";
            this.emitSegmentTrace(state, segment);
          }
          return;
        }
        if (!state.ready && !(await this.ensureState(state)).ready) {
          if (segment) {
            segment.pendingReason = "session_initialization_failed";
            this.emitSegmentTrace(state, segment);
          }
          return;
        }
        await this.commitSegment(state, segment, "session_close", {
          timeoutMs: Math.min(3000, Number(state.config.requestTimeoutMs) || 3000),
        });
      });
      try {
        await state.writes;
      } finally {
        if (this.states.get(session.id) === state) this.states.delete(session.id);
      }
    })();
    return state.disposing;
  }

  async disposeAll() {
    await Promise.all([...this.states.values()].map(state => this.dispose({
      id: state.dshSessionId,
    })));
  }

  enqueueWrite(state, operation) {
    state.writes = state.writes
      .then(operation)
      .catch(error => this.log("write_error", {
        sessionId: state.ovSessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
  }

  async enqueuePending(state, type, payload) {
    const createdAt = Math.max(Date.now(), state.pendingCreatedAt + 1);
    state.pendingCreatedAt = createdAt;
    const result = await enqueue(type, state.ovSessionId, payload, { createdAt });
    if (result.ok) {
      // Log the latch transition only: every message that follows while the
      // latch holds takes the cheap enqueue path, so this fires once per
      // outage, not once per message.
      if (!state.hasPendingWrites) {
        this.log("pending_latched", { sessionId: state.ovSessionId, type });
      }
      state.hasPendingWrites = true;
    }
    if (!result.ok) {
      this.log("pending_enqueue_error", {
        sessionId: state.ovSessionId,
        type,
        error: result.error,
      });
    }
    return result;
  }

  async enqueueFinalCommit(state, payload) {
    await this.removePendingCommits(state);
    return this.enqueuePending(state, "commitSession", payload);
  }

  async enqueuePendingMessage(state, payload) {
    const result = await this.enqueuePending(state, "addMessage", payload);
    if (result.ok) await this.removePendingCommits(state);
    return result;
  }

  async removePendingCommits(state) {
    const pending = await listPending();
    for (const item of pending) {
      if (
        item.entry?.type === "commitSession"
        && item.entry.sessionId === state.ovSessionId
      ) {
        await dequeue(item.filename);
      }
    }
  }

  async refreshPendingState(state) {
    const wasPending = state.hasPendingWrites;
    const pending = (await listPending()).filter(
      item => item.entry?.sessionId === state.ovSessionId,
    );
    state.hasPendingWrites = pending.length > 0;
    state.pendingCreatedAt = pending.reduce(
      (latest, item) => Math.max(latest, Number(item.entry?.createdAt || 0)),
      state.pendingCreatedAt,
    );
    // Only the flip back to direct sends is logged: the recovery moment that
    // proves the drainer worked, once per outage.
    if (wasPending && !state.hasPendingWrites) {
      this.log("pending_cleared", { sessionId: state.ovSessionId });
    }
  }

  /**
   * Replay the pending queue through this runtime's client. The session-start
   * path calls it without options and keeps consuming retries; the drainer
   * passes consumeRetries:false so transient failures stay retryable.
   */
  async replayPendingQueue(options = {}) {
    await replayPending(
      (path, init) => this.client.fetchJSON(path, init),
      (stage, data) => this.log(stage, data),
      options,
    );
  }

  /**
   * One drainer tick, following the session-start replay flow: probe health
   * first and only replay when the server answers. Replays run without
   * consuming retry budgets, then every session's latch is re-derived from
   * the queue. An empty queue clears the latches with zero HTTP traffic, so
   * once a transient write failure recovers, capture and commit resume on
   * their own without restarting the long-lived dsh process.
   */
  async drainTick() {
    if (this.drainRunning) return;
    this.drainRunning = true;
    try {
      const pending = await listPending();
      if (pending.length > 0) {
        const health = await this.client.healthResult();
        if (!health.ok) {
          // Only the flip into the outage is logged, not every 60s probe.
          if (this.drainHealth !== false) {
            this.log("drain_health_down", { status: health.status || 0 });
          }
          this.drainHealth = false;
        } else {
          if (this.drainHealth === false) {
            this.log("drain_health_restored", {});
          }
          this.drainHealth = true;
          await this.replayPendingQueue({ consumeRetries: false });
        }
      }
      for (const state of this.states.values()) {
        await this.refreshPendingState(state);
      }
    } finally {
      this.drainRunning = false;
    }
  }

  /**
   * Start the background drainer. The interval is fixed per process; each tick
   * is single-flight, so a slow replay run never overlaps the next one.
   */
  startDrainer() {
    if (this.drainTimer) return this.drainTimer;
    const parsed = parseInt(process.env.OPENVIKING_PENDING_DRAIN_INTERVAL_MS || "", 10);
    const intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
    this.drainTimer = setInterval(() => {
      this.drainPromise = this.drainTick().catch(error => this.log("drain_error", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }, intervalMs);
    this.drainTimer.unref?.();
    return this.drainTimer;
  }

  stopDrainer() {
    if (!this.drainTimer) return;
    clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  async flush(session) {
    const state = this.states.get(session.id);
    if (state) await state.writes;
  }

  log(stage, data) {
    this.logger?.debug?.(`[openviking:dsh] ${stage} ${JSON.stringify(data)}`);
  }
}

function hasStartupProfile(agent) {
  const session = agent.session;
  const ownEvents = typeof session?.ownEvents === "function"
    ? session.ownEvents()
    : (session?.events || []).slice(session?.header?.seedLength ?? 0);
  const inHistory = ownEvents.some(event => (
    event?.type === "user/message" && isStartupProfile(event.data)
  ));
  if (inHistory) return true;
  return [agent.inbox?.nextTurn, agent.inbox?.nextStep].some(messages => (
    (messages || []).some(isStartupProfile)
  ));
}

function isStartupProfile(message) {
  return isOpenVikingPluginMessage(message)
    && message.source.form === "instructions";
}

function eventReference(session, event) {
  const eventId = event?.id == null || String(event.id).trim() === ""
    ? null
    : String(event.id);
  const events = Array.isArray(session?.events) ? session.events : [];
  let eventSequence = events.indexOf(event);
  if (eventSequence < 0 && eventId !== null) {
    eventSequence = events.findIndex(item => String(item?.id ?? "") === eventId);
  }
  return {
    eventId,
    eventSequence: eventSequence >= 0 ? eventSequence : null,
  };
}

function summarizeCaptureStatus(eventCoverage) {
  const statuses = eventCoverage.map(item => item.captureStatus);
  if (statuses.length === 0) return "no_events";
  if (statuses.includes("failed")) return "partial_failure";
  if (statuses.includes("pending_project")) return "pending_project";
  if (statuses.includes("pending") || statuses.includes("pending_queue")) return "pending";
  if (statuses.every(status => status === "disabled")) return "disabled";
  if (statuses.every(status => status === "captured")) return "captured";
  return "partial";
}

function isUnattributedIsolatedSession(config) {
  return Boolean(config?.memoryIsolation) && !String(config?.peerId || "").trim();
}

function isExtractionDisabled(result) {
  const extraction = result?.memory_extraction || result?.extraction || {};
  const skipReason = extraction.skip_reason || result?.extraction_skip_reason;
  return extraction.enabled === false
    || extraction.status === "disabled"
    || (Array.isArray(result?.effective_memory_types) && result.effective_memory_types.length === 0)
    || ["disabled", "provider_disabled", "memory_extraction_disabled"].includes(skipReason);
}

function countMemoryOperations(content) {
  let diff = content;
  if (typeof diff === "string") {
    try {
      diff = JSON.parse(diff);
    } catch {
      return null;
    }
  }
  if (!diff || typeof diff !== "object" || !diff.operations || typeof diff.operations !== "object") {
    return null;
  }
  const operations = diff.operations;
  if (!["adds", "updates", "deletes"].every(key => Array.isArray(operations[key]))) {
    return null;
  }
  return {
    adds: operations.adds.length,
    updates: operations.updates.length,
    deletes: operations.deletes.length,
  };
}

function wait(timeoutMs) {
  return new Promise(resolve => setTimeout(resolve, timeoutMs));
}
