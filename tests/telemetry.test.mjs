import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTraceId,
  emitEvent,
  isTelemetryDisabled,
  resolveTelemetryDir,
  resolveTelemetryFile,
  EVENT_NAMES,
  ERROR_CLASSES,
  SCHEMA_VERSION
} from "../plugins/codex/scripts/lib/telemetry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const TRACKED = path.join(ROOT, "plugins", "codex", "scripts", "lib", "tracked-jobs.mjs");

function freshTmpDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-telemetry-test-"));
}

function freshEnv(overrides = {}) {
  return {
    CLAUDE_PLUGIN_DATA: freshTmpDataRoot(),
    CODEX_PLUGIN_TELEMETRY_DISABLED: "",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// PR-9.2 — correlation id (trace.id)
// ---------------------------------------------------------------------------

test("createTraceId returns a 16-char lowercase hex string", () => {
  const id = createTraceId();
  assert.match(id, /^[0-9a-f]{16}$/, "16-char hex");
});

test("createTraceId is collision-resistant for typical use", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) ids.add(createTraceId());
  assert.equal(ids.size, 1000, "no collisions in 1000 ids");
});

// ---------------------------------------------------------------------------
// PR-9.1 — JSONL event log
// ---------------------------------------------------------------------------

test("emitEvent writes one valid JSON line per call with the v1 schema", () => {
  const env = freshEnv();
  const ok = emitEvent("enqueued", {
    traceId: "abc123",
    jobId: "task-test-1",
    jobClass: "rescue",
    phase: "queued",
    cwd: "/repo/x"
  }, { env });
  assert.equal(ok, true, "emitEvent returned true on success");

  const lines = fs.readFileSync(resolveTelemetryFile(env), "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "one line written");

  const record = JSON.parse(lines[0]);
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.event, "enqueued");
  assert.equal(record.traceId, "abc123");
  assert.equal(record.jobId, "task-test-1");
  assert.equal(record.jobClass, "rescue");
  assert.equal(record.phase, "queued");
  assert.equal(record.cwd, "/repo/x");
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "ISO 8601 ts");
});

test("emitEvent appends — second call adds a second line, never truncates", () => {
  const env = freshEnv();
  emitEvent("enqueued", { traceId: "t1", jobId: "j1" }, { env });
  emitEvent("started",  { traceId: "t1", jobId: "j1" }, { env });
  emitEvent("completed", { traceId: "t1", jobId: "j1", elapsedMs: 1234 }, { env });

  const lines = fs.readFileSync(resolveTelemetryFile(env), "utf8").trim().split("\n");
  assert.equal(lines.length, 3, "three lines written");
  const events = lines.map((l) => JSON.parse(l).event);
  assert.deepEqual(events, ["enqueued", "started", "completed"], "order preserved");
});

test("emitEvent puts unknown fields under `extras`, not at the top level", () => {
  const env = freshEnv();
  emitEvent("progress", {
    traceId: "t1",
    jobId: "j1",
    customField: "should-end-up-in-extras",
    anotherOne: 42
  }, { env });
  const record = JSON.parse(fs.readFileSync(resolveTelemetryFile(env), "utf8").trim());
  assert.equal(record.customField, undefined, "unknown key not at top level");
  assert.deepEqual(record.extras, { customField: "should-end-up-in-extras", anotherOne: 42 });
});

test("emitEvent drops undefined/null values entirely (no key emitted)", () => {
  const env = freshEnv();
  emitEvent("started", {
    traceId: "t1",
    jobId: "j1",
    elapsedMs: undefined,
    errorClass: null
  }, { env });
  const record = JSON.parse(fs.readFileSync(resolveTelemetryFile(env), "utf8").trim());
  assert.ok(!("elapsedMs" in record), "undefined dropped");
  assert.ok(!("errorClass" in record), "null dropped");
});

