import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_STATUS,
  emptyLedger,
  yearlyFilePath,
  buildEntry,
  finalizeEntry,
  validateEntry,
  queryLastN,
  mergeLedgers,
  appendEntry,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/run-ledger.mjs";

test("RUN_STATUS enum 4종", () => {
  assert.equal(RUN_STATUS.RUNNING, "running");
  assert.equal(RUN_STATUS.SUCCESS, "success");
  assert.equal(RUN_STATUS.FAILURE, "failure");
  assert.equal(RUN_STATUS.PARTIAL, "partial");
});

test("emptyLedger — schema_version 1 + 빈 runs", () => {
  const l = emptyLedger(2026);
  assert.equal(l.schema_version, 1);
  assert.equal(l.year, 2026);
  assert.deepEqual(l.runs, []);
});

test("yearlyFilePath — UTC ISO 의 YYYY slice (R4-M4)", () => {
  assert.equal(
    yearlyFilePath("2026-05-27T05:19:03.043Z"),
    "state/daily-evolve-runs-2026.json",
  );
  assert.equal(
    yearlyFilePath("2099-12-31T23:59:59Z"),
    "state/daily-evolve-runs-2099.json",
  );
});

test("yearlyFilePath — yearly boundary (Codex review LOW)", () => {
  // 2025-12-31T23:59:59Z (마지막 second of 2025) → 2025
  assert.equal(
    yearlyFilePath("2025-12-31T23:59:59Z"),
    "state/daily-evolve-runs-2025.json",
  );
  // 2026-01-01T00:00:00Z (첫 second of 2026) → 2026
  assert.equal(
    yearlyFilePath("2026-01-01T00:00:00Z"),
    "state/daily-evolve-runs-2026.json",
  );
  // 1 ms 차이의 경계도 정확 분리
  assert.equal(
    yearlyFilePath("2025-12-31T23:59:59.999Z"),
    "state/daily-evolve-runs-2025.json",
  );
  assert.equal(
    yearlyFilePath("2026-01-01T00:00:00.000Z"),
    "state/daily-evolve-runs-2026.json",
  );
});

test("yearlyFilePath — invalid input throw", () => {
  assert.throws(() => yearlyFilePath(null));
  assert.throws(() => yearlyFilePath("abc"));
});

test("buildEntry — status=running, ended_at=null", () => {
  const e = buildEntry({
    run_id: "test-id",
    started_at: "2026-05-27T00:00:00Z",
  });
  assert.equal(e.status, RUN_STATUS.RUNNING);
  assert.equal(e.ended_at, null);
  assert.equal(e.duration_ms, null);
  assert.deepEqual(e.decision_count, {
    autonomous_safe: 0,
    needs_user: 0,
    needs_claude_judgment: 0,
  });
});

test("finalizeEntry — status 전이 + duration_ms 계산", () => {
  const e = buildEntry({
    run_id: "x",
    started_at: "2026-05-27T00:00:00Z",
  });
  const f = finalizeEntry(e, {
    status: RUN_STATUS.SUCCESS,
    ended_at: "2026-05-27T00:01:30Z", // +90s
    actionable_count: 7,
  });
  assert.equal(f.status, "success");
  assert.equal(f.duration_ms, 90000);
  assert.equal(f.actionable_count, 7);
});

test("finalizeEntry — invalid status throw", () => {
  const e = buildEntry({ run_id: "x", started_at: "2026-05-27T00:00:00Z" });
  assert.throws(() => finalizeEntry(e, { status: "bogus", ended_at: "2026-05-27T00:00:00Z" }));
});

test("validateEntry — valid entry 통과", () => {
  const e = buildEntry({ run_id: "x", started_at: "2026-05-27T00:00:00Z" });
  assert.equal(validateEntry(e).ok, true);
});

test("validateEntry — missing run_id reject", () => {
  const e = buildEntry({ run_id: "", started_at: "2026-05-27T00:00:00Z" });
  assert.equal(validateEntry(e).ok, false);
});

test("validateEntry — phase_reached out of range reject", () => {
  const e = buildEntry({ run_id: "x", started_at: "2026-05-27T00:00:00Z", phase_reached: 99 });
  assert.equal(validateEntry(e).ok, false);
});

test("queryLastN — descending by started_at", () => {
  const ledger = {
    runs: [
      { started_at: "2026-05-25T00:00:00Z", run_id: "a" },
      { started_at: "2026-05-27T00:00:00Z", run_id: "c" },
      { started_at: "2026-05-26T00:00:00Z", run_id: "b" },
    ],
  };
  const last2 = queryLastN(ledger, 2);
  assert.equal(last2.length, 2);
  assert.equal(last2[0].run_id, "c");
  assert.equal(last2[1].run_id, "b");
});

test("queryLastN — invalid input → []", () => {
  assert.deepEqual(queryLastN(null, 3), []);
  assert.deepEqual(queryLastN({ runs: [] }, 0), []);
});

test("mergeLedgers — last 2 연도 머지 (Phase 6 use case)", () => {
  const l1 = { runs: [{ started_at: "2025-12-31T00:00:00Z", run_id: "old" }] };
  const l2 = { runs: [{ started_at: "2026-01-01T00:00:00Z", run_id: "new" }] };
  const merged = mergeLedgers([l1, l2]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].run_id, "new"); // newest first
});

test("appendEntry — immutable (새 ledger 반환)", () => {
  const before = emptyLedger(2026);
  const entry = buildEntry({ run_id: "x", started_at: "2026-05-27T00:00:00Z" });
  const after = appendEntry(before, entry);
  assert.equal(before.runs.length, 0); // mutation 없음
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].run_id, "x");
});
