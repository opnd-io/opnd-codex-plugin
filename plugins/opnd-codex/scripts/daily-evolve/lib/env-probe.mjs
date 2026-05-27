/**
 * env-probe.mjs — Phase 5.0 `scheduled-tasks` MCP env probe helpers
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Phase 5.0 — `scheduled-tasks` MCP Env Probe (BLOCKING)
 *   - § R3-H2 env probe enum + branch
 *   - § R4-H1 LOCAL_TZ_ONLY 변환식 + DST drift 위험 등재
 *
 * scheduler_status enum:
 *   - UTC_AWARE       : MCP cron 의 CRON_TZ / timezone field 지원 확인
 *   - LOCAL_TZ_ONLY   : MCP cron 이 local TZ 만 — KST 09:00 을 machine TZ 로 변환
 *   - MCP_UNAVAILABLE : `scheduled-tasks` MCP 미설치 → cron fallback primary
 *   - UNKNOWN         : 확인 실패 — 사용자 explicit confirm BLOCKING
 *
 * KST 09:00 UTC 00:00 변환:
 *   target_machine_minutes = (0 + machine_offset_minutes) mod 1440
 *   target_machine_hour = floor(target_machine_minutes / 60)
 *   target_machine_min = target_machine_minutes mod 60
 *
 *   예시 (DST 없는 가정):
 *     - Asia/Seoul (+540) → (0+540) mod 1440 = 540 min → 09:00 → `0 9 * * *`
 *     - UTC (0)            → 0 → 00:00 → `0 0 * * *`
 *     - America/Los_Angeles (-480) → (0-480+1440) mod 1440 = 960 → 16:00 → `0 16 * * *` (전날 KST 09:00)
 *
 *   DST risk: 봄/가을 전환 시 1h drift. mitigation = 매월 1회 자동 reprobe.
 *
 * Pure module — filesystem / network 호출 금지 (R2-L2). caller (orchestrator) 가 probe.
 * Node 내장 의존성 없음 (zero npm).
 */

export const SCHEDULER_STATUS = Object.freeze({
  UTC_AWARE: "UTC_AWARE",
  LOCAL_TZ_ONLY: "LOCAL_TZ_ONLY",
  MCP_UNAVAILABLE: "MCP_UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
});

export const SCHEDULER_STATUS_LIST = Object.freeze(Object.values(SCHEDULER_STATUS));

/** KST UTC offset (분 단위). DST 없음. */
export const KST_OFFSET_MINUTES = 540;

/** Daily run UTC target time (00:00 = KST 09:00). */
export const TARGET_UTC_MINUTES = 0;

/** state/daily-evolve-env-probe.json schema. */
export const ENV_PROBE_SCHEMA_VERSION = 1;

/**
 * Decision tree — probe inputs → scheduler_status enum. Pure.
 *
 * @param {{ mcp_installed: boolean, mcp_cron_api_docs_found: boolean, cron_tz_supported: boolean | null }} input
 * @returns {string} SCHEDULER_STATUS value
 */
export function decideSchedulerStatus({ mcp_installed, mcp_cron_api_docs_found, cron_tz_supported } = {}) {
  if (mcp_installed !== true) return SCHEDULER_STATUS.MCP_UNAVAILABLE;
  if (cron_tz_supported === true) return SCHEDULER_STATUS.UTC_AWARE;
  if (cron_tz_supported === false) return SCHEDULER_STATUS.LOCAL_TZ_ONLY;
  // null / undefined / docs 부재 → UNKNOWN (사용자 explicit confirm)
  if (mcp_cron_api_docs_found !== true) return SCHEDULER_STATUS.UNKNOWN;
  return SCHEDULER_STATUS.UNKNOWN;
}

/**
 * Convert KST 09:00 → machine local cron expression. Pure.
 *
 * @param {number} machineOffsetMinutes - UTC 기준 offset (Asia/Seoul = +540, UTC = 0, LA = -480)
 * @returns {{ hour: number, minute: number, cron: string }}
 */
