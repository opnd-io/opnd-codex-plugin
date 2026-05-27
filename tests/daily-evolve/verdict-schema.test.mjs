import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICTS,
  VERDICT_LIST,
  SIGNAL_TYPES,
  SIGNAL_TYPE_LIST,
  DEFAULT_SIGNAL_TYPE_FOR_MIGRATION,
  RECORD_SCHEMA,
  validateRecord,
  applyMigrationDefault,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/verdict-schema.mjs";

test("VERDICTS 5종 (research.md verdict schema 재사용)", () => {
  assert.deepEqual(
    [...VERDICT_LIST].sort(),
    ["FIXED", "NOT-FIXED", "PARTIAL", "QUESTION", "WONTFIX"].sort(),
  );
  assert.equal(VERDICTS.FIXED, "FIXED");
  assert.equal(VERDICTS.NOT_FIXED, "NOT-FIXED");
});

test("SIGNAL_TYPES 7종 (R2-M6 신규)", () => {
  assert.equal(SIGNAL_TYPE_LIST.length, 7);
  assert.ok(SIGNAL_TYPE_LIST.includes("upstream-issue"));
  assert.ok(SIGNAL_TYPE_LIST.includes("fork-import-candidate"));
  assert.ok(SIGNAL_TYPE_LIST.includes("memory-drift"));
});

test("validateRecord — valid pair 통과", () => {
  const r = validateRecord({ verdict: "FIXED", signal_type: "upstream-issue", extra: "ok" });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test("validateRecord — invalid verdict reject", () => {
  const r = validateRecord({ verdict: "MAYBE", signal_type: "upstream-issue" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /verdict "MAYBE"/);
});

test("validateRecord — invalid signal_type reject", () => {
  const r = validateRecord({ verdict: "FIXED", signal_type: "made-up-source" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /signal_type/);
});

test("validateRecord — null/array/non-object reject", () => {
  assert.equal(validateRecord(null).ok, false);
  assert.equal(validateRecord([]).ok, false);
  assert.equal(validateRecord("string").ok, false);
});

test("applyMigrationDefault — signal_type 부재 시 upstream-issue default 부여 (R3-M6)", () => {
  const out = applyMigrationDefault({ verdict: "FIXED" });
  assert.equal(out.signal_type, "upstream-issue");
  assert.equal(out.signal_type, DEFAULT_SIGNAL_TYPE_FOR_MIGRATION);
});

test("applyMigrationDefault — signal_type 있으면 유지 (변경 없으면 same ref OK)", () => {
  const input = { verdict: "FIXED", signal_type: "telemetry-ux" };
  const out = applyMigrationDefault(input);
  assert.equal(out.signal_type, "telemetry-ux");
  // input mutation 없음 검증 — signal_type 값 보존
  assert.equal(input.signal_type, "telemetry-ux");
});

test("applyMigrationDefault — signal_type 부재 시 새 객체 반환 (input mutation 없음)", () => {
  const input = { verdict: "FIXED" };
  const out = applyMigrationDefault(input);
  assert.equal(out.signal_type, "upstream-issue");
  // input 은 mutation 없음
  assert.equal(input.signal_type, undefined);
  // 새 객체
  assert.notEqual(out, input);
});

test("RECORD_SCHEMA — verdict + signal_type enum 일치", () => {
  assert.deepEqual([...RECORD_SCHEMA.properties.verdict.enum].sort(), [...VERDICT_LIST].sort());
  assert.deepEqual([...RECORD_SCHEMA.properties.signal_type.enum].sort(), [...SIGNAL_TYPE_LIST].sort());
});
