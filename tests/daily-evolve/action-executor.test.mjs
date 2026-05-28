/**
 * action-executor.test.mjs — Phase 4 orchestrator unit test
 *
 * skipPersistence=true 로 state IO 격리.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  execute,
  recordDedupeKey,
} from "../../plugins/opnd-codex/scripts/daily-evolve/action-executor.mjs";
import { SIGNAL_TYPES, VERDICTS } from "../../plugins/opnd-codex/scripts/daily-evolve/lib/verdict-schema.mjs";
import { L5_DECISIONS, PR_CONCURRENT_CAP } from "../../plugins/opnd-codex/scripts/daily-evolve/lib/action-policy.mjs";

const NOW = "2026-05-27T00:00:00Z";

test("execute — autonomous_safe TODO_STALE → pr_draft candidate", () => {
  const records = [
    {
      triage: "autonomous_safe",
      signal_type: SIGNAL_TYPES.TODO_STALE,
      verdict: VERDICTS.PARTIAL,
      age_days: 45,
      file: "src/foo.mjs",
      line: 42,
      title: "stale TODO #1",
    },
  ];
  const result = execute({ records, skipPersistence: true, nowIso: NOW });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].l5.decision, L5_DECISIONS.PR_DRAFT);
  assert.ok(result.candidates[0].dedupe_key);
  assert.ok(result.candidates[0].pr_body.length > 0);
  assert.equal(result.surfaced.length, 0);
  assert.equal(result.action_summary.candidates_count, 1);
});

test("execute — needs_user / skip 분기", () => {
  const records = [
    { triage: "autonomous_safe", signal_type: SIGNAL_TYPES.UNRELEASED_GAP, verdict: VERDICTS.PARTIAL, ref: "foo.mjs", title: "unreleased gap" },
    { triage: "autonomous_safe", signal_type: SIGNAL_TYPES.UPSTREAM_ISSUE, verdict: VERDICTS.FIXED, title: "already fixed" },
  ];
  const result = execute({ records, skipPersistence: true, nowIso: NOW });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.surfaced.length, 1); // unreleased_gap → needs_user
  assert.equal(result.skipped.length, 1); // upstream FIXED → skip + low value
  assert.equal(result.surfaced[0].l5.decision, L5_DECISIONS.NEEDS_USER);
});

test("execute — non-autonomous_safe (needs_user / needs_claude_judgment) 제외", () => {
  const records = [
    { triage: "needs_user", signal_type: SIGNAL_TYPES.TODO_STALE, age_days: 45, title: "user-decided" },
    { triage: "needs_claude_judgment", signal_type: SIGNAL_TYPES.UPSTREAM_ISSUE, verdict: VERDICTS.QUESTION, title: "claude" },
    { triage: "autonomous_safe", signal_type: SIGNAL_TYPES.TODO_STALE, age_days: 50, file: "x.mjs", line: 1, title: "safe" },
  ];
  const result = execute({ records, skipPersistence: true, nowIso: NOW });
  assert.equal(result.action_summary.input_total, 3);
  assert.equal(result.action_summary.autonomous_input, 1);
  assert.equal(result.candidates.length, 1);
});

test("execute — 5 PR cap → cap 초과 후보 needs_user surface", () => {
  // 6개 autonomous_safe TODO_STALE → 5 candidate + 1 surfaced (cap exceeded)
  const records = Array.from({ length: PR_CONCURRENT_CAP + 1 }, (_, i) => ({
    triage: "autonomous_safe",
    signal_type: SIGNAL_TYPES.TODO_STALE,
    verdict: VERDICTS.PARTIAL,
    age_days: 45,
    file: `src/foo-${i}.mjs`,
    line: i + 1,
    title: `stale TODO ${i}`,
  }));
  const result = execute({ records, skipPersistence: true, nowIso: NOW });
  assert.equal(result.candidates.length, PR_CONCURRENT_CAP);
  assert.equal(result.surfaced.length, 1);
  assert.equal(result.surfaced[0].surface_reason, "pr_cap_exceeded");
  assert.equal(result.action_summary.cap_exceeded, true);
});

test("execute — dedupe key 같은 record skip (Phase 4 PoC: 매 호출 fresh cache, dedupe within batch)", () => {
  // 같은 record 2개 — 첫 candidate 후 cache 에 들어가서 두 번째 dedupe_cached
  const sameRecord = {
    triage: "autonomous_safe",
    signal_type: SIGNAL_TYPES.TODO_STALE,
    verdict: VERDICTS.PARTIAL,
    age_days: 45,
    file: "src/foo.mjs",
    line: 42,
    title: "duplicate TODO",
  };
  const result = execute({
    records: [sameRecord, { ...sameRecord }],
    skipPersistence: true,
    nowIso: NOW,
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].skip_reason, "dedupe_cached");
});

test("recordDedupeKey — 같은 record 동일 key", () => {
  const r1 = {
    signal_type: SIGNAL_TYPES.TODO_STALE,
    verdict: VERDICTS.PARTIAL,
    file: "src/foo.mjs",
    title: "stale TODO",
  };
  const r2 = { ...r1 };
  assert.equal(recordDedupeKey(r1), recordDedupeKey(r2));
});

test("recordDedupeKey — 다른 verdict 면 다른 key", () => {
  const r1 = { signal_type: SIGNAL_TYPES.UPSTREAM_ISSUE, verdict: VERDICTS.FIXED, title: "x" };
  const r2 = { signal_type: SIGNAL_TYPES.UPSTREAM_ISSUE, verdict: VERDICTS.NOT_FIXED, title: "x" };
  assert.notEqual(recordDedupeKey(r1), recordDedupeKey(r2));
});

test("execute — empty records", () => {
  const result = execute({ records: [], skipPersistence: true, nowIso: NOW });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.surfaced.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.action_summary.input_total, 0);
});

test("action_summary schema — 필드 모두 존재", () => {
  const result = execute({ records: [], skipPersistence: true });
  const s = result.action_summary;
  assert.ok("input_total" in s);
  assert.ok("autonomous_input" in s);
  assert.ok("candidates_count" in s);
  assert.ok("surfaced_count" in s);
  assert.ok("skipped_count" in s);
  assert.ok("cost_units" in s);
  assert.ok("pr_cap" in s);
  assert.ok("cap_exceeded" in s);
});
