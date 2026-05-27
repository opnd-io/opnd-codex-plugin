/**
 * action-policy.test.mjs — lib/action-policy.mjs unit test (Phase 4)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  heuristicL5,
  isLive,
  pruneCache,
  buildPRBody,
  L5_DECISIONS,
  L5_SURFACE_VALUES,
  CACHE_TTL_DAYS,
  PR_CONCURRENT_CAP,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/action-policy.mjs";
import { SIGNAL_TYPES, VERDICTS } from "../../plugins/opnd-codex/scripts/daily-evolve/lib/verdict-schema.mjs";

test("heuristicL5 — TODO_STALE ≥30d → pr_draft", () => {
  const r = {
    signal_type: SIGNAL_TYPES.TODO_STALE,
    verdict: VERDICTS.PARTIAL,
    age_days: 45,
    file: "src/foo.mjs",
    line: 42,
  };
  const result = heuristicL5(r);
  assert.equal(result.decision, L5_DECISIONS.PR_DRAFT);
  assert.equal(result.user_surface_value, L5_SURFACE_VALUES.MEDIUM);
  assert.equal(result.fallback_used, false);
});

test("heuristicL5 — TODO_STALE <30d → fallback skip (no matching policy)", () => {
  const r = {
    signal_type: SIGNAL_TYPES.TODO_STALE,
    verdict: VERDICTS.PARTIAL,
    age_days: 15,
  };
  const result = heuristicL5(r);
  assert.equal(result.decision, L5_DECISIONS.SKIP);
  assert.equal(result.user_surface_value, L5_SURFACE_VALUES.LOW);
});

test("heuristicL5 — UNRELEASED_GAP → needs_user", () => {
  const result = heuristicL5({
    signal_type: SIGNAL_TYPES.UNRELEASED_GAP,
    verdict: VERDICTS.PARTIAL,
    ref: "src/foo.mjs",
  });
  assert.equal(result.decision, L5_DECISIONS.NEEDS_USER);
  assert.equal(result.user_surface_value, L5_SURFACE_VALUES.MEDIUM);
});

test("heuristicL5 — TELEMETRY_UX → needs_user (high surface)", () => {
  const result = heuristicL5({
    signal_type: SIGNAL_TYPES.TELEMETRY_UX,
    verdict: VERDICTS.NOT_FIXED,
    cluster_size: 5,
  });
  assert.equal(result.decision, L5_DECISIONS.NEEDS_USER);
  assert.equal(result.user_surface_value, L5_SURFACE_VALUES.HIGH);
});

test("heuristicL5 — MEMORY_DRIFT → needs_user (high surface)", () => {
  const result = heuristicL5({
    signal_type: SIGNAL_TYPES.MEMORY_DRIFT,
    verdict: VERDICTS.QUESTION,
    project: "test",
    memory_file: "feedback_x.md",
  });
  assert.equal(result.decision, L5_DECISIONS.NEEDS_USER);
  assert.equal(result.user_surface_value, L5_SURFACE_VALUES.HIGH);
});

test("heuristicL5 — FORK_IMPORT_CANDIDATE → needs_user", () => {
  const result = heuristicL5({
    signal_type: SIGNAL_TYPES.FORK_IMPORT_CANDIDATE,
    verdict: VERDICTS.NOT_FIXED,
    fork: "user/repo",
    baseline_score: 0.5,
  });
  assert.equal(result.decision, L5_DECISIONS.NEEDS_USER);
});

test("heuristicL5 — upstream FIXED → skip (no action)", () => {
  const result = heuristicL5({
    signal_type: SIGNAL_TYPES.UPSTREAM_ISSUE,
    verdict: VERDICTS.FIXED,
  });
  assert.equal(result.decision, L5_DECISIONS.SKIP);
  assert.equal(result.user_surface_value, L5_SURFACE_VALUES.NONE);
});

test("heuristicL5 — null input → fail-closed needs_user + fallback_used", () => {
  const result = heuristicL5(null);
  assert.equal(result.decision, L5_DECISIONS.NEEDS_USER);
  assert.equal(result.fallback_used, true);
});

test("isLive — 7d TTL boundary", () => {
  const NOW = "2026-05-27T00:00:00Z";
  // 6.9d → live
  const ts69 = new Date(Date.parse(NOW) - 6.9 * 86400000).toISOString();
  assert.equal(isLive({ ts: ts69 }, NOW), true);
  // 7d → not live (boundary)
  const ts7 = new Date(Date.parse(NOW) - 7 * 86400000).toISOString();
  assert.equal(isLive({ ts: ts7 }, NOW), false);
  // 1d → live
  const ts1 = new Date(Date.parse(NOW) - 86400000).toISOString();
  assert.equal(isLive({ ts: ts1 }, NOW), true);
  // null safe
  assert.equal(isLive(null, NOW), false);
  assert.equal(isLive({ ts: "invalid" }, NOW), false);
});

test("pruneCache — 7d 지난 entry 제거", () => {
  const NOW = "2026-05-27T00:00:00Z";
  const entries = [
    { ts: new Date(Date.parse(NOW) - 1 * 86400000).toISOString(), dedupe_key: "live-1" },
    { ts: new Date(Date.parse(NOW) - 10 * 86400000).toISOString(), dedupe_key: "expired" },
    { ts: new Date(Date.parse(NOW) - 5 * 86400000).toISOString(), dedupe_key: "live-2" },
  ];
  const result = pruneCache(entries, NOW);
  assert.equal(result.length, 2);
  assert.ok(result.some((e) => e.dedupe_key === "live-1"));
  assert.ok(result.some((e) => e.dedupe_key === "live-2"));
});

test("pruneCache — null / 비배열 안전", () => {
  assert.deepEqual(pruneCache(null), []);
  assert.deepEqual(pruneCache("string"), []);
  assert.deepEqual(pruneCache([]), []);
});

test("buildPRBody — schema 출력 (verdict / signal_type / L5 / dedupe / rollback)", () => {
  const md = buildPRBody({
    record: {
      verdict: VERDICTS.PARTIAL,
      signal_type: SIGNAL_TYPES.TODO_STALE,
      title: "stale TODO",
      file: "src/foo.mjs",
      line: 10,
    },
    l5: {
      decision: L5_DECISIONS.PR_DRAFT,
      rationale: "stale TODO",
      user_surface_value: L5_SURFACE_VALUES.MEDIUM,
      cost_units: 1,
    },
    dedupe_key: "abc123",
  });
  assert.match(md, /verdict: PARTIAL/);
  assert.match(md, /signal_type: todo-stale/);
  assert.match(md, /file: src\/foo\.mjs:10/);
  assert.match(md, /decision: `pr_draft`/);
  assert.match(md, /dedupe_key/);
  assert.match(md, /`abc123`/);
  assert.match(md, /rollback 가이드/);
  assert.match(md, /draft/);
});

test("constants — CACHE_TTL_DAYS=7, PR_CONCURRENT_CAP=5", () => {
  assert.equal(CACHE_TTL_DAYS, 7);
  assert.equal(PR_CONCURRENT_CAP, 5);
});
