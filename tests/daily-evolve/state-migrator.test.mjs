import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIGRATIONS,
  LATEST,
  FAILURE_REASONS,
  MigrationError,
  migrate,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/state-migrator.mjs";

test("LATEST table — 5 fileType (R3-H4)", () => {
  assert.equal(Object.keys(LATEST).length, 5);
  assert.equal(LATEST["daily-evolve-pr-cache"], 1);
  assert.equal(LATEST["daily-evolve-runs"], 1);
});

test("MIGRATIONS table — 모든 fileType 의 v1 entry 존재", () => {
  for (const ft of Object.keys(LATEST)) {
    assert.equal(typeof MIGRATIONS[ft][1], "function", `missing ${ft} v1`);
  }
});

test("migrate — schema_version 일치 시 pass-through", () => {
  const data = { schema_version: 1, runs: [] };
  const result = migrate("daily-evolve-runs", data);
  assert.equal(result, data); // 참조 동일 (pass-through)
});

test("migrate — unknown fileType throw (R4-H2)", () => {
  try {
    migrate("unknown-state-file", { schema_version: 1 });
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof MigrationError);
    assert.equal(err.reason, FAILURE_REASONS.UNKNOWN_FILETYPE);
  }
});

test("migrate — downgrade blocked throw (R4-H2)", () => {
  try {
    migrate("daily-evolve-runs", { schema_version: 99 }); // v99 > LATEST v1
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof MigrationError);
    assert.equal(err.reason, FAILURE_REASONS.DOWNGRADE_BLOCKED);
  }
});

test("migrate — missing schema_version throw (R3-H4)", () => {
  try {
    migrate("daily-evolve-runs", { runs: [] });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.reason, FAILURE_REASONS.MISSING_SCHEMA_VERSION);
  }
});

test("migrate — non-object data throw (corrupt-like)", () => {
  try {
    migrate("daily-evolve-runs", null);
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.reason, FAILURE_REASONS.CORRUPT_JSON);
  }
});

test("migrate — array data throw", () => {
  try {
    migrate("daily-evolve-runs", [1, 2, 3]);
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.reason, FAILURE_REASONS.CORRUPT_JSON);
  }
});

test("FAILURE_REASONS enum — 5종 (R5-M2 digest failure_reason 매핑)", () => {
  assert.equal(FAILURE_REASONS.UNKNOWN_FILETYPE, "unknown_filetype");
  assert.equal(FAILURE_REASONS.MISSING_MIGRATION, "missing_migration");
  assert.equal(FAILURE_REASONS.DOWNGRADE_BLOCKED, "downgrade_blocked");
  assert.equal(FAILURE_REASONS.CORRUPT_JSON, "corrupt_json");
  assert.equal(FAILURE_REASONS.MISSING_SCHEMA_VERSION, "missing_schema_version");
});

test("MigrationError — name + reason + details 보존", () => {
  const err = new MigrationError(FAILURE_REASONS.UNKNOWN_FILETYPE, "test", { fileType: "x" });
  assert.equal(err.name, "MigrationError");
  assert.equal(err.reason, "unknown_filetype");
  assert.deepEqual(err.details, { fileType: "x" });
});
