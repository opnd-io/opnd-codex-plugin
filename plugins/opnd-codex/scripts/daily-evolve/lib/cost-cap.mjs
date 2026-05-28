/**
 * cost-cap.mjs — Codex pair daily cost cap (Phase 1)
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Codex Triage Orchestrator — Cost cap (median × 3)
 *   - § Codex Critique R3-H3 (cost_units 단위)
 *   - § R3-L10 baseline = 최근 7회 median
 *
 * `state/daily-evolve-cost-baseline.json` 의 최근 7회 cost_units 의 median.
 * 당일 cost > median × 3 시 후속 호출 skip + skip_reason: cost_cap_exceeded.
 *
 * Schema:
 *   { schema_version: 1, baselines: [{ ts: ISO, units: int }] }  // append-only, last 7
 *
 * Pure module — filesystem 호출 금지 (lib dependency rule R2-L2).
 * caller (codex-triage.mjs / companion) 가 state file read 후 데이터 inject.
 * Node 내장 의존성 없음 (zero npm).
 */

/** Last N baselines retained. */
export const MAX_BASELINES = 7;

/** Multiplier for daily cap (baseline median × MULTIPLIER). */
export const CAP_MULTIPLIER = 3;

/** Initial baseline (Phase 1 첫 진입 시 baselines 부재) — plan §L5/L7 contract. */
export const INITIAL_BASELINE_UNITS = 20;

/**
 * Calculate median of integer array. Pure.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Compute daily cap from baselines. Pure.
 *
 * @param {Array<{ ts: string, units: number }>} baselines
 * @returns {{ cap: number, baseline_median: number, source: "initial" | "median" }}
 */
export function computeCap(baselines) {
  if (!Array.isArray(baselines) || baselines.length === 0) {
    return { cap: INITIAL_BASELINE_UNITS * CAP_MULTIPLIER, baseline_median: INITIAL_BASELINE_UNITS, source: "initial" };
  }
  const units = baselines.map((b) => b?.units).filter((u) => Number.isFinite(u));
  if (units.length === 0) {
    return { cap: INITIAL_BASELINE_UNITS * CAP_MULTIPLIER, baseline_median: INITIAL_BASELINE_UNITS, source: "initial" };
  }
  const m = median(units);
  return { cap: m * CAP_MULTIPLIER, baseline_median: m, source: "median" };
}

/**
 * Check if current usage exceeds daily cap. Pure.
 *
 * @param {{ currentUnits: number, baselines: object[] }} input
 * @returns {{ exceeded: boolean, current: number, cap: number, baseline_median: number, source: string }}
 */
export function isCapExceeded({ currentUnits, baselines } = {}) {
  const current = Number.isFinite(currentUnits) ? currentUnits : 0;
  const { cap, baseline_median, source } = computeCap(baselines);
  return { exceeded: current > cap, current, cap, baseline_median, source };
}

/**
 * Append today's units to baselines (immutable — 새 배열 반환). last MAX_BASELINES 만 유지.
 * Pure.
 *
 * @param {Array<{ ts: string, units: number }>} baselines
 * @param {{ ts: string, units: number }} entry
 * @returns {Array<{ ts: string, units: number }>}
 */
export function appendBaseline(baselines, entry) {
  if (!entry || typeof entry !== "object") return baselines ?? [];
  const prev = Array.isArray(baselines) ? baselines : [];
  const next = [...prev, entry];
  // Keep newest MAX_BASELINES sorted by ts ascending
  next.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  if (next.length > MAX_BASELINES) {
    return next.slice(-MAX_BASELINES);
  }
  return next;
}

/**
 * Skip reason enum — CLAUDE.md § Codex Cross-Verification Default 의 taxonomy 일부.
 */
export const SKIP_REASONS = Object.freeze({
  COST_CAP_EXCEEDED: "cost_cap_exceeded",
  CLI_UNAVAILABLE: "cli_unavailable",
  USER_BLOCKED: "user_blocked",
  SCOPE_EXCLUDED: "scope_excluded",
  TRIGGER_CAP_APPLIED: "trigger_cap_applied",
  FALSE_POSITIVE_ADVISORY: "false_positive_advisory",
  TOOLKIT_AWARE_LOCKED: "toolkit_aware_locked",
  TRIVIAL_TASK: "trivial_task",
});

export const SKIP_REASON_LIST = Object.freeze(Object.values(SKIP_REASONS));
