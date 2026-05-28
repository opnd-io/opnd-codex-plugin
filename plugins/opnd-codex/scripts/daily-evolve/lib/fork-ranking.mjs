/**
 * fork-ranking.mjs — Active Fork ranking score + RENAME_MAP (Phase 2)
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Active Forks Research 메커니즘 (Codex HIGH-1 강화)
 *   - § R3-L1 rename mapping effective_after 2026-05-20 (PR #8 fork name 변경 시점)
 *   - § R3-M2 matching_plugin_paths 산식 (intersection / 기준 집합)
 *   - § Phase 2.1 baseline score + L7 케이스별 조정 (Codex 호출은 orchestrator)
 *
 * Active 정의 (모두 충족):
 *   - pushed_at < 30일 (UTC ISO 엄격 <)
 *   - ahead_by ≥ 5 commits
 *   - archived: false
 *   - commit_author_diversity ≥ 2 unique authors in last 30d
 *   - non_vendor_diff_ratio ≥ 0.3 (vendored mass change 차단)
 *
 * Ranking score:
 *   baseline = upstream_merge_recency × 0.30
 *            + matching_plugin_paths   × 0.25
 *            + unique_touched_paths    × 0.20
 *            + commit_author_diversity × 0.15
 *            + non_vendor_diff_ratio   × 0.10
 *
 * Pure module — filesystem / network 호출 금지 (R2-L2 lib dep rule).
 * caller (fork-research.mjs orchestrator) 가 실제 IO 후 결과 inject.
 * Node 내장 의존성 없음 (zero npm).
 */

/** Active 정의 임계값. */
export const ACTIVE_THRESHOLDS = Object.freeze({
  PUSHED_WITHIN_DAYS: 30,
  AHEAD_MIN: 5,
  AUTHOR_DIVERSITY_MIN: 2,
  NON_VENDOR_DIFF_RATIO_MIN: 0.3,
});

/** Score weights — 5-axis baseline. */
export const SCORE_WEIGHTS = Object.freeze({
  UPSTREAM_MERGE_RECENCY: 0.30,
  MATCHING_PLUGIN_PATHS: 0.25,
  UNIQUE_TOUCHED_PATHS: 0.20,
  COMMIT_AUTHOR_DIVERSITY: 0.15,
  NON_VENDOR_DIFF_RATIO: 0.10,
});

/** License whitelist — Apache-2.0 / MIT / BSD-2/3-Clause 만 통과. */
export const LICENSE_WHITELIST = Object.freeze([
  "Apache-2.0",
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
]);

/** Top N candidate cap — Codex L7 호출 비용 제어. */
export const TOP_N_CANDIDATES = 10;
export const TOP_N_FINAL = 5;
export const TOP_N_AUSTERITY = 3;

/**
 * RENAME_MAP — 우리 fork 의 path 이름 변경 history.
 * effective_after 이후 commit 만 매핑 적용. 그 이전은 legacy 그대로.
 * Plan R3-L1.
 */
export const RENAME_MAP = Object.freeze([
  Object.freeze({
    from: /^plugins\/codex\//,
    to: "plugins/opnd-codex/",
    effective_after: "2026-05-20T00:00:00Z", // PR #8 rename merge timestamp
  }),
]);

/** 기준 경로 집합 (우리 fork plugin 의 핵심 디렉토리). */
export const BASELINE_PLUGIN_PATHS = Object.freeze([
  "plugins/opnd-codex/commands/",
  "plugins/opnd-codex/agents/",
  "plugins/opnd-codex/hooks/",
  "plugins/opnd-codex/scripts/",
  "plugins/opnd-codex/scripts/lib/",
  "plugins/opnd-codex/scripts/daily-evolve/",
  "plugins/opnd-codex/prompts/",
  "plugins/opnd-codex/schemas/",
  "plugins/opnd-codex/skills/",
]);

/**
 * Active 정의 check. Pure.
 *
 * @param {{
 *   pushed_at: string,           // ISO 8601 UTC
 *   ahead_by: number,
 *   archived: boolean,
 *   author_diversity: number,    // last 30d unique authors
 *   non_vendor_diff_ratio: number,
 * }} fork
 * @param {string} nowIso - reference now (testable)
 * @returns {{ active: boolean, failed: string[] }}
 */
