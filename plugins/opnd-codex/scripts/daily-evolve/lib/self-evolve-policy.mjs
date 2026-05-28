/**
 * self-evolve-policy.mjs — Phase 6 Self-Evolve Meta Loop pure helpers
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Component 6 (Self-Evolve Meta Loop)
 *   - § Phase 6 FP Baseline & Rollback (R3-H1)
 *   - § R4-M1 actionable 정의 + disjoint attribution window
 *   - § R4-M3 review_type CLI 인자 + log field
 *   - § R5-M3 effective_at + decision precondition
 *
 * Pure module — filesystem / network 호출 금지 (R2-L2). caller (self-evolve.mjs)
 * 가 routine telemetry / log read 후 본 pure helpers 호출.
 * Node 내장 의존성 없음 (zero npm).
 */

/** Review type — weekly normal vs monthly self-change. */
export const REVIEW_TYPE = Object.freeze({
  WEEKLY_NORMAL: "weekly_normal",
  MONTHLY_SELF_CHANGE: "monthly_self_change",
});

/** Proposed change target enum — Phase 6 가 조정 가능한 heuristic 항목. */
export const CHANGE_TARGETS = Object.freeze({
  FORK_RANKING_WEIGHT: "fork_ranking_weight",
  FP_THRESHOLD: "fp_threshold",
  COST_CAP_MULTIPLIER: "cost_cap_multiplier",
  DIGEST_LENGTH_CAP: "digest_length_cap",
  DEDUPE_NORMALIZE_RULE: "dedupe_normalize_rule",
  SELF_EVOLVE_FREQUENCY: "self_evolve_*",
});

/** Decision enum. */
export const DECISION = Object.freeze({
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  ROLLBACK: "rollback",
});

/** Loop guard — Phase 6 가 자기 자신을 review 하는 메타-메타 review 차단. */
export const MAX_SELF_REVIEW_DEPTH = 1;

/** Plan §Phase 6 FP baseline window + rollback threshold. */
export const BASELINE_WINDOW_DAYS = 14;
export const POST_WINDOW_DAYS = 7;
export const ROLLBACK_FP_MULTIPLIER = 1.5;
export const MIN_ACTIONABLE_FOR_ATTRIBUTION = 10;
export const MAX_HELD_CYCLES = 3; // R5-M3 보류 카운트 한계

/** Weekly trigger period (매 7일). */
export const WEEKLY_TRIGGER_DAYS = 7;
export const MONTHLY_TRIGGER_DAYS = 30;

/**
 * actionable 정의 (R4-M1):
 *   - triage="autonomous_safe" + user accept/reject 가능한 항목
 *   - "needs_user" 도 포함 (사용자 직접 결정 영역)
 *   - "needs_claude_judgment" 제외 (Claude 자체 처리)
 *   - skip + (low|none) user_surface_value 제외
 *
 * @param {object} record
 * @returns {boolean}
 */
export function isActionable(record) {
  if (!record || typeof record !== "object") return false;
  if (record.triage === "needs_claude_judgment") return false;
  if (record.triage === "autonomous_safe") return true;
  if (record.triage === "needs_user") {
    const surface = record?.l5?.user_surface_value;
    return surface !== "low" && surface !== "none";
  }
  return false;
}

/**
 * FP rate = (rejected / total actionable). Pure.
 *
 * @param {object[]} records - actionable records 만
 * @returns {number} 0~1
 */
export function fpRate(records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const actionable = records.filter(isActionable);
  if (actionable.length === 0) return 0;
  const rejected = actionable.filter((r) => r?.user_decision === "rejected").length;
  return rejected / actionable.length;
}

/**
 * Disjoint attribution window — R4-M1.
 * 같은 target 의 PR effective_at 별 disjoint window (baseline 14d, post 7d).
 *
 * @param {{ effective_at: string, target: string, decision: string }} pr
 * @param {string} nowIso
 * @returns {{ eligible: boolean, reason?: string, baseline_window?: [string, string], post_window?: [string, string] }}
 */
export function buildAttributionWindow(pr, nowIso = new Date().toISOString()) {
  if (!pr || typeof pr !== "object") {
    return { eligible: false, reason: "pr missing" };
  }
  // R5-M3 — effective_at IS NULL 또는 decision != "accepted" 면 attribution 제외
  if (pr.effective_at == null) {
    return { eligible: false, reason: "effective_at null (not merged)" };
  }
  if (pr.decision !== DECISION.ACCEPTED) {
    return { eligible: false, reason: `decision="${pr.decision}" (not accepted)` };
  }
  const eff = Date.parse(pr.effective_at);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(eff) || !Number.isFinite(now)) {
    return { eligible: false, reason: "invalid timestamp" };
  }
  const day = 24 * 60 * 60 * 1000;
  // 7d 미경과 → post window 부족 → 보류
  if (now - eff < POST_WINDOW_DAYS * day) {
    return {
      eligible: false,
      reason: `post_window 부족 (${((now - eff) / day).toFixed(1)}d < ${POST_WINDOW_DAYS}d)`,
    };
  }
  const baselineFrom = new Date(eff - BASELINE_WINDOW_DAYS * day).toISOString();
  const baselineTo = new Date(eff).toISOString();
  const postFrom = baselineTo;
  const postTo = new Date(eff + POST_WINDOW_DAYS * day).toISOString();
  return {
    eligible: true,
    baseline_window: [baselineFrom, baselineTo],
    post_window: [postFrom, postTo],
  };
}

