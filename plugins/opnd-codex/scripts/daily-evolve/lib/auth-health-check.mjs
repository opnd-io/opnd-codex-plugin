/**
 * auth-health-check.mjs — Codex CLI auth health check + degrade policy
 *
 * Plan reference: plan-daily-evolve-enhancement.md §Phase 1.5a
 *
 * 목적: Codex CLI 인증 만료 (refresh token expired/revoked) 시 routine 자체는
 * heuristic fallback 으로 degrade — 실패하지 않고 동작. 사용자가 digest failures
 * 섹션에서 즉시 인지 → 재인증 → 자동 routine 복구.
 *
 * OAuth 한계: refresh token rotation 은 Codex CLI 가 자동 처리 (access token
 * silent renew). 단 refresh token 자체 expired/revoked 시 → `codex login` 재실행
 * 필요 (browser interaction). plugin 이 사용자 대신 수행 불가 (보안 정책).
 *
 * Pure module — filesystem / network 호출 금지 (R2-L2). caller (orchestrator) 가
 * setup --json 실행 후 결과 inject.
 *
 * Node 내장 의존성 없음 (zero npm).
 */

/** Health check status enum. */
export const HEALTH_STATUS = Object.freeze({
  READY: "ready",                    // 모든 4 상태 (ready/available/loggedIn/verified) true
  CLI_UNAVAILABLE: "cli_unavailable", // CLI 자체 없음 또는 setup --json fail
  NOT_LOGGED_IN: "not_logged_in",    // refresh token expired/revoked
  NOT_VERIFIED: "not_verified",      // login 됐으나 verified false (subscription 등)
  UNKNOWN: "unknown",                // parse 실패 또는 schema 미일치
});

/** Degrade decision — routine 이 Codex 호출 path 를 어떻게 처리할지. */
export const DEGRADE_ACTION = Object.freeze({
  PROCEED: "proceed",                       // 정상 — Codex 호출 그대로
  FALLBACK_HEURISTIC: "fallback_heuristic", // heuristic stub 으로 degrade
  ABORT: "abort",                           // routine 전체 중단 (CLI 자체 부재)
});

/** N일 연속 expired 누적 시 별도 알림 task 등록 trigger (Phase 1.5b). */
export const EXPIRY_STREAK_ALERT_DAYS = 3;

/**
 * Parse `setup --json` output → health status. Pure.
 *
 * Codex CLI 의 setup --json 응답 schema 예시:
 * {
 *   "ready": true|false,
 *   "codex": {
 *     "available": true|false,
 *     "loggedIn": true|false,
 *     "verified": true|false
 *   },
 *   "errors": [...]
 * }
 *
 * @param {object | string | null} input - setup --json 결과 (parsed object 또는 raw JSON string)
 * @returns {{ status: string, details: object, raw?: object }}
 */
export function parseSetupJson(input) {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { status: HEALTH_STATUS.UNKNOWN, details: { reason: "json_parse_fail" } };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { status: HEALTH_STATUS.UNKNOWN, details: { reason: "non_object_response" } };
  }

  const codex = parsed.codex && typeof parsed.codex === "object" ? parsed.codex : {};

  if (codex.available !== true) {
    return {
      status: HEALTH_STATUS.CLI_UNAVAILABLE,
      details: { reason: "codex.available != true", available: codex.available },
      raw: parsed,
    };
  }

  if (codex.loggedIn !== true) {
    return {
      status: HEALTH_STATUS.NOT_LOGGED_IN,
      details: { reason: "codex.loggedIn != true", hint: "codex logout && codex login" },
      raw: parsed,
    };
  }

  if (codex.verified !== true) {
    return {
      status: HEALTH_STATUS.NOT_VERIFIED,
      details: { reason: "codex.verified != true", hint: "ChatGPT subscription 또는 plan 확인" },
      raw: parsed,
    };
  }

  if (parsed.ready !== true) {
    return {
      status: HEALTH_STATUS.UNKNOWN,
      details: { reason: "ready != true 단 codex.* 정상", hint: "setup advisory false positive 가능" },
      raw: parsed,
    };
  }

  return { status: HEALTH_STATUS.READY, details: { reason: "ok" }, raw: parsed };
}