export function isActive(fork, nowIso = new Date().toISOString()) {
  const failed = [];
  if (!fork || typeof fork !== "object") {
    return { active: false, failed: ["fork object missing"] };
  }
  // pushed_at recency (UTC ISO strict <)
  const pushedMs = Date.parse(fork.pushed_at);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(pushedMs)) {
    failed.push("pushed_at invalid");
  } else {
    const ageDays = (nowMs - pushedMs) / (24 * 60 * 60 * 1000);
    if (ageDays >= ACTIVE_THRESHOLDS.PUSHED_WITHIN_DAYS) {
      failed.push(`stale (age=${ageDays.toFixed(1)}d ≥ ${ACTIVE_THRESHOLDS.PUSHED_WITHIN_DAYS}d)`);
    }
  }
  if (fork.archived === true) failed.push("archived");
  if (!(Number.isFinite(fork.ahead_by) && fork.ahead_by >= ACTIVE_THRESHOLDS.AHEAD_MIN)) {
    failed.push(`ahead_by=${fork.ahead_by} < ${ACTIVE_THRESHOLDS.AHEAD_MIN}`);
  }
  if (!(Number.isFinite(fork.author_diversity) && fork.author_diversity >= ACTIVE_THRESHOLDS.AUTHOR_DIVERSITY_MIN)) {
    failed.push(`author_diversity=${fork.author_diversity} < ${ACTIVE_THRESHOLDS.AUTHOR_DIVERSITY_MIN}`);
  }
  if (!(Number.isFinite(fork.non_vendor_diff_ratio) && fork.non_vendor_diff_ratio >= ACTIVE_THRESHOLDS.NON_VENDOR_DIFF_RATIO_MIN)) {
    failed.push(`non_vendor_diff_ratio=${fork.non_vendor_diff_ratio} < ${ACTIVE_THRESHOLDS.NON_VENDOR_DIFF_RATIO_MIN}`);
  }
  return { active: failed.length === 0, failed };
}

/**
 * Normalize a touched path with RENAME_MAP (R3-L1).
 * commit timestamp 이 effective_after 이후 일 때만 mapping 적용.
 *
 * @param {string} p - touched path
 * @param {string} commitIso - commit timestamp (UTC ISO)
 * @returns {string} normalized path
 */
export function normalizeTouchedPath(p, commitIso) {
  if (typeof p !== "string") return p;
  let normalized = p.replace(/\\/g, "/");
  const commitMs = Date.parse(commitIso);
  for (const rule of RENAME_MAP) {
    const effectiveMs = Date.parse(rule.effective_after);
    if (Number.isFinite(commitMs) && Number.isFinite(effectiveMs) && commitMs < effectiveMs) {
      continue; // before rename — legacy path 그대로
    }
    if (rule.from.test(normalized)) {
      normalized = normalized.replace(rule.from, rule.to);
    }
  }
  return normalized;
}

/**
 * matching_plugin_paths score — 우리 baseline 집합과 fork touched paths intersection / baseline.
 * 0 ~ 1 정규화.
 *
 * @param {Array<{ path: string, ts: string }>} forkTouchedPaths
 * @returns {number} 0~1
 */
export function computeMatchingPluginPaths(forkTouchedPaths) {
  if (!Array.isArray(forkTouchedPaths) || forkTouchedPaths.length === 0) return 0;
  // longest-prefix 우선 매칭 — sub-directory 가 parent 와 별도 cover 로 카운트되도록
  // (예: `scripts/lib/foo.mjs` 는 `scripts/lib/` 가 `scripts/` 보다 먼저 매칭).
  const sortedBaseline = [...BASELINE_PLUGIN_PATHS].sort((a, b) => b.length - a.length);
  const baselineSize = BASELINE_PLUGIN_PATHS.length;
  const matched = new Set();
  for (const entry of forkTouchedPaths) {
    const norm = normalizeTouchedPath(entry?.path ?? "", entry?.ts ?? "");
    for (const b of sortedBaseline) {
      if (norm.startsWith(b)) {
        matched.add(b);
        break;
      }
    }
  }
  return matched.size / baselineSize;
}

/**
 * upstream_merge_recency score — fork 가 최근에 upstream main 을 merge 했는지.
 * lastUpstreamMergeAgeDays 가 작을수록 score 높음. 1년 (365d) 이내 = 0~1 linear, 그 이상 = 0.
 *
 * @param {number} ageDays
 * @returns {number} 0~1
 */