test("CODEX_PLUGIN_TELEMETRY_DISABLED=1 short-circuits all writes", () => {
  const env = freshEnv({ CODEX_PLUGIN_TELEMETRY_DISABLED: "1" });
  const ok = emitEvent("enqueued", { traceId: "t1", jobId: "j1" }, { env });
  assert.equal(ok, false, "emitEvent returned false when disabled");
  assert.equal(
    fs.existsSync(resolveTelemetryFile(env)),
    false,
    "no file should be created"
  );
});

test("isTelemetryDisabled accepts 1/true/yes (case-insensitive) and rejects other values", () => {
  for (const truthy of ["1", "true", "TRUE", "Yes", "yes"]) {
    assert.equal(
      isTelemetryDisabled({ CODEX_PLUGIN_TELEMETRY_DISABLED: truthy }),
      true,
      `truthy: ${truthy}`
    );
  }
  for (const falsy of ["", "0", "false", "no", "off", "anything-else"]) {
    assert.equal(
      isTelemetryDisabled({ CODEX_PLUGIN_TELEMETRY_DISABLED: falsy }),
      false,
      `falsy: ${falsy}`
    );
  }
});

test("emitEvent never throws on filesystem errors (best-effort write)", () => {
  // Point CLAUDE_PLUGIN_DATA at a path that cannot be created (a regular
  // file used as if it were a parent dir). emitEvent should swallow the
  // ENOTDIR error and return false — never propagate.
  const blockingFile = path.join(freshTmpDataRoot(), "this-is-a-file-not-a-dir");
  fs.writeFileSync(blockingFile, "blocked\n");
  const env = { CLAUDE_PLUGIN_DATA: blockingFile, CODEX_PLUGIN_TELEMETRY_DISABLED: "" };

  let threw = null;
  let ok = null;
  try {
    ok = emitEvent("enqueued", { traceId: "t1", jobId: "j1" }, { env });
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, null, "emitEvent must not throw");
  assert.equal(ok, false, "emitEvent returned false on FS failure");
});

test("emitEvent rejects empty event name + non-Date now()", () => {
  const env = freshEnv();
  assert.equal(emitEvent("", { traceId: "t1" }, { env }), false, "empty event name rejected");
  assert.equal(
    emitEvent("started", { traceId: "t1" }, { env, now: () => "not-a-date" }),
    false,
    "non-Date now() rejected"
  );
  // No file written for either failure.
  assert.equal(fs.existsSync(resolveTelemetryFile(env)), false);
});

test("EVENT_NAMES + ERROR_CLASSES contracts (frozen + load-bearing)", () => {
  // These are part of the public schema for the JSONL stream. Any change
  // here is observable to downstream telemetry consumers (Grafana / scripts
  // / etc.) so the regression guard fails the build instead of silently
  // shifting the wire shape.
  assert.deepEqual(EVENT_NAMES, [
    "enqueued",
    "started",
    "progress",
    "completed",
    "failed",
    "cancelled",
    "terminated",
    "timeout"
  ]);
  assert.deepEqual(ERROR_CLASSES, [
    "rate-limit",
    "auth",
    "sandbox",
    "timeout",
    "parse",
    "network",
    "broker",
    "other"
  ]);
  assert.equal(Object.isFrozen(EVENT_NAMES), true);
  assert.equal(Object.isFrozen(ERROR_CLASSES), true);
});

test("resolveTelemetryDir + resolveTelemetryFile honor CLAUDE_PLUGIN_DATA", () => {
  const env = freshEnv();
  assert.equal(resolveTelemetryDir(env), path.join(env.CLAUDE_PLUGIN_DATA, "telemetry"));
  assert.equal(
    resolveTelemetryFile(env),
    path.join(env.CLAUDE_PLUGIN_DATA, "telemetry", "events.jsonl")
  );
});

test("resolveTelemetryDir falls back to tmpdir when CLAUDE_PLUGIN_DATA is unset", () => {
  const env = { CODEX_PLUGIN_TELEMETRY_DISABLED: "" };
  const dir = resolveTelemetryDir(env);
  assert.ok(dir.startsWith(os.tmpdir()), "fallback under tmpdir");
  assert.ok(dir.endsWith(path.join("codex-companion", "telemetry")), "fallback path shape");
});

