/**
 * Codex skip-taxonomy 메타데이터를 실어 나르는 `Error`.
 *
 * 이 속성들은 throw 지점에서 붙고, 본 모듈의 classifier 와 `codex.mjs` 의
 * timeout-resume 경로가 읽는다. 형태를 한 번 선언해 두어야 `checkJs` 가 인식한다.
 * plain `Error` 에 `error.code` 를 직접 대입하는 것이 CLAUDE.md 가 신규 코드에
 * 금지하는 TS2339 다.
 *
 * @typedef {Error & {
 *   skipReason?: string,
 *   threadId?: string | null,
 *   retryInfo?: Record<string, unknown>,
 *   code?: string,
 *   exitCode?: number | null
 * }} CodexSkipError
 */

export const CODEX_SKIP_REASONS = Object.freeze({
  TIMEOUT: "timeout",
  RETRY_BUDGET_EXCEEDED: "retry_budget_exceeded",
  CONTEXT_TOO_LARGE: "context_too_large"
});

export const SKIP_REASON_TIMEOUT = CODEX_SKIP_REASONS.TIMEOUT;
export const SKIP_REASON_RETRY_BUDGET_EXCEEDED = CODEX_SKIP_REASONS.RETRY_BUDGET_EXCEEDED;
export const SKIP_REASON_CONTEXT_TOO_LARGE = CODEX_SKIP_REASONS.CONTEXT_TOO_LARGE;

const TIMEOUT_CODES = new Set(["TURN_WATCHDOG_TIMEOUT", "ETIMEDOUT"]);

function errorMessage(error) {
  return String(error?.message ?? error ?? "");
}

export function isTimeoutLikeError(error) {
  const message = errorMessage(error);
  return (
    error?.skipReason === SKIP_REASON_TIMEOUT ||
    TIMEOUT_CODES.has(error?.code) ||
    error?.name === "TurnWatchdogError" ||
    error?.exitCode === 124 ||
    /\b(?:timed out|timeout|watchdog|hung|hang|killed after)\b/i.test(message)
  );
}

export function isRetryBudgetExceededError(error) {
  return error?.skipReason === SKIP_REASON_RETRY_BUDGET_EXCEEDED;
}

export function isContextTooLargeError(error) {
  const message = errorMessage(error);
  return (
    error?.skipReason === SKIP_REASON_CONTEXT_TOO_LARGE ||
    /\b(?:context window|context length|context limit|context too large|input too large)\b/i.test(message) ||
    /\btoo many tokens\b/i.test(message)
  );
}

export function classifyCodexSkipReason(error) {
  if (isRetryBudgetExceededError(error)) {
    return SKIP_REASON_RETRY_BUDGET_EXCEEDED;
  }
  if (isTimeoutLikeError(error)) {
    return SKIP_REASON_TIMEOUT;
  }
  if (isContextTooLargeError(error)) {
    return SKIP_REASON_CONTEXT_TOO_LARGE;
  }
  return null;
}

/**
 * @param {unknown} error
 * @param {string} skipReason
 * @param {{ threadId?: string | null, retryInfo?: Record<string, unknown> }} [metadata]
 * @returns {CodexSkipError}
 */
export function withCodexSkipMetadata(error, skipReason, metadata = {}) {
  /** @type {CodexSkipError} */
  const target = error instanceof Error ? error : new Error(errorMessage(error));
  target.skipReason = skipReason;

  const threadId = metadata.threadId ?? target.threadId ?? null;
  if (threadId) {
    target.threadId = threadId;
  }

  const retryInfo = {
    ...(target.retryInfo && typeof target.retryInfo === "object" ? target.retryInfo : {}),
    ...(metadata.retryInfo && typeof metadata.retryInfo === "object" ? metadata.retryInfo : {})
  };
  if (threadId) {
    retryInfo.threadId = threadId;
  }
  if (Object.keys(retryInfo).length > 0) {
    target.retryInfo = retryInfo;
  }

  return target;
}
