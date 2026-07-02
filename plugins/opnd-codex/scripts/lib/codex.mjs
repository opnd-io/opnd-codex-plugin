/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   finalizingPhaseTimer: ReturnType<typeof setTimeout> | null,
 *   finalizingStartedAt: number | null,
 *   finalizingTimeoutMs: number,
 *   watchdogTimer: ReturnType<typeof setTimeout> | null,
 *   watchdogMs: number | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { clearBrokerSession, loadBrokerSession, teardownBrokerSession } from "./broker-lifecycle.mjs";
import {
  SKIP_REASON_RETRY_BUDGET_EXCEEDED,
  SKIP_REASON_TIMEOUT,
  classifyCodexSkipReason,
  withCodexSkipMetadata
} from "./codex-skip-taxonomy.js";
import { binaryAvailable } from "./process.mjs";
import { withBrokerLockAsync } from "./state.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
// Cap notifications buffered before the initial turn id is known. Drops the oldest entry on
// overflow so a stuck startRequest cannot grow the queue without bound.
const MAX_BUFFERED_NOTIFICATIONS = 4096;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
// PR-1.3 (#183) — bound the "finalizing" phase so a hung spark-model turn or
// cancel-without-interrupt cannot leave the job pinned at status=running forever.
// Override via CODEX_FINALIZING_PHASE_TIMEOUT_MS for slow CI / sandboxed reviews.
const FINALIZING_PHASE_TIMEOUT_MS = (() => {
  const override = Number(process.env.CODEX_FINALIZING_PHASE_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return 5 * 60 * 1000;
})();

// A2 fix (docs/code-review/2026-05-20-pair-readiness-adversarial.md) — the
// per-turn inactivity watchdog now defaults ON. It measures SILENCE between
// JSON-RPC notifications (not total turn time), so a generous 10 min default
// never trips a healthy turn (which emits progress continuously) yet still
// bounds a fully-stuck broker. Override via CODEX_TURN_WATCHDOG_MS (ms);
// set 0 to disable. An explicit `watchdogMs` option still wins over both.
const DEFAULT_TURN_WATCHDOG_MS = 10 * 60 * 1000;
const TIMEOUT_RESUME_PROMPT = "도구 사용 금지, 즉시 최종 출력";
const DEFAULT_TIMEOUT_RESUME_TIMEOUT_MS = 90_000;
function resolveDefaultTurnWatchdogMs() {
  const override = Number(process.env.CODEX_TURN_WATCHDOG_MS);
  if (Number.isFinite(override) && override >= 0) {
    return override > 0 ? override : null;
  }
  return DEFAULT_TURN_WATCHDOG_MS;
}

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

// PR-2.1 (#240 / #167 / #304) BREAKING — omit `sandbox` from thread/start +
// thread/resume requests when the caller did not explicitly pass one, so the
// app-server falls back to whatever the user configured in ~/.codex/config.toml.
// The previous code injected sandbox:"read-only" unconditionally and that
// hard-coded value silently overrode user config (bwrap failures on Linux,
// .git/ EPERM on macOS, git push DNS errors when --write was active, etc.).
//
// Legacy v1.0.x behavior can be restored by setting:
//   CODEX_PLUGIN_SANDBOX_DEFAULT=read-only     (review / non-write paths)
// callers that need a hard-coded sandbox can still pass options.sandbox.
function pickSandboxDefault(env = process.env) {
  const explicit = env.CODEX_PLUGIN_SANDBOX_DEFAULT;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  return null;
}

function resolveSandboxValue(options) {
  if (options.sandbox != null && String(options.sandbox).length > 0) {
    return options.sandbox;
  }
  return pickSandboxDefault(options.env ?? process.env);
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  const params = {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
  const sandbox = resolveSandboxValue(options);
  if (sandbox != null) {
    params.sandbox = sandbox;
  }
  return params;
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  const params = {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never"
  };
  const sandbox = resolveSandboxValue(options);
  if (sandbox != null) {
    params.sandbox = sandbox;
  }
  return params;
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}, state = null) {
  if (state) {
    armFinalizingPhaseTimerIfNeeded(state, phase);
  }
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  // Note: log-event paths that carry phase="finalizing" should still arm the
  // finalizing gate via the parallel emitProgress call sites (see callers that
  // pass state). Keep this helper purely log-shaped to avoid coupling.
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/**
 * Per-turn inactivity watchdog (manual port of upstream PR #312).
 *
 * fork v2.1.0 already bounds the `finalizing` phase (PR-1.3 #183, 5 min
 * default), but the full turn lifecycle had no general silence guard —
 * a broker that stops emitting JSON-RPC notifications mid-turn (stuck
 * `app-server`, dropped TCP keepalive, hung MCP tool call) would leave
 * `captureTurn` hanging forever. This watchdog arms when the turn begins
 * and is kicked forward by every notification; if `watchdogMs` of silence
 * passes the turn fails fast with exit 124 (matching `timeout(1)`).
 *
 * Triggers: opt-in via `runAppServerTurn({ watchdogMs })` or env
 * `CODEX_TURN_WATCHDOG_MS`. Closes upstream issue #49 (background task
 * hangs indefinitely — no timeout on Codex API response generation) and
 * partial-fixes #250 (MCP elicitation hang) by giving the watch loop a
 * deterministic upper bound. See docs/upstream-tracking/2026-05-18-...
 * Tier 1 Group B for the audit trail.
 */
export class TurnWatchdogError extends Error {
  /**
   * @param {string} message
   * @param {{ watchdogMs?: number | null, threadId?: string | null, turnId?: string | null }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    const { watchdogMs, threadId, turnId } = options;
    this.name = "TurnWatchdogError";
    this.code = "TURN_WATCHDOG_TIMEOUT";
    this.exitCode = 124;
    this.watchdogMs = watchdogMs ?? null;
    this.threadId = threadId ?? null;
    this.turnId = turnId ?? null;
    this.skipReason = SKIP_REASON_TIMEOUT;
    this.retryInfo = {
      skipReason: SKIP_REASON_TIMEOUT,
      threadId: this.threadId,
      turnId: this.turnId,
      watchdogMs: this.watchdogMs,
      resumeAttempts: 0
    };
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    finalizingPhaseTimer: null,
    finalizingStartedAt: null,
    finalizingTimeoutMs: options.finalizingTimeoutMs ?? FINALIZING_PHASE_TIMEOUT_MS,
    watchdogTimer: null,
    watchdogMs:
      typeof options.watchdogMs === "number" && options.watchdogMs > 0
        ? options.watchdogMs
        : null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearFinalizingPhaseTimer(state) {
  if (state.finalizingPhaseTimer) {
    clearTimeout(state.finalizingPhaseTimer);
    state.finalizingPhaseTimer = null;
  }
}

function armFinalizingPhaseTimerIfNeeded(state, phase) {
  if (phase !== "finalizing" || state.completed || state.finalizingPhaseTimer) {
    return;
  }
  // Disable when caller sets a non-positive timeout. Useful for tests that
  // intentionally exercise long-running finalizing flows without firing the gate.
  if (!Number.isFinite(state.finalizingTimeoutMs) || state.finalizingTimeoutMs <= 0) {
    return;
  }
  state.finalizingStartedAt = Date.now();
  state.finalizingPhaseTimer = setTimeout(() => {
    state.finalizingPhaseTimer = null;
    if (state.completed) {
      return;
    }
    const seconds = Math.round(state.finalizingTimeoutMs / 1000);
    failTurn(
      state,
      new Error(
        `Codex turn stuck in phase=finalizing for ${seconds}s without producing a final turn. ` +
          `Aborting to release the running state.`
      )
    );
  }, state.finalizingTimeoutMs);
  state.finalizingPhaseTimer.unref?.();
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

// Watchdog helpers (manual port of upstream PR #312). `armWatchdog` is
// only effective when `state.watchdogMs > 0`; otherwise all three helpers
// are no-ops, preserving fork v2.1.0 behavior when the opt-in env var
// `CODEX_TURN_WATCHDOG_MS` or the `watchdogMs` option is not set.
function disarmWatchdog(state) {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

function armWatchdog(state) {
  if (!state.watchdogMs || state.completed) {
    return;
  }
  disarmWatchdog(state);
  state.watchdogTimer = setTimeout(() => {
    state.watchdogTimer = null;
    if (state.completed) {
      return;
    }
    state.completed = true;
    clearCompletionTimer(state);
    clearFinalizingPhaseTimer(state);
    const message =
      `Codex turn watchdog fired after ${state.watchdogMs}ms of silence ` +
      `(thread ${state.threadId}, turn ${state.turnId ?? "pending"}). ` +
      `No JSON-RPC notification arrived in that window.`;
    state.rejectCompletion(
      new TurnWatchdogError(message, {
        watchdogMs: state.watchdogMs,
        threadId: state.threadId,
        turnId: state.turnId
      })
    );
  }, state.watchdogMs);
  state.watchdogTimer.unref?.();
}

function kickWatchdog(state) {
  if (!state.watchdogMs || state.completed) {
    return;
  }
  armWatchdog(state);
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  clearFinalizingPhaseTimer(state);
  disarmWatchdog(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    // completeTurn was just called so finalizingPhaseTimer is already cleared;
    // it is safe to call emitProgress without state-side arming here.
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function failTurn(state, error) {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  clearFinalizingPhaseTimer(state);
  state.completed = true;
  state.rejectCompletion?.(error);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        if (item.phase === "final_answer") {
          armFinalizingPhaseTimerIfNeeded(state, "finalizing");
        }
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      armFinalizingPhaseTimerIfNeeded(state, "finalizing");
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null, {}, state);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null, {}, state);
      }
      break;
    case "error": {
      const codexErr = message.params.error;
      state.error = codexErr;
      emitProgress(state.onProgress, `Codex error: ${codexErr.message}`, "failed");
      // Without settling, captureTurn()'s `await state.completion` hangs forever when the
      // app-server emits a terminal error without a subsequent `turn/completed`.
      const wrapped = Object.assign(
        new Error(`Codex app-server error: ${codexErr.message ?? "unknown"}`),
        { cause: codexErr, code: codexErr.code ?? null }
      );
      failTurn(state, wrapped);
      break;
    }
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

// Overlapping captureTurn() calls on the same client must restore the
// notification handler correctly even when they finish out of LIFO order.
// A single save/restore slot clobbers a still-active sibling capture when an
// earlier one finishes first. Track handlers as a per-client stack instead:
// the active handler is always the stack top, and a finished capture removes
// itself by identity rather than blindly reinstating its captured predecessor.
const notificationHandlerStacks = new WeakMap();

function pushNotificationHandler(client, handler) {
  let stack = notificationHandlerStacks.get(client);
  if (!stack) {
    // Seed index 0 with the handler already installed so the final pop
    // restores the original base handler rather than null.
    stack = [client.notificationHandler ?? null];
    notificationHandlerStacks.set(client, stack);
  }
  stack.push(handler);
  client.setNotificationHandler(handler);
}

function popNotificationHandler(client, handler) {
  const stack = notificationHandlerStacks.get(client);
  if (!stack) {
    client.setNotificationHandler(null);
    return;
  }
  const index = stack.lastIndexOf(handler);
  // index 0 is the seeded base handler — never splice it out.
  if (index > 0) {
    stack.splice(index, 1);
  }
  client.setNotificationHandler(stack[stack.length - 1] ?? null);
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  const turnNotificationHandler = (message) => {
    // Manual port of upstream PR #312 — every JSON-RPC notification kicks
    // the inactivity watchdog forward. Opt-in (no-op when watchdogMs unset).
    kickWatchdog(state);

    if (!state.turnId) {
      // Bound the buffered-notification queue. If startRequest never returns a turn id
      // (e.g., a stuck app-server), the buffer would otherwise grow without limit.
      if (state.bufferedNotifications.length >= MAX_BUFFERED_NOTIFICATIONS) {
        state.bufferedNotifications.shift();
      }
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    applyTurnNotification(state, message);
  };
  pushNotificationHandler(client, turnNotificationHandler);

  try {
    armWatchdog(state);
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    disarmWatchdog(state);
    popNotificationHandler(client, turnNotificationHandler);
  }
}

async function withAppServer(cwd, fn, options = {}) {
  // PR-5.5 (#251) — when the caller selected a Codex profile, the only
  // codex-cli invocation path that picks it up is the direct-spawn one
  // (BrokerCodexAppServerClient talks to a pre-existing app-server whose
  // profile was fixed at broker spawn). Force a direct spawn so the user's
  // --profile takes effect for this single command. Multi-command broker
  // sharing for the same profile remains unchanged.
  const wantsProfile = typeof options.profile === "string" && options.profile.trim().length > 0;
  const wantsFast = Boolean(options.fast);
  // PR-7.6 (#210) — fast tier is a per-invocation knob, so force a direct
  // codex spawn (broker bypass) when requested. Sharing a broker between
  // a fast and non-fast caller would silently apply the first tier choice
  // to both.
  // #21 — when the caller is a subagent (requireBroker), it cannot host a
  // survivable app-server. We must route through a pre-existing broker and
  // NEVER fall back to a direct/in-process spawn: that direct spawn would live
  // in the subagent's kill-on-close Job Object and die at turn end. So the
  // profile/fast broker-bypass is disabled and the busy/connection retry-direct
  // path is suppressed (handleTask rejects profile/fast for subagents upstream).
  const requireBroker = options.requireBroker === true;
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      serverRequestHandler: options.serverRequestHandler,
      profile: options.profile,
      fast: options.fast,
      // spawn 되는 codex 자식용 per-invocation env override(선택). direct-spawn
      // 경로만 소비(SpawnedCodexAppServerClient 가 `options.env ?? process.env`
      // 사용) — 기존 caller 는 아무것도 안 넘겨 no-op. transfer 플로우가 공유
      // default CODEX_HOME 을 강제해 import 가 사용자 Codex App 에 보이게 할 때 사용.
      env: options.env,
      requireExistingBroker: requireBroker,
      disableBroker: !requireBroker && (wantsProfile || wantsFast || options.disableBroker === true)
    });
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      !requireBroker &&
      ((options.retryDirectOnBusy !== false && client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
        (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED")));

    if (client) {
      // Teardown best-effort: a failed close has no recovery path and must
      // not mask the primary turn error/result being propagated.
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      // #21 — under requireBroker a BUSY shared broker is suppressed from the
      // direct-retry path above, but a raw throw would surface in the
      // codex-rescue foreground path as a non-zero exit that the agent hides as
      // "Codex was not invoked", losing the actionable retry hint. Re-tag it so
      // handleTask surfaces the diagnostic on stdout (like the no-broker case).
      if (requireBroker && error?.rpcCode === BROKER_BUSY_RPC_CODE) {
        throw Object.assign(
          new Error(
            "The shared Codex broker is busy with another task, and this codex-rescue subagent cannot fall back to a " +
              "direct spawn (it would not survive the subagent's Job Object teardown — #21). Retry shortly (the broker " +
              "serves one task at a time), or re-run from the main Claude thread."
          ),
          { code: "SUBAGENT_BROKER_BUSY" }
        );
      }
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      profile: options.profile,
      fast: options.fast,
      env: options.env,
      serverRequestHandler: options.serverRequestHandler
    });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

export function resolveTimeoutResumeRetryBudget(env = process.env) {
  const raw = env?.CODEX_PLUGIN_TIMEOUT_RESUME_RETRY_BUDGET;
  if (raw == null || raw === "") {
    return 1;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.max(0, Math.min(2, Math.trunc(parsed)));
}

function resolveTimeoutResumeTimeoutMs(options = {}) {
  const timeoutMs = Number(options.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  return DEFAULT_TIMEOUT_RESUME_TIMEOUT_MS;
}

export function buildTimeoutResumeCommand(threadId, prompt = TIMEOUT_RESUME_PROMPT) {
  const normalizedThreadId = String(threadId ?? "").trim();
  if (!normalizedThreadId) {
    throw new Error("threadId is required to resume a timed-out Codex thread.");
  }
  return {
    command: "codex",
    args: ["exec", "resume", normalizedThreadId, prompt]
  };
}

export async function resumeTimedOutThread(threadId, options = {}) {
  const { command, args } = buildTimeoutResumeCommand(threadId, options.prompt ?? TIMEOUT_RESUME_PROMPT);
  const timeoutMs = resolveTimeoutResumeTimeoutMs(options);
  const spawnImpl = options.spawnImpl ?? spawn;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer = null;
    let child = null;

    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({
        threadId,
        command,
        args,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
        ...result
      });
    };

    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      settle({
        status: 1,
        exitCode: null,
        signal: null,
        timedOut: false,
        error
      });
      return;
    }

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr += String(chunk);
    });

    timer = setTimeout(() => {
      const error = withCodexSkipMetadata(
        new Error(`Codex timeout resume command timed out after ${timeoutMs}ms for thread ${threadId}.`),
        SKIP_REASON_TIMEOUT,
        {
          threadId,
          retryInfo: {
            resumeTimeoutMs: timeoutMs
          }
        }
      );
      error.code = "CODEX_TIMEOUT_RESUME_TIMEOUT";
      error.exitCode = 124;
      try {
        child?.kill?.("SIGTERM");
      } catch {
        // Best effort only; the timeout result below is the contract.
      }
      settle({
        status: 124,
        exitCode: 124,
        signal: "SIGTERM",
        timedOut: true,
        error
      });
    }, timeoutMs);
    timer.unref?.();

    child.on?.("error", (error) => {
      settle({
        status: 1,
        exitCode: null,
        signal: null,
        timedOut: false,
        error
      });
    });
    child.on?.("close", (code, signal) => {
      const exitCode = typeof code === "number" ? code : null;
      const status = exitCode ?? (signal ? 1 : 0);
      const timedOut = status === 124;
      let error = null;
      if (status !== 0) {
        error = new Error(`Codex timeout resume command exited with status ${status}.`);
        error.code = "CODEX_TIMEOUT_RESUME_FAILED";
        error.exitCode = status;
        if (timedOut) {
          withCodexSkipMetadata(error, SKIP_REASON_TIMEOUT, { threadId });
        }
      }
      settle({
        status,
        exitCode,
        signal: signal ?? null,
        timedOut,
        error
      });
    });
  });
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    // Broker busy is transient — actual auth state unknown, NOT a logged-out signal.
    // Without this branch, setup --json reports `loggedIn: false` for any concurrent
    // broker request (e.g., another plugin call in flight, broker init handshake in
    // progress, 28MB+ SQLite WAL flush blocking new requests). That produces a
    // false-negative mirror of the false-positive pattern documented in
    // plan-issue-setup-advisory-false-positive.md — caller cannot distinguish
    // "user actually logged out" vs "transient broker contention".
    if (error?.rpcCode === BROKER_BUSY_RPC_CODE) {
      return buildAuthStatus({
        loggedIn: null,
        detail: "Broker busy — actual auth state unknown. Retry setup --json after broker init completes (typically 5-30s; longer if plugin home SQLite WAL is large).",
        source: "app-server",
        transient: true,
      });
    }
    // Broker stuck (account/read timed out) — broker process 가 init handshake 또는 SQLite WAL flush
    // 에 막혀 응답 못함. transient 와 분리: 사용자 가 broker kill + plugin home WAL cleanup 필요.
    // 본 case 도 actual logged-out 시그널 아님 — false-negative 회피.
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (/timed out|timeout|ECONNRESET|EPIPE/i.test(errorMessage)) {
      return buildAuthStatus({
        loggedIn: null,
        detail: `Broker stuck (${errorMessage}) — actual auth state unknown. Recovery: kill plugin broker processes (Windows PowerShell: \`Get-Process | Where-Object { $_.ProcessName -ceq 'codex' } | Stop-Process -Force\` — case-sensitive lowercase only, excludes Codex Desktop GUI; macOS/Linux: \`pkill -f 'codex.*app-server'\`) + check plugin home SQLite WAL (~/.codex/claude-code/*.sqlite-wal — delete if >10MB). See plan-issue-setup-advisory-false-positive.md.`,
        source: "app-server",
        transient: true,
      });
    }
    return buildAuthStatus({
      loggedIn: false,
      detail: errorMessage,
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

// PR-5.4 (#233) — when the user points Codex at a non-OpenAI endpoint via
// `openai_base_url` in ~/.codex/config.toml, the auth gate fails because
// `codex login status` requires the official OpenAI auth flow. The codex
// subprocess itself runs fine against the custom endpoint (proxy / self-host)
// so the gate is just a false negative.
//
// We bypass when either:
//   - env CODEX_PLUGIN_SKIP_AUTH=1 (explicit user override; honors both
//     "1" and "true" / "yes" for ergonomics)
//   - ~/.codex/config.toml is parseable and contains a non-empty
//     `openai_base_url` key at the top level (heuristic; if the file uses
//     profiles only, the user must set the env var)
function shouldBypassCodexAuthCheck(env = process.env) {
  const flag = String(env.CODEX_PLUGIN_SKIP_AUTH ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") {
    return { bypass: true, reason: "env CODEX_PLUGIN_SKIP_AUTH" };
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) {
    return { bypass: false, reason: null };
  }
  try {
    const configPath = `${home}/.codex/config.toml`;
    const raw = readFileSyncSafe(configPath);
    if (raw && /^\s*openai_base_url\s*=\s*["'][^"']+["']/m.test(raw)) {
      return { bypass: true, reason: "openai_base_url detected in ~/.codex/config.toml" };
    }
  } catch {
    // Best-effort. If we cannot read the config, fall through to the
    // normal auth check.
  }
  return { bypass: false, reason: null };
}

function readFileSyncSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  const bypass = shouldBypassCodexAuthCheck(options.env ?? process.env);
  if (bypass.bypass) {
    return {
      available: true,
      loggedIn: true,
      detail: `Auth check bypassed (${bypass.reason}). Codex must be configured correctly for the custom endpoint.`,
      source: "bypass",
      authMethod: "custom",
      verified: false,
      requiresOpenaiAuth: false,
      provider: "custom"
    };
  }

  let client = null;
  try {
    // #41 — a reused broker can hold an invalidated token after the user ran
    // `codex logout && codex login`. getCodexAuthStatusFromClient swallows the
    // resulting error into a loggedIn:false status object, so the orchestrator
    // detects the stale-auth signature on `status.detail` (not only thrown
    // exceptions) and restarts the broker ONCE before re-probing.
    const reuseBrokerEndpoint = Boolean(options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV]);
    const { status } = await probeAuthWithStaleRetry({
      connect: () => CodexAppServerClient.connect(cwd, { env: options.env, reuseExistingBroker: true }),
      probe: (probeClient) => getCodexAuthStatusFromClient(probeClient, cwd),
      restartBroker: () => restartStaleBrokerSession(cwd),
      reuseBrokerEndpoint
    });
    return status;
  } catch (error) {
    const hasExplicitBrokerEndpoint = Boolean(options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV]);
    if (!hasExplicitBrokerEndpoint && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED")) {
      try {
        client = await CodexAppServerClient.connect(cwd, {
          env: options.env,
          disableBroker: true
        });
        return await getCodexAuthStatusFromClient(client, cwd);
      } catch (directError) {
        return buildAuthStatus({
          loggedIn: false,
          detail: directError instanceof Error ? directError.message : String(directError),
          source: "app-server"
        });
      }
    }
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      // Teardown best-effort: a failed close has no recovery path and must
      // not mask the primary turn error/result being propagated.
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    // Teardown best-effort: a failed close has no recovery path and must
    // not mask the primary error/result being propagated.
    await client?.close().catch(() => {});
  }
}

// PR-5.8 (#270) — when the user's top-level Codex config defaults to a newer
// model (e.g. gpt-5.5) that the structured-review path cannot use yet, the
// app-server returns 400 invalid_request_error with the literal message
// "The 'gpt-5.5' model requires a newer version of Codex". We detect that
// signature once per review and retry with the documented stable fallback
// (`gpt-5.4`) plus a warning so the user sees what happened.
const REVIEW_MODEL_FALLBACK = "gpt-5.4";

// PR-5.2 (#281) — `codex app-server` keeps its access token in memory after
// startup and does not re-read ~/.codex/auth.json when the user runs
// `codex logout && codex login`. Subsequent companion-mediated calls fail
// with "Your access token could not be refreshed because you have since
// logged out or signed in to another account. Please sign in again." even
// though `codex exec` from the same shell works fine. We detect that
// signature and surface a structured hint so the user knows to restart the
// broker instead of seeing a generic Codex error.
function isStaleAuthCacheError(error) {
  if (!error) {
    return false;
  }
  const text = typeof error === "string" ? error : error.message ?? "";
  // A1 (Phase A): telemetry cluster #2 "authentication expired" 12건 매치 추가 — daily-evolve
  // digest 의 가장 빈도 높은 auth failure 패턴.
  return /access token could not be refreshed|Please sign in again|authentication expired/i.test(String(text));
}

// issue #2 fix #1 — pure decision for folding the plugin-home staleness advisory
// into the setup `verified` verdict. The dual-home split (buildPluginCodexEnv adds
// CODEX_HOME=$HOME/.codex/claude-code/) means `codex login` rotates only the ROOT
// ~/.codex/auth.json while plugin-spawned rescue sessions read the stale plugin-home
// copy → `refresh token already used`. inspectPluginHomeFreshness() already detects
// this (mtime skew → advisory.staleAuth), but it was never wired into `verified`.
// When the home is PINNED (USE_DEFAULT_HOME=1 or an explicit CODEX_HOME) there is no
// dual-home, so the same token is used by setup and rescue → never downgrade.
// Pure (no fs / no side effects) so it unit-tests directly via __testHooks.
export function computeStaleHomeAuth(advisory, env = process.env) {
  // env?. guards an explicit null caller (the `= process.env` default only
  // covers undefined); ?? "" then yields a non-pinned read rather than throwing.
  const pinned =
    String(env?.CODEX_PLUGIN_USE_DEFAULT_HOME ?? "").trim() === "1" ||
    Boolean(String(env?.CODEX_HOME ?? "").trim());
  return Boolean(advisory?.staleAuth) && !pinned;
}

function annotateStaleAuthCacheError(error) {
  if (!error || !isStaleAuthCacheError(error)) {
    return error;
  }
  const original = typeof error === "string" ? error : error.message ?? "";
  // A1 fix: plugin home 격리 (v2.0+) + broker stuck case 추가 안내. 본 세션 (2026-05-28) PR #4
  // 에서 발견 + 복구 검증된 패턴.
  const guidance =
    "\n\nThe Codex app-server has cached an invalidated session. Recovery steps:\n" +
    "  1. /opnd-codex:cancel — drain any in-flight jobs\n" +
    "  2. Sync plugin home auth (v2.0+ isolation): `cp ~/.codex/auth.json ~/.codex/claude-code/auth.json`\n" +
    "  3. Kill stale brokers (Windows PowerShell: `Get-Process | Where-Object { $_.ProcessName -ceq 'codex' } | Stop-Process -Force`; macOS/Linux: `pkill -f 'codex.*app-server'`)\n" +
    "  4. If broker stuck (large SQLite WAL): `rm ~/.codex/claude-code/*.sqlite-wal ~/.codex/claude-code/*.sqlite-shm` (audit log only — safe)\n" +
    "  5. Restart Claude Code so the next invocation re-reads auth.\n" +
    "  6. If problem persists after fresh `codex logout && codex login`, file an upstream codex-cli bug (see plan-issue-setup-advisory-false-positive.md).";
  if (typeof error === "string") {
    return original + guidance;
  }
  return Object.assign(new Error(original + guidance), { cause: error, code: error.code ?? null });
}

// A1 (Phase A): telemetry cluster #4 "You've hit your usage limit" 5건 — usage limit error 의
// rate-limit 안내 + retry guidance + fallback model 권고. plugin advisory 가 단순 throw 가 아니라
// actionable nextSteps 제공.
function isUsageLimitError(error) {
  if (!error) {
    return false;
  }
  const text = typeof error === "string" ? error : error.message ?? "";
  return /usage limit|rate limit|too many requests|quota exceeded/i.test(String(text));
}

function annotateUsageLimitError(error) {
  if (!error || !isUsageLimitError(error)) {
    return error;
  }
  const original = typeof error === "string" ? error : error.message ?? "";
  const guidance =
    "\n\nCodex usage limit reached. Recovery options:\n" +
    "  1. Check current limits: https://chatgpt.com/c (ChatGPT subscription) or https://platform.openai.com/usage (API key)\n" +
    "  2. Wait for limit reset (typically hourly window) and retry\n" +
    "  3. Fallback to a smaller model: `--model gpt-5.4` (cheaper, lower per-call quota)\n" +
    "  4. Switch auth method if available (ChatGPT subscription ↔ API key) — different quota pools\n" +
    "  5. For long-running review, use `--fast` flag (lower per-call cost)";
  if (typeof error === "string") {
    return original + guidance;
  }
  return Object.assign(new Error(original + guidance), { cause: error, code: error.code ?? null });
}

// #41 — a reused broker app-server caches its OpenAI token at startup and does
// NOT re-read ~/.codex/auth.json after `codex logout && codex login`. The auth
// probe then comes back with the stale-auth signature even though the user just
// logged in fresh. Tear the stale broker down — under the broker lock so this
// is safe against concurrent /opnd-codex:* callers (#286) — and clear
// broker.json; the next connect respawns a fresh app-server that re-reads
// auth.json. Caller bounds this to one restart per probe.
async function restartStaleBrokerSession(cwd) {
  await withBrokerLockAsync(cwd, async () => {
    const session = loadBrokerSession(cwd);
    if (session) {
      teardownBrokerSession({
        endpoint: session.endpoint ?? null,
        pidFile: session.pidFile ?? null,
        logFile: session.logFile ?? null,
        sessionDir: session.sessionDir ?? null,
        pid: session.pid ?? null
      });
    }
    clearBrokerSession(cwd);
  });
}

// #41 — orchestrates the auth probe + one-shot stale-broker restart. Extracted
// with injected deps (`connect` / `probe` / `restartBroker`) so the behavioral
// test can drive the retry path without a real broker or app-server. Returns
// `{ status, restarted }`. The restart is bounded to exactly one attempt — a
// second stale-auth result after the restart is returned as-is (no loop).
async function probeAuthWithStaleRetry({ connect, probe, restartBroker, reuseBrokerEndpoint }) {
  let client = await connect();
  let restarted = false;
  try {
    let status = await probe(client);
    if (!reuseBrokerEndpoint && !status?.loggedIn && isStaleAuthCacheError(status?.detail)) {
      restarted = true;
      await client.close().catch(() => {});
      client = null;
      await restartBroker();
      client = await connect();
      status = await probe(client);
    }
    return { status, restarted };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

function isModelRequiresNewerCodexError(error) {
  if (!error) {
    return false;
  }
  const text = typeof error === "string" ? error : error.message ?? "";
  // Match the upstream phrasing; keep the regex loose enough that minor
  // wording changes (e.g. CLI vs app suggestion variants) still trip it.
  return /requires a newer version of Codex/i.test(String(text));
}

// #309 — shared model-version fallback for BOTH the review and the task/turn
// paths (was review-only; gpt-5.5 on CLI 0.130 also 400s task/agent runs).
// `runWithModel(modelOverride)` MUST: (a) return a result object with an
// `.error` field rather than throwing for the model-version case, and (b) be
// safe to call twice — re-issuing thread + turn/start from scratch.
//
// Retrying the whole function is safe ONLY because the "requires a newer
// version of Codex" failure is a request-time 400 (invalid_request) rejection
// of the thread/start or turn/start call: the server never created a turn, so
// the retry IS the first and only real turn. Do NOT broaden
// `isModelRequiresNewerCodexError` to mid-turn errors without removing this
// whole-function retry — that would create a duplicate server-side turn.
async function withModelFallback(runWithModel, { explicitModel, onProgress, label }) {
  const firstAttempt = await runWithModel(undefined);
  // Only auto-fallback when the user did NOT explicitly select a model, so an
  // intentional choice is never silently overridden.
  if (!explicitModel && isModelRequiresNewerCodexError(firstAttempt?.error)) {
    emitProgress(
      onProgress,
      `${label} failed: default model unavailable. Retrying with model="${REVIEW_MODEL_FALLBACK}".`,
      "warn"
    );
    return await runWithModel(REVIEW_MODEL_FALLBACK);
  }
  return firstAttempt;
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
  }

  async function executeReviewWithModel(modelOverride) {
    return withAppServer(cwd, async (client) => {
      emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
      const thread = await startThread(client, cwd, {
        model: modelOverride ?? options.model,
        sandbox: options.sandbox,
        ephemeral: true,
        threadName: options.threadName
      });
      const sourceThreadId = thread.thread.id;
      emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
        threadId: sourceThreadId
      });
      const delivery = options.delivery ?? "inline";

      const turnState = await captureTurn(
        client,
        sourceThreadId,
        () =>
          client.request("review/start", {
            threadId: sourceThreadId,
            delivery,
            target: options.target
          }),
        {
          onProgress: options.onProgress,
          onResponse(response, state) {
            if (response.reviewThreadId) {
              state.threadIds.add(response.reviewThreadId);
              if (delivery === "detached") {
                state.threadId = response.reviewThreadId;
              }
            }
          }
        }
      );

      return {
        status: buildResultStatus(turnState),
        threadId: turnState.threadId,
        sourceThreadId,
        turnId: turnState.turnId,
        reviewText: turnState.reviewText,
        reasoningSummary: turnState.reasoningSummary,
        turn: turnState.finalTurn,
        // PR-5.2 (#281) — annotate the stale-auth-cache error with a
        // structured hint so the user knows to restart the broker rather
        // than seeing a bare Codex error.
        error: annotateStaleAuthCacheError(turnState.error),
        stderr: cleanCodexStderr(client.stderr)
      };
    }, { profile: options.profile, fast: options.fast });
  }

  const explicitModel = options.model != null && String(options.model).length > 0;
  return withModelFallback(executeReviewWithModel, {
    explicitModel,
    onProgress: options.onProgress,
    label: "Codex review"
  });
}

// Upstream v1.0.5 (#374) — 네이티브 external-agent 세션 임포터를 통한 Claude
// 세션의 Codex 이관. source 경로 검증은 lib/claude-session-transfer.mjs, 사용자
// 표면은 commands/transfer.md 참고.
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
// transfer 는 정확히 한 migration item type 만 요청한다; 이 타입의 실패만
// import 를 중단해야 한다(SF2-002 — transfer 가 요청한 적 없는 item type 의
// 실패/경고가 성공한 세션 import 를 실패시키면 안 된다).
const EXTERNAL_AGENT_SESSIONS_ITEM_TYPE = "SESSIONS";

function resolveCodexHome() {
  // child app-server 가 쓰는 것과 동일 해석(CODEX_HOME || ~/.codex). transfer 가
  // child 에 CODEX_PLUGIN_USE_DEFAULT_HOME=1 을 강제하므로 child 는 정확히 이
  // home 으로 import 하고 parent 는 같은 ledger 를 읽는다 — 중요한 건 특정 절대
  // 경로가 아니라 parent/child 일치다.
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

// external-agent import ledger 를 방어적으로 읽는다. 손상되거나 반쯤 쓰인 JSON
// 파일(child 가 write 중일 수 있음, QUAL-002/SF-008)은 friendly transfer 에러를
// 가리는 raw SyntaxError 를 던지는 대신 "record 없음"으로 degrade 해야 한다.
function ledgerRecords(codexHome) {
  const ledgerPath = path.join(codexHome, "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }
  try {
    const ledger = readJsonFile(ledgerPath);
    return Array.isArray(ledger?.records) ? ledger.records : [];
  } catch {
    return [];
  }
}

// 관대한 source-path 비교. codex-cli 는 ledger 경로를 자체 canonical 형식으로
// 쓴다(Windows 는 `\\?\C:\...` verbatim prefix, UNC 는 `\\?\UNC\server\share`),
// 반면 Node fs.realpathSync 는 `C:\...` / `\\server\share` 반환 — raw === 는
// 매칭을 놓친다(CDX-001). 경로형 folding + 대소문자 무시는 Windows 전용이라
// win32 로 게이트; POSIX(대소문자 구분 FS)는 exact-string 비교만 써서 서로 다른
// 대소문자 변이 파일이 절대 합쳐지지 않는다(SF2-003).
function normalizeLedgerPath(value) {
  let normalized = String(value ?? "");
  if (process.platform === "win32") {
    normalized = normalized
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/, "")
      .replace(/\//g, "\\")
      .toLowerCase();
  }
  return normalized;
}

function sameSourcePath(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return normalizeLedgerPath(a) === normalizeLedgerPath(b);
}

// imported_at 이 있으면 record 를 오래된 것부터 최신 순으로 정렬해 "가장 최근
// 매칭"이 codex-cli ledger 배열이 append 순서라는 우연에 의존하지 않게 한다
// (QUAL2-002); timestamp 없는 record 는 stable sort 로 원래(배열) 순서를 유지.
function sortByImportedAt(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const la = Number(left.record?.imported_at);
      const ra = Number(right.record?.imported_at);
      const lv = Number.isFinite(la) ? la : Number.NEGATIVE_INFINITY;
      const rv = Number.isFinite(ra) ? ra : Number.NEGATIVE_INFINITY;
      return lv === rv ? left.index - right.index : lv - rv;
    })
    .map((entry) => entry.record);
}

// source 가 `sourcePath` 와 매칭되는 가장 최근 imported thread id 를 선택. 매칭은
// 항상 source-strict("id 있는 아무 record"로 degrade 안 함): 다른 세션의 record 는
// 이번 run 자신의 record 가 없거나 동시 프로세스가 무관한 걸 추가했어도 절대
// 반환하면 안 된다(SF2-001/CDX2-002). codex-cli 가 normalizeLedgerPath 가 못
// 알아보는 형식으로 source 경로를 쓰면, wrong-thread false-success 대신 안전한
// false-FAILURE("did not record an imported thread")를 낸다 — failure-path-first 선택.
function pickImportedThreadId(records, sourcePath) {
  const bySource = records.filter(
    (record) => typeof record?.imported_thread_id === "string" && sameSourcePath(record?.source_path, sourcePath)
  );
  const ordered = sortByImportedAt(bySource);
  return ordered.length > 0 ? ordered[ordered.length - 1].imported_thread_id : null;
}

// `externalAgentConfig/import/completed` 알림은 per-item 결과를 담는다;
// completed-but-FAILED import(SF-001/CDX-002)는 ledger 가 아니라 여기서만 보인다.
// 첫 SESSIONS 실패 메시지를 반환, 세션 import 성공 시 null(요청 안 한 다른 item
// type 의 실패는 무시 — SF2-002).
function importFailureMessage(completedParams) {
  const results = Array.isArray(completedParams?.itemTypeResults) ? completedParams.itemTypeResults : [];
  for (const result of results) {
    if (result?.itemType !== EXTERNAL_AGENT_SESSIONS_ITEM_TYPE) {
      continue;
    }
    const failures = Array.isArray(result?.failures) ? result.failures : [];
    if (failures.length > 0) {
      const first = failures[0];
      return first?.message || first?.errorType || "Codex could not import the Claude session.";
    }
  }
  return null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: EXTERNAL_AGENT_SESSIONS_ITEM_TYPE,
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });

  const handler = (message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted(message.params ?? null);
    }
  };
  // fork 의 notification-handler 스택을 재사용해 이전 핸들러(있으면)를 덮어쓰지
  // 않고 빠져나갈 때 복원한다.
  pushNotificationHandler(client, handler);

  let timeout = null;
  const timedOut = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Codex to finish importing the Claude session."));
    }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);
  });
  // timeout 은 completion 대기뿐 아니라 전체 operation 을 커버해야 한다: import
  // RPC 자체가 응답하지 않으면(CDX-004) request await 가 app-server 의 훨씬 긴
  // 기본 RPC timeout 까지 hang 한다. (Promise.race 가 `timedOut` 에 reaction 을
  // 붙이므로 work-wins 경로의 late rejection 은 이미 소비됨 — 별도 catch 불필요.)

  try {
    return await Promise.race([
      (async () => {
        await client.request("externalAgentConfig/import", params);
        return completed;
      })(),
      timedOut
    ]);
  } finally {
    clearTimeout(timeout);
    popNotificationHandler(client, handler);
  }
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`."
    );
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  // #282 — 플러그인 codex 세션은 보통 격리된 $HOME/.codex/claude-code/ home 에
  // 안착해 Codex Desktop 을 오염시키지 않는다. transfer 는 의도적 예외: 목적
  // 자체가 세션을 사용자 자신의 Codex(App/TUI)로 넘기는 것이고 그건 DEFAULT
  // home 을 읽는다. CODEX_PLUGIN_USE_DEFAULT_HOME=1 강제로 child 의 재격리를
  // 막아 여기 resolveCodexHome() 이 읽는 것과 같은 home 으로 import 한다 —
  // parent/child 가 항상 일치(둘 다 process.env.CODEX_HOME || ~/.codex 에서
  // 유도)하며 이는 아래 ledger diff 가 의존하는 불변식이다. 사용자가 명시한
  // CODEX_HOME 은 존중된다(그 사용자의 Codex 도 그 home 을 읽음).
  const codexHome = resolveCodexHome();
  // import 이전에 ledger 를 스냅샷해, 계속 커지는 live transcript 의 (path, hash)
  // 를 재유도(CDX-001 Windows 경로형, CDX-003 hash drift)하거나 stale 한 이전
  // record 를 false success 로 매칭(SF-002/CDX-002)하는 대신, 이번 run 이 ADD 한
  // record 로 이번 run 의 thread 를 상관한다.
  const priorThreadIds = new Set(
    ledgerRecords(codexHome)
      .map((record) => record?.imported_thread_id)
      .filter((id) => typeof id === "string")
  );

  return withAppServer(
    cwd,
    async (client) => {
      emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
      let completedParams;
      try {
        completedParams = await requestExternalAgentSessionImport(
          client,
          externalAgentSessionMigration(options.sourcePath, cwd)
        );
      } catch (error) {
        if (error?.rpcCode === -32601) {
          throw Object.assign(
            new Error(
              "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry."
            ),
            { cause: error }
          );
        }
        throw error;
      }

      // completed 알림이 성공을 의미하진 않는다 — per-item 실패를 명시적으로
      // surface 해, 더 약한 "no imported thread" 메시지(나 더 나쁘게는
      // stale-record false success)로 degrade 되지 않게 한다.
      const failure = importFailureMessage(completedParams);
      if (failure) {
        const stderr = cleanCodexStderr(client.stderr);
        throw new Error(`Codex could not import the Claude session: ${failure}${stderr ? `\n${stderr}` : ""}`);
      }

      const after = ledgerRecords(codexHome);
      const fresh = after.filter(
        (record) => typeof record?.imported_thread_id === "string" && !priorThreadIds.has(record.imported_thread_id)
      );
      // 이번 run 이 추가한 record(fresh diff)를 우선; Codex 가 변경 없는 콘텐츠의
      // 이전 import 를 idempotent 하게 반환(새 record 미기록)하면 SAME source 의
      // 기존 record 로 fallback. 두 pick 모두 source-strict 라 어느 쪽도 무관한
      // 세션의 thread 를 반환할 수 없다.
      const threadId =
        pickImportedThreadId(fresh, options.sourcePath) ?? pickImportedThreadId(after, options.sourcePath);
      if (!threadId) {
        const stderr = cleanCodexStderr(client.stderr);
        throw new Error(
          `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
        );
      }
      emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
      return {
        threadId,
        stderr: cleanCodexStderr(client.stderr)
      };
    },
    {
      disableBroker: true,
      env: { ...process.env, CODEX_PLUGIN_USE_DEFAULT_HOME: "1" }
    }
  );
}

export async function runAppServerTurn(cwd, options = {}) {
  // #21 — under requireBroker (codex-rescue subagent) the turn runs entirely
  // through a LIVE pre-existing broker, which carries its own codex. The
  // subagent's PATH may not resolve `codex` (GUI-launched shell did not inherit
  // PATH, #105), so skip the LOCAL availability check and rely on the broker
  // liveness check in connect() — otherwise the broker-only route is unusable.
  if (!options.requireBroker) {
    const availability = getCodexAvailability(cwd);
    if (!availability.available) {
      throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
    }
  }

  return withAppServer(
    cwd,
    async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    // #309 — retry ONLY turn/start, on the SAME already-created thread, with
    // the stable fallback model when the default model 400s. The thread is
    // created exactly once above, so — unlike a whole-function retry — no
    // orphan thread is left behind (Codex audit BUG fix). The model-version
    // 400 is a turn/start-time rejection (thread/start already succeeded);
    // re-issuing turn/start on the same thread is the first and only real turn.
    const runTurn = (modelOverride) =>
      captureTurn(
        client,
        threadId,
        () =>
          client.request("turn/start", {
            threadId,
            input: buildTurnInput(prompt),
            model: (modelOverride ?? options.model) ?? null,
            effort: options.effort ?? null,
            approvalPolicy: options.approvalPolicy ?? null,
            outputSchema: options.outputSchema ?? null
          }),
        {
          onProgress: options.onProgress,
          // PR-G-B (manual port of upstream PR #312) + A2 fix — per-turn
          // inactivity watchdog. An explicit `options.watchdogMs` from the
          // direct caller (companion / task path) wins; otherwise it resolves
          // to `CODEX_TURN_WATCHDOG_MS` env, then the default-on 10 min bound
          // (`resolveDefaultTurnWatchdogMs`). `CODEX_TURN_WATCHDOG_MS=0`
          // disables; an explicit `null` option also disables.
          watchdogMs:
            typeof options.watchdogMs === "number"
              ? options.watchdogMs
              : resolveDefaultTurnWatchdogMs()
        }
      );

    let turnState = await runTurn(undefined);
    const explicitModel = options.model != null && String(options.model).length > 0;
    if (!explicitModel && isModelRequiresNewerCodexError(turnState.error)) {
      emitProgress(
        options.onProgress,
        `Codex task failed: default model unavailable. Retrying with model="${REVIEW_MODEL_FALLBACK}".`,
        "warn"
      );
      turnState = await runTurn(REVIEW_MODEL_FALLBACK);
    }

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      // PR-5.2 (#281) — annotate the stale-auth-cache error path so the
      // user sees a clear restart hint, not a bare Codex error.
      error: annotateStaleAuthCacheError(turnState.error),
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  }, { serverRequestHandler: options.serverRequestHandler, profile: options.profile, fast: options.fast, requireBroker: options.requireBroker });
}

function getTimeoutThreadId(error, fallback = null) {
  return error?.threadId ?? error?.retryInfo?.threadId ?? fallback ?? null;
}

function buildRetryInfo({ threadId, budget, attempts, recovered = false, resumeTimeoutMs = null }) {
  return {
    skipReason: SKIP_REASON_TIMEOUT,
    threadId,
    resumeRetryBudget: budget,
    resumeAttempts: attempts,
    recovered,
    resumeTimeoutMs
  };
}

function emptyTimeoutResumeResult({ status, threadId, finalMessage = "", stderr = "", error, retryInfo }) {
  return {
    status,
    threadId,
    turnId: null,
    finalMessage,
    reasoningSummary: [],
    turn: null,
    error,
    stderr: cleanCodexStderr(stderr),
    fileChanges: [],
    touchedFiles: [],
    commandExecutions: [],
    retryInfo
  };
}

function buildRetryBudgetExceededResult({ threadId, originalError, lastResumeResult = null, budget, attempts }) {
  const retryInfo = buildRetryInfo({
    threadId,
    budget,
    attempts,
    recovered: false,
    resumeTimeoutMs: lastResumeResult?.error?.retryInfo?.resumeTimeoutMs ?? null
  });
  const error = withCodexSkipMetadata(
    new Error(`Codex timeout recovery retry budget exceeded after ${attempts} resume attempt(s) for thread ${threadId}.`),
    SKIP_REASON_RETRY_BUDGET_EXCEEDED,
    {
      threadId,
      retryInfo: {
        ...retryInfo,
        originalMessage: originalError?.message ?? null
      }
    }
  );
  error.code = "CODEX_TIMEOUT_RESUME_RETRY_BUDGET_EXCEEDED";
  error.exitCode = 124;

  return emptyTimeoutResumeResult({
    status: 124,
    threadId,
    finalMessage: String(lastResumeResult?.stdout ?? "").trimEnd(),
    stderr: lastResumeResult?.stderr ?? "",
    error,
    retryInfo
  });
}

function buildResumeCommandFailureResult({ threadId, resumeResult, budget, attempts }) {
  const retryInfo = buildRetryInfo({
    threadId,
    budget,
    attempts,
    recovered: false,
    resumeTimeoutMs: resumeResult?.error?.retryInfo?.resumeTimeoutMs ?? null
  });
  const error = withCodexSkipMetadata(
    resumeResult?.error ?? new Error(`Codex timeout resume command failed for thread ${threadId}.`),
    classifyCodexSkipReason(resumeResult?.error) ?? SKIP_REASON_TIMEOUT,
    {
      threadId,
      retryInfo
    }
  );

  return emptyTimeoutResumeResult({
    status: resumeResult?.status ?? 1,
    threadId,
    finalMessage: String(resumeResult?.stdout ?? "").trimEnd(),
    stderr: resumeResult?.stderr ?? "",
    error,
    retryInfo
  });
}

function buildResumeSuccessResult({ threadId, resumeResult, budget, attempts }) {
  const retryInfo = buildRetryInfo({
    threadId,
    budget,
    attempts,
    recovered: true,
    resumeTimeoutMs: null
  });

  return emptyTimeoutResumeResult({
    status: 0,
    threadId,
    finalMessage: String(resumeResult?.stdout ?? "").trimEnd(),
    stderr: resumeResult?.stderr ?? "",
    error: null,
    retryInfo
  });
}

async function recoverTimedOutAppServerTurn(cwd, error, options = {}) {
  const threadId = getTimeoutThreadId(error, options.resumeThreadId ?? null);
  const budget = resolveTimeoutResumeRetryBudget(options.env ?? process.env);
  const timeoutError = withCodexSkipMetadata(error, SKIP_REASON_TIMEOUT, {
    threadId,
    retryInfo: buildRetryInfo({
      threadId,
      budget,
      attempts: 0,
      recovered: false
    })
  });

  // #21 — in a codex-rescue subagent (requireBroker), the non-interactive
  // `codex exec resume` recovery spawns a child DIRECTLY from this
  // (kill-on-close) subagent process — exactly the doomed direct spawn the
  // guard forbids. Skip recovery and surface the timeout with an actionable
  // diagnostic instead of dooming a resume subprocess that dies at turn end.
  if (options.requireBroker === true) {
    const subagentError = Object.assign(
      withCodexSkipMetadata(
        new Error(
          `Codex turn timed out on thread ${threadId ?? "unknown"} and non-interactive resume is unavailable in a ` +
            "codex-rescue subagent (it would spawn a process that cannot survive the subagent's Job Object teardown — #21). " +
            "Re-run from the main Claude thread, or inspect /opnd-codex:status / /opnd-codex:result."
        ),
        SKIP_REASON_TIMEOUT,
        { threadId, retryInfo: buildRetryInfo({ threadId, budget, attempts: 0, recovered: false }) }
      ),
      { exitCode: 124 }
    );
    return emptyTimeoutResumeResult({
      status: 124,
      threadId,
      error: subagentError,
      retryInfo: buildRetryInfo({ threadId, budget, attempts: 0, recovered: false })
    });
  }

  if (!threadId || budget <= 0) {
    return buildRetryBudgetExceededResult({
      threadId: threadId ?? "unknown",
      originalError: timeoutError,
      budget,
      attempts: 0
    });
  }

  const resumeImpl = options.resumeTimedOutThreadImpl ?? resumeTimedOutThread;
  let lastResumeResult = null;

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    emitProgress(
      options.onProgress,
      `Codex turn timed out on thread ${threadId}; trying non-interactive resume (${attempt}/${budget}).`,
      "warn",
      { threadId }
    );
    lastResumeResult = await resumeImpl(threadId, {
      cwd,
      env: options.env ?? process.env,
      timeoutMs: options.timeoutResumeMs,
      spawnImpl: options.timeoutResumeSpawnImpl
    });

    if (!lastResumeResult?.timedOut && lastResumeResult?.status === 0) {
      return buildResumeSuccessResult({
        threadId,
        resumeResult: lastResumeResult,
        budget,
        attempts: attempt
      });
    }

    if (!lastResumeResult?.timedOut) {
      return buildResumeCommandFailureResult({
        threadId,
        resumeResult: lastResumeResult,
        budget,
        attempts: attempt
      });
    }
  }

  return buildRetryBudgetExceededResult({
    threadId,
    originalError: timeoutError,
    lastResumeResult,
    budget,
    attempts: budget
  });
}

export async function runAppServerTurnWithTimeoutResume(cwd, options = {}) {
  const runTurnImpl = options.runTurnImpl ?? runAppServerTurn;

  try {
    const result = await runTurnImpl(cwd, options);
    if (classifyCodexSkipReason(result?.error) === SKIP_REASON_TIMEOUT) {
      return recoverTimedOutAppServerTurn(cwd, result.error, {
        ...options,
        resumeThreadId: result.threadId ?? options.resumeThreadId ?? null
      });
    }
    return result;
  } catch (error) {
    const skipReason = classifyCodexSkipReason(error);
    if (skipReason !== SKIP_REASON_TIMEOUT) {
      if (skipReason) {
        throw withCodexSkipMetadata(error, skipReason);
      }
      throw error;
    }
    return recoverTimedOutAppServerTurn(cwd, error, options);
  }
}

export async function steerAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
  }
  if (!options.threadId || !options.turnId) {
    throw new Error("A thread id and active turn id are required to steer Codex.");
  }
  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error("A prompt is required to continue the active Codex turn.");
  }

  return withAppServer(
    cwd,
    async (client) => {
      const response = await client.request("turn/steer", {
        threadId: options.threadId,
        expectedTurnId: options.turnId,
        input: buildTurnInput(prompt)
      });
      return {
        status: 0,
        threadId: options.threadId,
        turnId: response.turnId ?? options.turnId,
        stderr: cleanCodexStderr(client.stderr)
      };
    },
    { serverRequestHandler: options.serverRequestHandler, retryDirectOnBusy: false }
  );
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };

// PR-1.3 (#183) — exposed for the finalizing-timeout contract test. Internal
// only; callers outside the test suite should treat these as private.
// CDX-004 — also expose `resolveSandboxValue` + `buildThreadParams` so the
// sandbox-default-omit contract test can verify the runtime omit/inherit
// behavior directly, not just the source pattern of executeReviewWithModel.
export const __testHooks = {
  createTurnCaptureState,
  armFinalizingPhaseTimerIfNeeded,
  clearFinalizingPhaseTimer,
  completeTurn,
  failTurn,
  FINALIZING_PHASE_TIMEOUT_MS,
  resolveSandboxValue,
  buildThreadParams,
  // #41 — exposed so the behavioral test can drive the stale-broker restart
  // retry without a real broker/app-server.
  probeAuthWithStaleRetry,
  isStaleAuthCacheError,
  // issue #2 fix #1 — pure verdict-downgrade decision (plugin-home stale + not pinned)
  computeStaleHomeAuth,
  withModelFallback,
  isModelRequiresNewerCodexError,
  // Codex R1 M2 (본 세션 발견 false-negative pattern) — broker busy / timeout 분기 직접 test 가능하도록 export
  getCodexAuthStatusFromClient,
  BROKER_BUSY_RPC_CODE,
  // Phase A1 — telemetry cluster #2 (auth expired) + #4 (usage limit) helper 직접 test 가능하도록 export
  isUsageLimitError,
  annotateUsageLimitError,
  // #374 transfer — 순수 ledger-correlation 헬퍼. 전체 e2e transfer 실행 없이
  // Windows 경로형 / latest-pick / source-strict / SESSIONS-scoping 로직을
  // 커버하도록 직접 unit-test 한다.
  normalizeLedgerPath,
  sameSourcePath,
  sortByImportedAt,
  pickImportedThreadId,
  importFailureMessage
};
