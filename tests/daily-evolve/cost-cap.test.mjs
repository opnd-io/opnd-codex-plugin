/**
 * cost-cap.test.mjs — lib/cost-cap.mjs unit test (Phase 1)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  median,
  computeCap,
  isCapExceeded,
  appendBaseline,
  SKIP_REASONS,
  MAX_BASELINES,
  CAP_MULTIPLIER,
  INITIAL_BASELINE_UNITS,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/cost-cap.mjs";

test("median — odd / even / single / empty", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([5, 1, 3, 7]), 4); // (3 + 5) / 2
  assert.equal(median([42]), 42);
  assert.equal(median([]), 0);
  assert.equal(median(null), 0);
  assert.equal(median("string"), 0);
});

test("median — NaN / Infinity 필터 후 계산", () => {
  assert.equal(median([5, NaN, 3, Infinity]), 4);
  assert.equal(median([NaN, NaN]), 0);
});

test("computeCap — 빈 baselines 시 initial × CAP_MULTIPLIER", () => {
  const result = computeCap([]);
  assert.equal(result.source, "initial");
  assert.equal(result.baseline_median, INITIAL_BASELINE_UNITS);
  assert.equal(result.cap, INITIAL_BASELINE_UNITS * CAP_MULTIPLIER);
});

test("computeCap — baselines 있으면 median × CAP_MULTIPLIER", () => {
  const baselines = [
    { ts: "2026-05-20T00:00:00Z", units: 10 },
    { ts: "2026-05-21T00:00:00Z", units: 20 },
    { ts: "2026-05-22T00:00:00Z", units: 30 },
  ];
  const result = computeCap(baselines);
  assert.equal(result.source, "median");
  assert.equal(result.baseline_median, 20);
  assert.equal(result.cap, 60);
});

test("isCapExceeded — current ≤ cap 통과, > cap 차단", () => {
  const baselines = [{ ts: "2026-05-20T00:00:00Z", units: 10 }];
  const cap = 10 * CAP_MULTIPLIER; // 30

  assert.equal(isCapExceeded({ currentUnits: cap, baselines }).exceeded, false);
  assert.equal(isCapExceeded({ currentUnits: cap + 1, baselines }).exceeded, true);
  assert.equal(isCapExceeded({ currentUnits: 0, baselines }).exceeded, false);
});

test("appendBaseline — last MAX_BASELINES 만 유지 (FIFO trim)", () => {
  let baselines = [];
  for (let i = 0; i < MAX_BASELINES + 3; i++) {
    baselines = appendBaseline(baselines, {
      ts: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      units: i + 1,
    });
  }
  assert.equal(baselines.length, MAX_BASELINES);
  // 가장 오래된 3개 (units 1, 2, 3) 제거되고 나머지 (4~10) 유지
  assert.equal(baselines[0].units, 4);
  assert.equal(baselines[baselines.length - 1].units, MAX_BASELINES + 3);
});

test("appendBaseline — null entry 안전 처리", () => {
  const base = [{ ts: "2026-05-20T00:00:00Z", units: 10 }];
  assert.deepEqual(appendBaseline(base, null), base);
  assert.deepEqual(appendBaseline(null, { ts: "x", units: 1 }), [{ ts: "x", units: 1 }]);
});

test("SKIP_REASONS — CLAUDE.md taxonomy 일치", () => {
  assert.equal(SKIP_REASONS.COST_CAP_EXCEEDED, "cost_cap_exceeded");
  assert.equal(SKIP_REASONS.CLI_UNAVAILABLE, "cli_unavailable");
  assert.equal(SKIP_REASONS.USER_BLOCKED, "user_blocked");
  assert.equal(SKIP_REASONS.SCOPE_EXCLUDED, "scope_excluded");
  assert.equal(SKIP_REASONS.TRIGGER_CAP_APPLIED, "trigger_cap_applied");
  assert.equal(SKIP_REASONS.FALSE_POSITIVE_ADVISORY, "false_positive_advisory");
  assert.equal(SKIP_REASONS.TOOLKIT_AWARE_LOCKED, "toolkit_aware_locked");
  assert.equal(SKIP_REASONS.TRIVIAL_TASK, "trivial_task");
});