// ---------------------------------------------------------------------------
// PR-9.1/9.2 — integration with the companion script (source-level)
// ---------------------------------------------------------------------------

test("codex-companion imports telemetry helpers + emits at enqueue", () => {
  const source = fs.readFileSync(COMPANION, "utf8");
  assert.match(
    source,
    /import \{ createTraceId, emitEvent \} from "\.\/lib\/telemetry\.mjs"/,
    "imports both helpers"
  );

  const enqueueBlock = source.match(/function enqueueBackgroundTask[\s\S]+?^}/m);
  assert.ok(enqueueBlock, "enqueueBackgroundTask block found");
  assert.match(enqueueBlock[0], /const traceId = createTraceId\(\);/, "creates a traceId");
  assert.match(enqueueBlock[0], /traceId,/, "stores traceId on the job record");
  assert.match(enqueueBlock[0], /emitEvent\("enqueued"/, "emits enqueued event");
  assert.match(enqueueBlock[0], /jobClass: job\.jobClass \?\? job\.kind \?\? "task"/, "carries jobClass");
});

test("codex-companion emits a cancelled event in handleCancelCommand", () => {
  const source = fs.readFileSync(COMPANION, "utf8");
  // Don't anchor to the full async function (too brittle); instead require
  // that an emitEvent("cancelled", ...) call exists alongside the cancelled
  // status write.
  assert.match(source, /emitEvent\("cancelled",[\s\S]+?phase: "cancelled"/, "cancelled emit present");
  assert.match(source, /turnInterruptAttempted: interrupt\.attempted/, "carries cancel-specific fields");
});

test("tracked-jobs imports telemetry helpers + emits start/completed/failed/terminated", () => {
  const source = fs.readFileSync(TRACKED, "utf8");
  assert.match(
    source,
    /import \{ createTraceId, emitEvent \} from "\.\/telemetry\.mjs"/,
    "imports both helpers"
  );

  const runTracked = source.match(/export async function runTrackedJob[\s\S]+?^}/m);
  assert.ok(runTracked, "runTrackedJob block found");
  assert.match(runTracked[0], /const traceId = job\.traceId \?\? createTraceId\(\)/, "trace propagation");
  assert.match(runTracked[0], /emitEvent\("started"/, "started emit");
  assert.match(runTracked[0], /emitEvent\(completionStatus,/, "completion emit (completed|failed)");
  assert.match(runTracked[0], /emitEvent\("failed"/, "throw-path failed emit");

  // markJobTerminated lives outside runTrackedJob but the file should still
  // emit a terminated event from it.
  assert.match(source, /emitEvent\("terminated",[\s\S]+?phase: "terminated"/, "terminated emit");
  assert.match(source, /errorClass: "other"/, "terminated emit classifies error");
});

test("queued payload returned by enqueueBackgroundTask exposes the traceId", () => {
  const source = fs.readFileSync(COMPANION, "utf8");
  const enqueueBlock = source.match(/function enqueueBackgroundTask[\s\S]+?^}/m);
  assert.ok(enqueueBlock);
  // payload includes traceId so the caller can echo it to the user.
  assert.match(enqueueBlock[0], /payload:[\s\S]+?traceId\b/, "payload carries traceId");
});

// ---------------------------------------------------------------------------
// PR-9.1 audit findings — regression guards for the Codex audit output
// (5 findings, 2 fixed in code, 3 fixed in docs/comments)
// ---------------------------------------------------------------------------

test("audit #2: runTrackedJob wraps pre-run state-persist + emits failed on throw", () => {
  const source = fs.readFileSync(TRACKED, "utf8");
  const runTracked = source.match(/export async function runTrackedJob[\s\S]+?^}/m);
  assert.ok(runTracked, "runTrackedJob block found");

  // The pre-run writeJobFile/upsertJob pair must be inside a try/catch that
  // emits a `failed` event before re-throwing, so a synchronous throw in
  // state persistence does NOT leave the job invisible to telemetry.
  assert.match(
    runTracked[0],
    /try \{\s*\n\s*writeJobFile\(job\.workspaceRoot[\s\S]+?upsertJob\(job\.workspaceRoot, runningRecord\);\s*\n\s*\} catch \(initError\)/,
    "pre-run state writes are wrapped in try/catch"
  );
  assert.match(
    runTracked[0],
    /catch \(initError\) \{[\s\S]+?emitEvent\("failed",[\s\S]+?stage: "pre-run-state-persist"[\s\S]+?throw initError;/,
    "throws emit failed event with pre-run-state-persist stage marker then re-throw"
  );
});

test("audit #3: cancelled emit falls back to createTraceId when no traceId is known", () => {
  const source = fs.readFileSync(COMPANION, "utf8");
  // The cancelled emit must use `existing.traceId ?? job.traceId ?? createTraceId()`
  // so jobs cancelled before runTrackedJob ever attached a trace still satisfy
  // the "every event has a traceId" invariant from TROUBLESHOOTING.md.
  assert.match(
    source,
    /traceId: existing\.traceId \?\? job\.traceId \?\? createTraceId\(\)/,
    "cancelled path falls through to createTraceId() when traceId is absent"
  );
});

test("audit #1: telemetry module documents the concurrent-append safety boundary", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "plugins", "codex", "scripts", "lib", "telemetry.mjs"),
    "utf8"
  );
  // The doc-comment must spell out (a) POSIX PIPE_BUF assumption, (b) the
  // Windows lack-of-guarantee, (c) the lib/state.mjs lock pattern as the
  // fix if concurrency grows. Without this, a future maintainer might
  // silently switch to async I/O and reintroduce the race.
  assert.match(source, /Concurrent append safety \(audit finding #1\)/, "audit finding cross-reference present");
  assert.match(source, /PIPE_BUF/, "POSIX 4096-byte atomicity boundary named");
  assert.match(source, /Windows/, "Windows caveat called out");
  assert.match(source, /lib\/state\.mjs lock pattern/, "fix path named");
  assert.match(source, /do NOT silently switch to async I\/O/, "anti-pattern warning present");
});

test("audit #4: telemetry module documents the extras field-name reservation rule", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "plugins", "codex", "scripts", "lib", "telemetry.mjs"),
    "utf8"
  );
  assert.match(
    source,
    /`extras` field-name reservation \(audit finding #4\)/,
    "audit finding cross-reference present"
  );
  assert.match(source, /bump SCHEMA_VERSION/, "promotion rule explicit");
  assert.match(source, /do not demote/, "demotion rule explicit");
});

test("audit #5: MIGRATION_v2.0.md splits v2.1.0 telemetry env vars into their own section", () => {
  const migration = fs.readFileSync(path.join(ROOT, "docs", "MIGRATION_v2.0.md"), "utf8");
  assert.match(migration, /## New v2\.0\.0 env vars/, "v2.0.0 env var section present");
  assert.match(migration, /## New v2\.1\.0 env vars \(observability\)/, "v2.1.0 section split out");

  // Telemetry env vars must live under the v2.1.0 section, not the v2.0.0
  // section — regression guard for the labeling drift the audit caught.
  const v20Section = migration.match(/## New v2\.0\.0 env vars[\s\S]+?(?=## )/);
  assert.ok(v20Section, "v2.0.0 section block found");
  assert.doesNotMatch(
    v20Section[0],
    /CODEX_PLUGIN_TELEMETRY_DISABLED/,
    "telemetry env var must NOT live under v2.0.0"
  );
  assert.doesNotMatch(
    v20Section[0],
    /CODEX_PLUGIN_TELEMETRY_DEBUG/,
    "telemetry debug env var must NOT live under v2.0.0"
  );

  const v21Section = migration.match(/## New v2\.1\.0 env vars[\s\S]+?(?=\n##|\n---)/);
  assert.ok(v21Section, "v2.1.0 section block found");
  assert.match(v21Section[0], /CODEX_PLUGIN_TELEMETRY_DISABLED/);
  assert.match(v21Section[0], /CODEX_PLUGIN_TELEMETRY_DEBUG/);
});