/**
 * Health status → degrade action 결정. Pure.
 *
 * @param {string} status - HEALTH_STATUS enum
 * @returns {string} DEGRADE_ACTION enum
 */
export function decideDegrade(status) {
  switch (status) {
    case HEALTH_STATUS.READY:
      return DEGRADE_ACTION.PROCEED;
    case HEALTH_STATUS.NOT_LOGGED_IN:
    case HEALTH_STATUS.NOT_VERIFIED:
    case HEALTH_STATUS.UNKNOWN:
      return DEGRADE_ACTION.FALLBACK_HEURISTIC;
    case HEALTH_STATUS.CLI_UNAVAILABLE:
      return DEGRADE_ACTION.FALLBACK_HEURISTIC; // CLI 부재 시도 heuristic 으로 동작 (routine 자체는 진행)
    default:
      return DEGRADE_ACTION.FALLBACK_HEURISTIC;
  }
}

/**
 * digest failures 섹션에 들어갈 사용자 친화적 메시지 빌드. Pure.
 *
 * @param {{ status, details }} health
 * @returns {string | null} - 메시지 (READY 시 null)
 */
export function buildFailureMessage(health) {
  if (!health || health.status === HEALTH_STATUS.READY) return null;
  const hint = health.details?.hint ?? "";
  const prefix = "Codex auth health";
  switch (health.status) {
    case HEALTH_STATUS.CLI_UNAVAILABLE:
      return `${prefix}: CLI 미설치 또는 setup --json 실패 — \`codex --version\` 확인 후 npm install -g @openai/codex`;
    case HEALTH_STATUS.NOT_LOGGED_IN:
      return `${prefix}: 인증 만료 — \`${hint || "codex logout && codex login"}\` 후 다음 routine 부터 정상 복구`;
    case HEALTH_STATUS.NOT_VERIFIED:
      return `${prefix}: verified=false — ${hint || "Codex Desktop 에서 plan 확인"}`;
    case HEALTH_STATUS.UNKNOWN:
      return `${prefix}: health 응답 parse 실패 — ${hint || "수동 점검 필요"}`;
    default:
      return `${prefix}: unknown status=${health.status}`;
  }
}

/**
 * 연속 expired streak 계산 — runs ledger 의 마지막 N entry 중 health.status 가
 * NOT_LOGGED_IN 또는 NOT_VERIFIED 인 연속 횟수. Pure.
 *
 * @param {object[]} runs - 최신 순 정렬된 runs array (entry 에 `auth_health.status` 필드)
 * @returns {number} streak count (newest entry 기준)
 */
export function computeExpiryStreak(runs) {
  if (!Array.isArray(runs)) return 0;
  let streak = 0;
  for (const r of runs) {
    const s = r?.auth_health?.status;
    if (s === HEALTH_STATUS.NOT_LOGGED_IN || s === HEALTH_STATUS.NOT_VERIFIED) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * EXPIRY_STREAK_ALERT_DAYS 이상 누적 시 별도 알림 task 등록 권고. Pure.
 *
 * @param {number} streak
 * @returns {{ shouldEscalate: boolean, reason: string }}
 */
export function shouldEscalate(streak) {
  if (!Number.isFinite(streak) || streak < EXPIRY_STREAK_ALERT_DAYS) {
    return { shouldEscalate: false, reason: `streak ${streak} < ${EXPIRY_STREAK_ALERT_DAYS}` };
  }
  return {
    shouldEscalate: true,
    reason: `streak ${streak} ≥ ${EXPIRY_STREAK_ALERT_DAYS} — 사용자 재인증 ping 강도 ↑`,
  };
}