export function computeUpstreamMergeRecency(ageDays) {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  if (ageDays >= 365) return 0;
  return 1 - ageDays / 365;
}

/**
 * unique_touched_paths score — fork 의 unique path 수 (우리에게 없는 path 기준).
 * 1~50 paths = 0~1 saturating, 50+ = 1.
 *
 * @param {number} uniqueCount
 * @returns {number}
 */
export function computeUniqueTouchedPaths(uniqueCount) {
  if (!Number.isFinite(uniqueCount) || uniqueCount <= 0) return 0;
  if (uniqueCount >= 50) return 1;
  return uniqueCount / 50;
}

/**
 * commit_author_diversity score — 30d unique author 수.
 * 2 (min for active) = 0, 5+ = 1. linear.
 *
 * @param {number} diversity
 * @returns {number}
 */
export function computeAuthorDiversity(diversity) {
  if (!Number.isFinite(diversity) || diversity < 2) return 0;
  if (diversity >= 5) return 1;
  return (diversity - 2) / 3;
}

/**
 * non_vendor_diff_ratio score — 이미 0~1 ratio. saturating.
 *
 * @param {number} ratio
 * @returns {number}
 */
export function computeNonVendorDiffRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * Baseline score 계산. Pure. caller 가 5 axis 의 raw input 모두 제공.
 *
 * @param {{
 *   upstream_merge_age_days: number,
 *   touched_paths: Array<{ path, ts }>,
 *   unique_touched_path_count: number,
 *   author_diversity: number,
 *   non_vendor_diff_ratio: number,
 * }} input
 * @returns {{
 *   total: number,
 *   axes: { recency, matching, unique, diversity, ratio },
 * }}
 */
export function computeBaselineScore(input) {
  const axes = {
    recency: computeUpstreamMergeRecency(input?.upstream_merge_age_days),
    matching: computeMatchingPluginPaths(input?.touched_paths),
    unique: computeUniqueTouchedPaths(input?.unique_touched_path_count),
    diversity: computeAuthorDiversity(input?.author_diversity),
    ratio: computeNonVendorDiffRatio(input?.non_vendor_diff_ratio),
  };
  const total =
    axes.recency * SCORE_WEIGHTS.UPSTREAM_MERGE_RECENCY +
    axes.matching * SCORE_WEIGHTS.MATCHING_PLUGIN_PATHS +
    axes.unique * SCORE_WEIGHTS.UNIQUE_TOUCHED_PATHS +
    axes.diversity * SCORE_WEIGHTS.COMMIT_AUTHOR_DIVERSITY +
    axes.ratio * SCORE_WEIGHTS.NON_VENDOR_DIFF_RATIO;
  return { total, axes };
}

/**
 * Apply L7 Codex 조정 factor to baseline. Pure.
 * adjustment ∈ {boost: 1.3, demote: 0.7, maintain: 1.0, insufficient_info: 1.0}
 *
 * @param {number} baseline
 * @param {string} adjustment - L7 응답 enum
 * @returns {number} adjusted score
 */
export function applyL7Adjustment(baseline, adjustment) {
  if (!Number.isFinite(baseline)) return 0;
  switch (adjustment) {
    case "boost":
      return baseline * 1.3;
    case "demote":
      return baseline * 0.7;
    case "maintain":
    case "insufficient_info":
    default:
      return baseline;
  }
}

/**
 * License check — Apache-2.0 / MIT / BSD-2/3 만 통과.
 *
 * @param {string} licenseSpdx
 * @returns {boolean}
 */
export function isLicenseCompatible(licenseSpdx) {
  if (typeof licenseSpdx !== "string") return false;
  return LICENSE_WHITELIST.includes(licenseSpdx);
}

/**
 * Top N selection — baseline 또는 adjusted score 순으로 정렬 + 절단.
 * stars 가 tie-breaker.
 *
 * @param {Array<{ score: number, stars?: number }>} candidates
 * @param {number} n
 * @returns {Array}
 */
export function selectTopN(candidates, n = TOP_N_FINAL) {
  if (!Array.isArray(candidates)) return [];
  if (!Number.isInteger(n) || n < 1) return [];
  return [...candidates]
    .sort((a, b) => {
      const sd = (b?.score ?? 0) - (a?.score ?? 0);
      if (sd !== 0) return sd;
      return (b?.stars ?? 0) - (a?.stars ?? 0);
    })
    .slice(0, n);
}