/**
 * Rollback 결정 — baseline_fp × 1.5 < post_fp (양쪽 actionable ≥ MIN_ACTIONABLE). Pure.
 *
 * @param {{ baseline_fp: number, post_fp: number, baseline_actionable: number, post_actionable: number }} input
 * @returns {{ rollback: boolean, reason: string }}
 */
export function shouldRollback({
  baseline_fp,
  post_fp,
  baseline_actionable,
  post_actionable,
} = {}) {
  if (
    !Number.isFinite(baseline_actionable) ||
    !Number.isFinite(post_actionable) ||
    baseline_actionable < MIN_ACTIONABLE_FOR_ATTRIBUTION ||
    post_actionable < MIN_ACTIONABLE_FOR_ATTRIBUTION
  ) {
    return {
      rollback: false,
      reason: `actionable count 부족 (baseline=${baseline_actionable}, post=${post_actionable}, min=${MIN_ACTIONABLE_FOR_ATTRIBUTION})`,
    };
  }
  if (!Number.isFinite(baseline_fp) || !Number.isFinite(post_fp)) {
    return { rollback: false, reason: "fp_rate invalid" };
  }
  const threshold = baseline_fp * ROLLBACK_FP_MULTIPLIER;
  if (post_fp >= threshold) {
    return {
      rollback: true,
      reason: `post_fp ${post_fp.toFixed(3)} ≥ baseline_fp ${baseline_fp.toFixed(3)} × ${ROLLBACK_FP_MULTIPLIER}`,
    };
  }
  return { rollback: false, reason: `post_fp ${post_fp.toFixed(3)} < threshold ${threshold.toFixed(3)}` };
}

/**
 * Loop guard — Phase 6 자기 자신 review 차단. Pure.
 *
 * @param {{ self_review_depth: number, review_type: string, proposed_changes: object[] }} entry
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkLoopGuard(entry) {
  if (!entry || typeof entry !== "object") {
    return { allowed: false, reason: "entry missing" };
  }
  if (!Number.isInteger(entry.self_review_depth) || entry.self_review_depth > MAX_SELF_REVIEW_DEPTH) {
    return {
      allowed: false,
      reason: `self_review_depth=${entry.self_review_depth} > MAX=${MAX_SELF_REVIEW_DEPTH}`,
    };
  }
  // Recursive 진단 — self_review_depth > 0 + target == "self_evolve_*" → STOP
  if (entry.self_review_depth > 0 && Array.isArray(entry.proposed_changes)) {
    const recursiveTarget = entry.proposed_changes.find(
      (c) => c?.target === CHANGE_TARGETS.SELF_EVOLVE_FREQUENCY,
    );
    if (recursiveTarget) {
      return {
        allowed: false,
        reason: `recursive meta-review detected (depth=${entry.self_review_depth}, target=self_evolve_*) — STOP`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Determine if weekly_normal review should fire — 마지막 review 이후 ≥ 7d 경과. Pure.
 *
 * @param {{ entries: object[] }} log
 * @param {string} nowIso
 * @returns {{ fire: boolean, reason: string, days_since_last?: number }}
 */
export function shouldFireWeekly(log, nowIso = new Date().toISOString()) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const weekly = entries.filter((e) => e?.review_type === REVIEW_TYPE.WEEKLY_NORMAL);
  if (weekly.length === 0) {
    return { fire: true, reason: "no prior weekly review", days_since_last: Infinity };
  }
  const last = weekly[weekly.length - 1];
  const lastMs = Date.parse(last?.started_at ?? "");
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) {
    return { fire: false, reason: "invalid timestamp" };
  }
  const daysSince = (nowMs - lastMs) / (24 * 60 * 60 * 1000);
  if (daysSince >= WEEKLY_TRIGGER_DAYS) {
    return { fire: true, reason: `${daysSince.toFixed(1)}d ≥ ${WEEKLY_TRIGGER_DAYS}d`, days_since_last: daysSince };
  }
  return {
    fire: false,
    reason: `${daysSince.toFixed(1)}d < ${WEEKLY_TRIGGER_DAYS}d`,
    days_since_last: daysSince,
  };
}

/**
 * Build review entry skeleton (status=pending, schema 준수). Pure.
 *
 * @param {{ review_type: string, started_at: string, self_review_depth?: number }} init
 * @returns {object}
 */
export function buildReviewEntry({ review_type, started_at, self_review_depth = 0 } = {}) {
  return {
    review_id: cryptoRandomUuid(),
    review_type: review_type ?? REVIEW_TYPE.WEEKLY_NORMAL,
    started_at,
    ended_at: null,
    effective_at: null,
    self_review_depth,
    inputs: {
      digests_analyzed: [],
      routine_telemetry: { exec_time_ms: [], codex_cost: [], fp_rate: [], triage_time_min: [] },
    },
    proposed_changes: [],
    pr_draft_url: null,
    decision: DECISION.PENDING,
    rollback_target_review_id: null,
  };
}

/**
 * Pure UUID v4-ish (Math.random 기반) — caller 가 crypto.randomUUID 주입 가능하지만
 * lib pure 정합 위해 deterministic-friendly fallback.
 *
 * @returns {string}
 */
function cryptoRandomUuid() {
  // 8-4-4-4-12 hex format, version 4 변형 비트 제거 (PoC 라 strict 아님)
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}
