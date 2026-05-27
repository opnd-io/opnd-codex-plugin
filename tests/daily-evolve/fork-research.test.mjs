/**
 * fork-research.test.mjs — Phase 2 orchestrator unit test
 *
 * Network IO 는 mock (skipNetwork=true) 으로 격리. pure helper (heuristicL7) 검증.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  research,
  heuristicL7,
} from "../../plugins/opnd-codex/scripts/daily-evolve/fork-research.mjs";
import { SIGNAL_TYPES } from "../../plugins/opnd-codex/scripts/daily-evolve/lib/verdict-schema.mjs";

test("research — skipNetwork 시 빈 records + skipped=true", () => {
  const result = research({ skipNetwork: true });
  assert.deepEqual(result.records, []);
  assert.equal(result.research_summary.skipped, true);
  assert.equal(result.research_summary.skip_reason, "skipNetwork option");
  assert.equal(result.research_summary.api_calls, 0);
});

test("research_summary schema — 모든 필드 존재", () => {
  const result = research({ skipNetwork: true });
  const s = result.research_summary;
  assert.ok("total_forks" in s);
  assert.ok("active_forks" in s);
  assert.ok("license_skipped" in s);
  assert.ok("top_candidates" in s);
  assert.ok("api_calls" in s);
  assert.ok("l7_calls" in s);
  assert.ok("l7_cost_units" in s);
  assert.ok("budget_exceeded" in s);
  assert.ok("n_final" in s);
});

test("heuristicL7 — boost (matching ≥ 0.5 + unique ≥ 5)", () => {
  const fork = {
    _unique_touched_path_count: 10,
    _upstream_merge_age_days: 30,
    non_vendor_diff_ratio: 0.7,
    ahead_by: 15,
    author_diversity: 3,
  };
  const axes = { matching: 0.6, recency: 0.9, unique: 0.2, diversity: 0.3, ratio: 0.7 };
  const result = heuristicL7(fork, axes);
  assert.equal(result.adjustment, "boost");
  assert.equal(result.factor, 1.3);
  assert.ok(result.cost_units >= 1);
});

test("heuristicL7 — demote (stale fork, age ≥ 180d)", () => {
  const fork = {
    _unique_touched_path_count: 3,
    _upstream_merge_age_days: 200,
    non_vendor_diff_ratio: 0.7,
    ahead_by: 10,
    author_diversity: 3,
  };
  const axes = { matching: 0.3, recency: 0.5, unique: 0.1, diversity: 0.3, ratio: 0.7 };
  const result = heuristicL7(fork, axes);
  assert.equal(result.adjustment, "demote");
  assert.equal(result.factor, 0.7);
});

test("heuristicL7 — demote (vendor mass change, ratio < 0.5)", () => {
  const fork = {
    _unique_touched_path_count: 3,
    _upstream_merge_age_days: 30,
    non_vendor_diff_ratio: 0.2,
    ahead_by: 10,
    author_diversity: 3,
  };
  const axes = { matching: 0.3, recency: 0.9, unique: 0.1, diversity: 0.3, ratio: 0.2 };
  const result = heuristicL7(fork, axes);
  assert.equal(result.adjustment, "demote");
});

test("heuristicL7 — maintain (active dev, ahead ≥ 20 + authors ≥ 3)", () => {
  const fork = {
    _unique_touched_path_count: 3,
    _upstream_merge_age_days: 30,
    non_vendor_diff_ratio: 0.7,
    ahead_by: 25,
    author_diversity: 4,
  };
  const axes = { matching: 0.4, recency: 0.9, unique: 0.1, diversity: 0.5, ratio: 0.7 };
  const result = heuristicL7(fork, axes);
  assert.equal(result.adjustment, "maintain");
  assert.equal(result.factor, 1.0);
});

test("heuristicL7 — insufficient_info fallback", () => {
  const fork = {
    _unique_touched_path_count: 3,
    _upstream_merge_age_days: 30,
    non_vendor_diff_ratio: 0.7,
    ahead_by: 10,
    author_diversity: 2,
  };
  const axes = { matching: 0.3, recency: 0.9, unique: 0.1, diversity: 0.1, ratio: 0.7 };
  const result = heuristicL7(fork, axes);
  assert.equal(result.adjustment, "insufficient_info");
  assert.equal(result.factor, 1.0);
});

test("heuristicL7 — cost_units > 0 (decision-triage profile)", () => {
  const fork = { _unique_touched_path_count: 0, _upstream_merge_age_days: 30, non_vendor_diff_ratio: 0.7, ahead_by: 5, author_diversity: 2 };
  const axes = { matching: 0.1, recency: 0.9, unique: 0, diversity: 0, ratio: 0.7 };
  const result = heuristicL7(fork, axes);
  assert.ok(result.cost_units >= 1);
});

test("IMPORT-CANDIDATE record schema 형태 (skipNetwork 보호 — 직접 schema 검증)", () => {
  // skipNetwork=true 시 records=[] 이지만 schema 정의는 SIGNAL_TYPES 통해 확인
  assert.equal(SIGNAL_TYPES.FORK_IMPORT_CANDIDATE, "fork-import-candidate");
});
