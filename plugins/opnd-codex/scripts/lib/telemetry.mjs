// PR-9.1 + PR-9.2 — append-only JSONL event log + correlation id (trace.id)
// for cross-job observability.
//
// Design constraints (load-bearing — read before changing):
//   - Telemetry MUST never crash the caller. Every write is wrapped in
//     try/catch with a `silentFail` fallback. A failed telemetry write is
//     a no-op as far as the job lifecycle is concerned.
//   - Telemetry MUST be off-by-default-noisy but easy to suppress entirely.
//     `CODEX_PLUGIN_TELEMETRY_DISABLED=1` short-circuits every public entry
//     point before any filesystem access. Useful for CI runs and contract
//     tests that do not want the events.jsonl side effect.
//   - The log file is shared across workspaces by design — the point of
//     the telemetry stream is cross-job + cross-repo analytics. State that
//     should stay scoped to a workspace already lives in
//     `${CLAUDE_PLUGIN_DATA}/state/<workspace-slug>-<hash>/`.
//   - The schema is versioned. Bumping `SCHEMA_VERSION` requires updating
//     every emit site + the contract tests, so additive changes prefer
//     putting the new field under `extras`.
//   - **Concurrent append safety (audit finding #1):** the JSONL writer
//     relies on `fs.appendFileSync` for single-call line append. On POSIX
//     this is atomic for writes smaller than `PIPE_BUF` (4096 bytes), which
//     comfortably covers every event the schema can produce today (longest
//     observed line ~600 bytes). On Windows there is no documented atomic-
//     append guarantee from `WriteFile` against a file opened in append
//     mode by another process. In practice we have not observed interleave
//     on Win11 + NTFS at the volumes the plugin produces (one event per
//     job lifecycle, max ~6 events per job), but if you push this stream
//     to higher concurrency add the lib/state.mjs lock pattern around the
//     `appendFileSync` call below — do NOT silently switch to async I/O,
//     which would re-introduce the race here without warning.
//   - **`extras` field-name reservation (audit finding #4):** once a name
//     has appeared inside `extras` for any event, it is reserved at that
//     position. Promoting it to a top-level known field later forces every
//     downstream consumer to check both locations under the same
//     `schemaVersion: 1`, which we will not do — bump SCHEMA_VERSION
//     instead. Conversely, do not demote a top-level field into `extras`.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const DISABLE_ENV = "CODEX_PLUGIN_TELEMETRY_DISABLED";
const FALLBACK_DATA_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const TELEMETRY_DIR_NAME = "telemetry";
const TELEMETRY_FILE_NAME = "events.jsonl";

export const SCHEMA_VERSION = 1;

// Allowed event names — keep in sync with the contract test + the docs in
// docs/TROUBLESHOOTING.md (telemetry section). Unknown events are still
// emitted (we do not block on them), but tooling that reads the stream
// expects this set.
export const EVENT_NAMES = Object.freeze([
  "enqueued",      // job created + queued (background path)
  "started",       // job lifecycle began (foreground or worker pickup)
  "progress",      // phase transition or major progress signal
  "completed",     // terminal success
  "failed",        // terminal failure
  "cancelled",     // user-initiated cancel
  "terminated",    // killed (SIGTERM / pid reaper)
  "timeout"        // finalizing-phase or external timeout
]);

// Coarse error taxonomy — emit sites pick whichever bucket applies, or omit
// the field entirely if the event is not an error.
export const ERROR_CLASSES = Object.freeze([
  "rate-limit",
  "auth",
  "sandbox",
  "timeout",
  "parse",
  "network",
  "broker",
  "other"
]);

/**
 * Generate a 16-character hex correlation id (PR-9.2).
 *
 * Used to stitch together every event that belongs to a single logical run
 * across the broker / worker boundary. Long enough (64 bits of entropy) to
 * make collisions vanishingly unlikely for the lifetime of any practical
 * telemetry archive, short enough to copy/paste in a terminal.
 */
export function createTraceId() {
  return crypto.randomBytes(8).toString("hex");
}

export function isTelemetryDisabled(env = process.env) {
  const raw = String(env[DISABLE_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function resolveTelemetryDir(env = process.env) {
  const pluginDataDir = env[PLUGIN_DATA_ENV];
  const root = pluginDataDir ? pluginDataDir : FALLBACK_DATA_ROOT_DIR;
  return path.join(root, TELEMETRY_DIR_NAME);
}

export function resolveTelemetryFile(env = process.env) {
  return path.join(resolveTelemetryDir(env), TELEMETRY_FILE_NAME);
}

function silentFail(error) {
  // Telemetry is never load-bearing for the job lifecycle. Surfacing the
  // error would change behavior under load (disk full, permission denied,
  // path race during cleanup), which is exactly the situation in which we
  // most need the actual job to keep running. Stash the message somewhere
  // observable but cheap to ignore — stderr in debug-mode only.
  if (process.env.CODEX_PLUGIN_TELEMETRY_DEBUG === "1") {
    try {
      process.stderr.write(`[codex-telemetry] swallowed write error: ${error?.message ?? error}\n`);
    } catch {
      // Even debug output is best-effort.
    }
  }
}

/**
 * Emit one event to the shared JSONL log. Best-effort, never throws.
 *
 * Required:
 *   - event: one of EVENT_NAMES
 *   - traceId: correlation id (use createTraceId() if you do not have one)
 *
 * Optional structured fields are passed through verbatim. Unknown fields
 * land under `extras` so the schema can grow without a version bump.
 */
export function emitEvent(event, fields = {}, { env = process.env, now = () => new Date() } = {}) {
  if (isTelemetryDisabled(env)) {
    return false;
  }
  if (typeof event !== "string" || event.length === 0) {
    silentFail(new Error("emitEvent requires a non-empty event name"));
    return false;
  }
  const ts = now();
  if (!(ts instanceof Date) || Number.isNaN(ts.valueOf())) {
    silentFail(new Error("emitEvent received a non-Date `now()` result"));
    return false;
  }

  const knownKeys = new Set([
    "traceId", "jobId", "jobClass", "phase", "cwd",
    "elapsedMs", "errorClass", "fallbackPath", "model", "effort", "threadId"
  ]);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    ts: ts.toISOString(),
    event
  };
  const extras = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (knownKeys.has(key)) {
      record[key] = value;
    } else {
      extras[key] = value;
    }
  }
  if (Object.keys(extras).length > 0) {
    record.extras = extras;
  }

  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (error) {
    silentFail(error);
    return false;
  }

  const dir = resolveTelemetryDir(env);
  const file = resolveTelemetryFile(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, line, { encoding: "utf8" });
    return true;
  } catch (error) {
    silentFail(error);
    return false;
  }
}
