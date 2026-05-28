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
  TRANSIENT: "transient",            // broker busy 등 일시 상태 — actual auth state 불명 (lib/codex.mjs BROKER_BUSY_RPC_CODE 분기와 정합)
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
 * Codex CLI 의 setup --json 응답 schema (실측, plugins/opnd-codex/scripts/codex-companion.mjs buildSetupReport):
 * {
 *   "ready": true|false,
 *   "codex": { "available": true|false, "detail": "..." },
 *   "auth":  { "available": true|false, "loggedIn": true|false, "verified": true|false,
 *              "detail": "...", "authMethod": "...", "source": "..." },
 *   "errors": [...]
 * }
 *
 * Returns no `raw` echo — `details.detail` 같은 PII (email / authMethod) 가 ledger 에 영구
 * 저장되는 것을 차단. 디버깅이 필요하면 호출처에서 setup stdout 을 별도 처리.
 *
 * @param {object | string | null} input - setup --json 결과 (parsed object 또는 raw JSON string)
 * @returns {{ status: string, details: object }}
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
  const auth = parsed.auth && typeof parsed.auth === "object" ? parsed.auth : {};

  if (codex.available !== true) {
    return {
      status: HEALTH_STATUS.CLI_UNAVAILABLE,
      details: { reason: "codex.available != true" },
    };
  }

  // lib/codex.mjs BROKER_BUSY_RPC_CODE 분기와 정합: broker busy 시 actual auth state 불명.
  // auth.transient: true 또는 auth.loggedIn === null 일 때 TRANSIENT 로 분류 — NOT_LOGGED_IN 으로 잘못 degrade 회피.
  if (auth.transient === true || auth.loggedIn === null) {
    return {
      status: HEALTH_STATUS.TRANSIENT,
      details: { reason: "broker busy or actual auth state unknown", hint: "wait broker init (5-30s) and retry" },
    };
  }

  if (auth.loggedIn !== true) {
    return {
      status: HEALTH_STATUS.NOT_LOGGED_IN,
      details: { reason: "auth.loggedIn != true", hint: "codex logout && codex login" },
    };
  }

  if (auth.verified !== true) {
    return {
      status: HEALTH_STATUS.NOT_VERIFIED,
      details: { reason: "auth.verified != true", hint: "ChatGPT subscription 또는 plan 확인" },
    };
  }

  if (parsed.ready !== true) {
    return {
      status: HEALTH_STATUS.UNKNOWN,
      details: { reason: "ready != true 단 auth.* 정상", hint: "setup advisory false positive 가능" },
    };
  }

  return { status: HEALTH_STATUS.READY, details: { reason: "ok" } };
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
    case HEALTH_STATUS.TRANSIENT:
      // broker busy 는 일시적 — 정상 진행 (다음 호출에서 broker init 완료 가능).
      // routine 자체는 PROCEED — broker 가 init 완료되면 Codex pair 호출 정상 작동.
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
    case HEALTH_STATUS.TRANSIENT:
      return `${prefix}: broker busy (transient) — ${hint || "wait 5-30s and retry setup --json"} (actual auth state 불명 — NOT_LOGGED_IN 과 구분)`;
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
    // TRANSIENT 는 streak 에 포함 안 함 — broker busy 는 actual auth expired 와 구분.
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
