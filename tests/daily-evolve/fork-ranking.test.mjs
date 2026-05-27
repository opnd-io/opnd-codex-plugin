/**
 * fork-ranking.test.mjs — lib/fork-ranking.mjs unit test (Phase 2)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isActive,
  isLicenseCompatible,
  normalizeTouchedPath,
  computeMatchingPluginPaths,
  computeUpstreamMergeRecency,
  computeUniqueTouchedPaths,
  computeAuthorDiversity,
  computeNonVendorDiffRatio,
  computeBaselineScore,
  applyL7Adjustment,
  selectTopN,
  ACTIVE_THRESHOLDS,
  SCORE_WEIGHTS,
  LICENSE_WHITELIST,
  RENAME_MAP,
  TOP_N_CANDIDATES,
  TOP_N_FINAL,
  TOP_N_AUSTERITY,
  BASELINE_PLUGIN_PATHS,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/fork-ranking.mjs";

const NOW = "2026-05-27T00:00:00Z";
const recentIso = (daysAgo) => new Date(Date.parse(NOW) - daysAgo * 86400000).toISOString();

test("ACTIVE_THRESHOLDS — plan §Active 정의 일치", () => {
  assert.equal(ACTIVE_THRESHOLDS.PUSHED_WITHIN_DAYS, 30);
  assert.equal(ACTIVE_THRESHOLDS.AHEAD_MIN, 5);
  assert.equal(ACTIVE_THRESHOLDS.AUTHOR_DIVERSITY_MIN, 2);
  assert.equal(ACTIVE_THRESHOLDS.NON_VENDOR_DIFF_RATIO_MIN, 0.3);
});

test("SCORE_WEIGHTS — 5-axis 합 1.0", () => {
  const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001, `weights sum=${sum} ≠ 1.0`);
});

test("isActive — 모든 조건 통과", () => {
  const fork = {
    pushed_at: recentIso(5),
    ahead_by: 10,
    archived: false,
    author_diversity: 3,
    non_vendor_diff_ratio: 0.7,
  };
  const result = isActive(fork, NOW);
  assert.equal(result.active, true);
  assert.deepEqual(result.failed, []);
});

test("isActive — pushed_at boundary (정확히 30d = stale)", () => {
  const fork = {
    pushed_at: recentIso(30),
    ahead_by: 10,
    archived: false,
    author_diversity: 3,
    non_vendor_diff_ratio: 0.7,
  };
  const result = isActive(fork, NOW);
  assert.equal(result.active, false);
  assert.ok(result.failed.some((f) => f.startsWith("stale")));
});

test("isActive — archived true / ahead_by 부족 / author 부족 / diff ratio 낮음", () => {
  assert.equal(isActive({ pushed_at: recentIso(5), ahead_by: 10, archived: true, author_diversity: 3, non_vendor_diff_ratio: 0.7 }, NOW).active, false);
  assert.equal(isActive({ pushed_at: recentIso(5), ahead_by: 4, archived: false, author_diversity: 3, non_vendor_diff_ratio: 0.7 }, NOW).active, false);
  assert.equal(isActive({ pushed_at: recentIso(5), ahead_by: 10, archived: false, author_diversity: 1, non_vendor_diff_ratio: 0.7 }, NOW).active, false);
  assert.equal(isActive({ pushed_at: recentIso(5), ahead_by: 10, archived: false, author_diversity: 3, non_vendor_diff_ratio: 0.2 }, NOW).active, false);
});

test("isActive — null/undefined 안전 처리", () => {
  assert.equal(isActive(null, NOW).active, false);
  assert.equal(isActive(undefined, NOW).active, false);
});

test("LICENSE_WHITELIST — Apache-2.0 / MIT / BSD only", () => {
  assert.equal(isLicenseCompatible("Apache-2.0"), true);
  assert.equal(isLicenseCompatible("MIT"), true);
  assert.equal(isLicenseCompatible("BSD-2-Clause"), true);
  assert.equal(isLicenseCompatible("BSD-3-Clause"), true);
  assert.equal(isLicenseCompatible("GPL-3.0"), false);
  assert.equal(isLicenseCompatible("AGPL-3.0"), false);
  assert.equal(isLicenseCompatible(null), false);
  assert.equal(isLicenseCompatible(""), false);
});

test("normalizeTouchedPath — RENAME_MAP effective_after 적용", () => {
  // PR #8 (2026-05-20) 이후 commit 은 plugins/codex/* → plugins/opnd-codex/*
  const after = normalizeTouchedPath("plugins/codex/scripts/foo.mjs", "2026-05-25T00:00:00Z");
  assert.equal(after, "plugins/opnd-codex/scripts/foo.mjs");

  // 그 이전 commit 은 legacy 유지
  const before = normalizeTouchedPath("plugins/codex/scripts/foo.mjs", "2026-05-15T00:00:00Z");
  assert.equal(before, "plugins/codex/scripts/foo.mjs");

  // 매칭 안 되는 path 그대로
  const other = normalizeTouchedPath("docs/foo.md", "2026-05-25T00:00:00Z");
  assert.equal(other, "docs/foo.md");
});

test("normalizeTouchedPath — Windows backslash → forward slash", () => {
  assert.equal(
    normalizeTouchedPath("plugins\\codex\\scripts\\foo.mjs", "2026-05-25T00:00:00Z"),
    "plugins/opnd-codex/scripts/foo.mjs",
  );
});

test("computeMatchingPluginPaths — intersection / baseline ratio", () => {
  const baseline = BASELINE_PLUGIN_PATHS;
  // 모든 baseline path 에 fork 가 1+ 매칭
  const all = baseline.map((b) => ({ path: `${b}foo.mjs`, ts: "2026-05-25T00:00:00Z" }));
  assert.equal(computeMatchingPluginPaths(all), 1);

  // 절반 매칭
  const half = baseline.slice(0, Math.floor(baseline.length / 2)).map((b) => ({ path: `${b}foo.mjs`, ts: "2026-05-25T00:00:00Z" }));
  assert.equal(computeMatchingPluginPaths(half), Math.floor(baseline.length / 2) / baseline.length);

  // 매칭 0
  assert.equal(computeMatchingPluginPaths([{ path: "docs/foo.md", ts: "2026-05-25T00:00:00Z" }]), 0);

  // 빈 입력
  assert.equal(computeMatchingPluginPaths([]), 0);
  assert.equal(computeMatchingPluginPaths(null), 0);
});

test("computeUpstreamMergeRecency — saturating 0~1", () => {
  assert.equal(computeUpstreamMergeRecency(0), 1);
  assert.equal(computeUpstreamMergeRecency(365), 0);
  assert.equal(computeUpstreamMergeRecency(500), 0);
  assert.ok(Math.abs(computeUpstreamMergeRecency(180) - (1 - 180 / 365)) < 0.001);
  assert.equal(computeUpstreamMergeRecency(-1), 0);
  assert.equal(computeUpstreamMergeRecency(NaN), 0);
});

test("computeUniqueTouchedPaths — saturating at 50", () => {
  assert.equal(computeUniqueTouchedPaths(0), 0);
  assert.equal(computeUniqueTouchedPaths(25), 0.5);
  assert.equal(computeUniqueTouchedPaths(50), 1);
  assert.equal(computeUniqueTouchedPaths(100), 1);
});

test("computeAuthorDiversity — linear 2~5", () => {
  assert.equal(computeAuthorDiversity(1), 0);
  assert.equal(computeAuthorDiversity(2), 0);
  assert.ok(Math.abs(computeAuthorDiversity(3.5) - 0.5) < 0.001);
  assert.equal(computeAuthorDiversity(5), 1);
  assert.equal(computeAuthorDiversity(10), 1);
});

test("computeNonVendorDiffRatio — clamp 0~1", () => {
  assert.equal(computeNonVendorDiffRatio(0), 0);
  assert.equal(computeNonVendorDiffRatio(0.5), 0.5);
  assert.equal(computeNonVendorDiffRatio(1), 1);
  assert.equal(computeNonVendorDiffRatio(1.5), 1);
  assert.equal(computeNonVendorDiffRatio(-0.1), 0);
});

test("computeBaselineScore — 5-axis 가중 합", () => {
  const input = {
    upstream_merge_age_days: 0, // recency=1
    touched_paths: BASELINE_PLUGIN_PATHS.map((b) => ({ path: `${b}foo.mjs`, ts: "2026-05-25T00:00:00Z" })), // matching=1
    unique_touched_path_count: 50, // unique=1
    author_diversity: 5, // diversity=1
    non_vendor_diff_ratio: 1, // ratio=1
  };
  const { total, axes } = computeBaselineScore(input);
  assert.equal(axes.recency, 1);
  assert.equal(axes.matching, 1);
  assert.equal(axes.unique, 1);
  assert.equal(axes.diversity, 1);
  assert.equal(axes.ratio, 1);
  assert.ok(Math.abs(total - 1.0) < 0.001);
});

test("applyL7Adjustment — boost/demote/maintain/insufficient", () => {
  assert.equal(applyL7Adjustment(1.0, "boost"), 1.3);
  assert.equal(applyL7Adjustment(1.0, "demote"), 0.7);
  assert.equal(applyL7Adjustment(1.0, "maintain"), 1.0);
  assert.equal(applyL7Adjustment(1.0, "insufficient_info"), 1.0);
  assert.equal(applyL7Adjustment(1.0, "unknown_enum"), 1.0); // fallback
  assert.equal(applyL7Adjustment(NaN, "boost"), 0);
});

test("selectTopN — score desc + stars tie-breaker", () => {
  const cands = [
    { score: 0.5, stars: 100, id: "a" },
    { score: 0.8, stars: 10, id: "b" },
    { score: 0.5, stars: 200, id: "c" }, // tie with a → stars desc
    { score: 0.3, stars: 50, id: "d" },
  ];
  const top = selectTopN(cands, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].id, "b"); // 0.8 highest
  assert.equal(top[1].id, "c"); // 0.5 + 200 stars
  assert.equal(top[2].id, "a"); // 0.5 + 100 stars
});

test("TOP_N constants — 10/5/3", () => {
  assert.equal(TOP_N_CANDIDATES, 10);
  assert.equal(TOP_N_FINAL, 5);
  assert.equal(TOP_N_AUSTERITY, 3);
});