export function kstNineToLocalCron(machineOffsetMinutes) {
  if (!Number.isFinite(machineOffsetMinutes)) {
    return { hour: 0, minute: 0, cron: "0 0 * * *" };
  }
  // target_machine_minutes = (TARGET_UTC_MINUTES + machineOffsetMinutes) mod 1440
  let mins = (TARGET_UTC_MINUTES + machineOffsetMinutes) % 1440;
  if (mins < 0) mins += 1440;
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  return { hour, minute, cron: `${minute} ${hour} * * *` };
}

/**
 * Probe result schema validation. Pure.
 *
 * @param {object} probe
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateProbe(probe) {
  const errors = [];
  if (!probe || typeof probe !== "object") {
    return { ok: false, errors: ["probe must be an object"] };
  }
  if (probe.schema_version !== ENV_PROBE_SCHEMA_VERSION) {
    errors.push(`schema_version ${probe.schema_version} ≠ ${ENV_PROBE_SCHEMA_VERSION}`);
  }
  if (!SCHEDULER_STATUS_LIST.includes(probe.scheduler_status)) {
    errors.push(`scheduler_status "${probe.scheduler_status}" not in [${SCHEDULER_STATUS_LIST.join(", ")}]`);
  }
  if (typeof probe.user_machine_tz !== "string") {
    errors.push("user_machine_tz must be string");
  }
  if (!Number.isFinite(probe.machine_offset_minutes)) {
    errors.push("machine_offset_minutes must be number");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build probe result object. Pure.
 *
 * @param {{
 *   mcp_installed: boolean,
 *   mcp_cron_api_docs_found: boolean,
 *   cron_tz_supported: boolean | null,
 *   user_machine_tz: string,
 *   machine_offset_minutes: number,
 *   probed_at?: string,
 * }} input
 * @returns {object} env-probe.json schema
 */
export function buildProbeResult(input = {}) {
  const status = decideSchedulerStatus({
    mcp_installed: input.mcp_installed,
    mcp_cron_api_docs_found: input.mcp_cron_api_docs_found,
    cron_tz_supported: input.cron_tz_supported,
  });
  const fallbackRequired = status === SCHEDULER_STATUS.MCP_UNAVAILABLE || status === SCHEDULER_STATUS.UNKNOWN;
  return {
    schema_version: ENV_PROBE_SCHEMA_VERSION,
    probed_at: input.probed_at ?? new Date().toISOString(),
    scheduler_status: status,
    user_machine_tz: input.user_machine_tz ?? "?",
    machine_offset_minutes: Number.isFinite(input.machine_offset_minutes) ? input.machine_offset_minutes : 0,
    probe_details: {
      mcp_installed: input.mcp_installed === true,
      mcp_cron_api_docs_found: input.mcp_cron_api_docs_found === true,
      cron_tz_supported: input.cron_tz_supported ?? null,
      fallback_required: fallbackRequired,
    },
  };
}

/**
 * Detect DST risk for given TZ. Pure heuristic — KST 는 DST 없음, US/EU 등 있음.
 * caller 가 reprobe 주기 결정에 활용.
 *
 * @param {string} tz - IANA TZ identifier (예: "Asia/Seoul", "America/New_York")
 * @returns {boolean}
 */
export function hasDstRisk(tz) {
  if (typeof tz !== "string") return false;
  // Whitelist DST-aware TZ (대표적 사례). 비포함 = 무 DST 또는 알 수 없음 (false 보수적).
  const DST_TZ_PATTERNS = [
    /^America\//,
    /^Europe\//,
    /^Australia\/(?!Brisbane|Darwin|Perth)/, // 일부 호주 주는 DST 없음
    /^Pacific\/Auckland$/,
  ];
  return DST_TZ_PATTERNS.some((re) => re.test(tz));
}
