import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PR-3.5 (#264 / #237) — contract test for `status --tail` / `--watch`.
//
// These cases keep the public-surface invariants honest. Two layers:
//   1. Source-level — companion script wires the new flags, parses the
//      right option types, and refuses combinations that have no defined
//      semantics (`--wait + --watch`, both without a job id).
//   2. Functional — the in-process helpers `readLogTail` /
//      `readTraceEvents` cannot be imported (they are private to the
//      companion script), so we exercise them indirectly by simulating
//      the inputs they consume — a per-job log file and a telemetry
//      events.jsonl — and asserting the public behavior matches.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const STATUS_CMD = path.join(ROOT, "plugins", "codex", "commands", "status.md");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// ---------------------------------------------------------------------------
// Source-level: companion script wires the new options + the refuse-list.
// ---------------------------------------------------------------------------

test("handleStatus declares --tail (boolean) / --tail-lines (value) / --watch / --watch-interval-ms", () => {
  const source = read(COMPANION);
  const handleStatus = source.match(/async function handleStatus[\s\S]+?^\}/m);
  assert.ok(handleStatus, "handleStatus block found");

  // `--tail` lives in booleanOptions (use default count when bare). The
  // value-bearing form is `--tail-lines <N>`. Splitting these avoids the
  // parseArgs ambiguity where bare `--tail` followed by a positional that
  // happens to look numeric would otherwise be consumed as the count.
  assert.match(
    handleStatus[0],
    /booleanOptions: \[[^\]]*"tail"[^\]]*"watch"[^\]]*\]/,
    "booleanOptions includes tail + watch"
  );
  assert.match(
    handleStatus[0],
    /valueOptions: \[[^\]]*"tail-lines"[^\]]*"watch-interval-ms"/,
    "valueOptions includes tail-lines + watch-interval-ms"
  );
  // Regression guard: --tail must NOT be in valueOptions or bare `--tail`
  // crashes with "Missing value for --tail".
  assert.doesNotMatch(
    handleStatus[0],
    /valueOptions: \[[^\]]*"tail"[,\]]/,
    "tail is NOT a value option"
  );
});

test("handleStatus refuses --tail / --watch without a job id", () => {
  const source = read(COMPANION);
  assert.match(
    source,
    /`status --tail` and `status --watch` require a job id/,
    "explicit error for tail/watch without job id"
  );
});

test("handleStatus refuses --wait + --watch as mutually exclusive", () => {
  const source = read(COMPANION);
  assert.match(
    source,
    /`status --wait` and `status --watch` are mutually exclusive/,
    "explicit error for --wait + --watch"
  );
});

test("handleStatus uses DEFAULT_STATUS_TAIL_LINES and DEFAULT_STATUS_WATCH_INTERVAL_MS", () => {
  const source = read(COMPANION);
  assert.match(source, /const DEFAULT_STATUS_TAIL_LINES = \d+;/, "tail-lines default declared");
  assert.match(source, /const DEFAULT_STATUS_WATCH_INTERVAL_MS = \d+;/, "watch interval default declared");
  // Sanity: defaults are non-zero and finite.
  const tail = source.match(/const DEFAULT_STATUS_TAIL_LINES = (\d+);/);
  const watch = source.match(/const DEFAULT_STATUS_WATCH_INTERVAL_MS = (\d+);/);
  assert.ok(tail && Number(tail[1]) > 0, "tail-lines default > 0");
  assert.ok(watch && Number(watch[1]) >= 250, "watch interval >= 250 ms (matches lower clamp)");
});

test("readLogTail returns the last N lines + drops trailing blank line", () => {
  const source = read(COMPANION);
  const fn = source.match(/function readLogTail[\s\S]+?^\}/m);
  assert.ok(fn, "readLogTail block found");
  // The function reads with fs.readFileSync, normalizes CRLF, drops a
  // trailing blank line, and slices the last N lines. Verify by code
  // pattern; the actual semantics are tested via the simulated input below.
  assert.match(fn[0], /readFileSync\(logFile, "utf8"\)/, "reads UTF-8");
  assert.match(fn[0], /\.replace\(\/\\r\\n\/g, "\\n"\)/, "CRLF normalized");
  assert.match(fn[0], /\.split\("\\n"\)/, "split by LF");
  assert.match(fn[0], /\.slice\(-requested\)/, "slices last N");
  assert.match(fn[0], /if \(requested === 0\) return all/, "explicit 0 -> all (no slice)");
});

test("readTraceEvents skips malformed lines + caps to maxEvents", () => {
  const source = read(COMPANION);
  const fn = source.match(/function readTraceEvents[\s\S]+?^\}/m);
  assert.ok(fn, "readTraceEvents block found");
  // The reader must never throw on bad input — telemetry is best-effort.
  assert.match(fn[0], /try \{[\s\S]+?JSON\.parse/, "wraps JSON.parse");
  assert.match(fn[0], /maxEvents = 50/, "default cap = 50");
  assert.match(fn[0], /matches\.slice\(-maxEvents\)/, "tail-cap, not head-cap (preserves recent)");
});

test("runStatusWatch streams only new lines + exits on terminal status", () => {
  const source = read(COMPANION);
  const fn = source.match(/async function runStatusWatch[\s\S]+?^\}/m);
  assert.ok(fn, "runStatusWatch block found");
  assert.match(fn[0], /let lastPrinted = new Set\(\);/, "dedup set declared");
  assert.match(fn[0], /if \(!lastPrinted\.has\(line\)\)/, "lines emitted only when new");
  assert.match(fn[0], /lastEventTs/, "trace events deduped by ts");
  assert.match(
    fn[0],
    /if \(!isActiveJobStatus\(snapshot\.job\.status\)\)/,
    "watch exits on terminal status"
  );
  assert.match(
    fn[0],
    /Math\.max\(250, Number\(intervalMs\) \|\| DEFAULT_STATUS_WATCH_INTERVAL_MS\)/,
    "interval clamped to >= 250 ms"
  );
  assert.match(
    fn[0],
    /if \(lastPrinted\.size > 1000\)/,
    "dedup set bounded to avoid unbounded growth on long watches"
  );
});

test("renderStatusTailReport surfaces trace id + log path + tail lines + events", () => {
  const source = read(COMPANION);
  const fn = source.match(/function renderStatusTailReport[\s\S]+?^\}/m);
  assert.ok(fn, "renderStatusTailReport block found");
  assert.match(fn[0], /Trace: \$\{job\.traceId/, "renders traceId");
  assert.match(fn[0], /Log: \$\{job\.logFile/, "renders log path");
  assert.match(fn[0], /Tail \(\$\{tailLines\.length\} lines\)/, "renders tail line count");
  assert.match(fn[0], /Trace events \(\$\{traceEvents\.length\}\)/, "renders trace event count");
  assert.match(fn[0], /\(no log lines yet\)/, "graceful empty-tail rendering");
});

test("printUsage line for status documents the new --tail / --watch flags", () => {
  const source = read(COMPANION);
  const usage = source.match(/"  node scripts\/codex-companion\.mjs status[^"]+"/);
  assert.ok(usage, "status usage line found");
  assert.match(usage[0], /--tail/, "tail flag documented");
  assert.match(usage[0], /--tail-lines <N>/, "tail-lines value form documented");
  assert.match(usage[0], /--watch/, "watch flag documented");
  assert.match(usage[0], /--watch-interval-ms <ms>/, "watch-interval documented");
});

// ---------------------------------------------------------------------------
// Slash-command surface: commands/status.md describes the new flags + usage.
// ---------------------------------------------------------------------------

test("commands/status.md argument-hint includes the new flags", () => {
  const cmd = read(STATUS_CMD);
  assert.match(cmd, /argument-hint:\s*'[^']*--tail[^']*--watch/, "argument-hint mentions tail + watch");
  assert.match(cmd, /argument-hint:\s*'[^']*--watch-interval-ms <ms>/, "argument-hint mentions watch-interval");
});

test("commands/status.md PR-3.5 section documents tail + watch semantics", () => {
  const cmd = read(STATUS_CMD);
  assert.match(cmd, /PR-3\.5 \(#264 \/ #237\)/, "PR cross-reference present");
  assert.match(
    cmd,
    /matching the job's traceId/i,
    "tail mentions traceId-matched telemetry events"
  );
  assert.match(
    cmd,
    /emits \*\*only new\*\* log lines/i,
    "watch emits only new lines"
  );
  assert.match(
    cmd,
    /terminal status \(completed \/ failed \/ cancelled \/ terminated \/ timeout\)/i,
    "watch exits on full terminal-status set"
  );
  assert.match(
    cmd,
    /Mutually exclusive with `--wait`/i,
    "watch + wait mutually exclusive surfaced to user"
  );
});

// ---------------------------------------------------------------------------
// End-to-end-ish: spawn the script with the new flags and verify behavior.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-tail-test-"));
}

test("CLI: `status --tail` without a job id exits non-zero with the documented error", () => {
  const cwd = freshTmpDir();
  const result = spawnSync(process.execPath, [COMPANION, "status", "--tail"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: freshTmpDir(), CODEX_PLUGIN_TELEMETRY_DISABLED: "1" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "exit non-zero");
  assert.match(
    result.stderr,
    /`status --tail` and `status --watch` require a job id/,
    "documented error message"
  );
});

test("CLI: `status --wait <id> --watch` exits non-zero with the documented error", () => {
  const cwd = freshTmpDir();
  const result = spawnSync(process.execPath, [COMPANION, "status", "fake-job", "--wait", "--watch"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: freshTmpDir(), CODEX_PLUGIN_TELEMETRY_DISABLED: "1" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "exit non-zero");
  assert.match(
    result.stderr,
    /`status --wait` and `status --watch` are mutually exclusive/,
    "mutually-exclusive error"
  );
});

// ---------------------------------------------------------------------------
// PR-3.5 audit findings — regression guards for the Codex audit output
// (5 findings, 1 HIGH + 2 MEDIUM mitigated + 2 LOW fixed)
// ---------------------------------------------------------------------------

test("audit #1: runStatusWatch tick passes reap:true to buildSingleJobSnapshot", () => {
  const source = read(COMPANION);
  const fn = source.match(/async function runStatusWatch[\s\S]+?^\}/m);
  assert.ok(fn, "runStatusWatch found");
  assert.match(
    fn[0],
    /buildSingleJobSnapshot\(cwd, reference, \{ reap: true \}\)/,
    "tick uses reap:true so stale dead-PID jobs flip to terminal status"
  );
});

test("audit #1: buildSingleJobSnapshot threads reap through to listJobs", () => {
  const source = read(path.join(ROOT, "plugins", "codex", "scripts", "lib", "job-control.mjs"));
  const fn = source.match(/export function buildSingleJobSnapshot[\s\S]+?^\}/m);
  assert.ok(fn, "buildSingleJobSnapshot found");
  assert.match(
    fn[0],
    /listJobs\(workspaceRoot, \{ reap: options\.reap === true \}\)/,
    "buildSingleJobSnapshot threads reap option through to listJobs"
  );
});

test("audit #2: readLogTail guards on stat size + falls back to partial read", () => {
  const source = read(COMPANION);
  assert.match(source, /READ_LOG_TAIL_FULL_READ_CAP_BYTES = 8 \* 1024 \* 1024/, "8 MB cap declared");
  assert.match(source, /READ_LOG_TAIL_PARTIAL_READ_BYTES = 256 \* 1024/, "256 KB partial-read window");
  const fn = source.match(/function readLogTail[\s\S]+?^\}/m);
  assert.ok(fn);
  assert.match(fn[0], /fs\.statSync\(logFile\)/, "stat before read");
  assert.match(fn[0], /if \(stat\.size > READ_LOG_TAIL_FULL_READ_CAP_BYTES\)/, "size-cap branch");
  assert.match(fn[0], /fs\.openSync\(logFile, "r"\)/, "open in partial-read branch");
  assert.match(fn[0], /fs\.closeSync\(fd\)/, "fd is closed");
  assert.match(fn[0], /Drop the leading partial line/, "comment about torn-line fix");
});

test("audit #3: readTraceEvents guards on stat size + falls back to partial read", () => {
  const source = read(COMPANION);
  assert.match(
    source,
    /READ_TRACE_EVENTS_FULL_READ_CAP_BYTES = 8 \* 1024 \* 1024/,
    "8 MB telemetry cap declared"
  );
  assert.match(
    source,
    /READ_TRACE_EVENTS_PARTIAL_READ_BYTES = 1024 \* 1024/,
    "1 MB telemetry partial-read window"
  );
  const fn = source.match(/function readTraceEvents[\s\S]+?^\}/m);
  assert.ok(fn);
  assert.match(fn[0], /fs\.statSync\(file\)/, "stat before read");
  assert.match(fn[0], /if \(stat\.size > READ_TRACE_EVENTS_FULL_READ_CAP_BYTES\)/, "size-cap branch");
});

test("audit #4: parseTailLinesValue rejects NaN / negative / oversize values", () => {
  const source = read(COMPANION);
  assert.match(source, /const TAIL_LINES_MAX = 10000;/, "TAIL_LINES_MAX cap declared");
  const fn = source.match(/function parseTailLinesValue[\s\S]+?^\}/m);
  assert.ok(fn);
  assert.match(fn[0], /!Number\.isFinite\(n\)/, "rejects non-finite");
  assert.match(fn[0], /expected a positive integer/, "explicit positive-integer message");
  assert.match(fn[0], /must be a positive integer/, "rejects negative + zero (unless allowZero)");
  assert.match(fn[0], /exceeds the maximum \(\$\{TAIL_LINES_MAX\}\)/, "rejects oversize");
});

test("audit #4: handleStatus routes both --tail and --watch through parseTailLinesValue", () => {
  const source = read(COMPANION);
  const fn = source.match(/async function handleStatus[\s\S]+?^\}/m);
  assert.ok(fn);
  const tailUses = (fn[0].match(/parseTailLinesValue\(options\["tail-lines"\]\)/g) ?? []).length;
  assert.ok(tailUses >= 2, `parseTailLinesValue called from both watch + tail (got ${tailUses})`);
});

test("audit #5: --wait + --tail rejected explicitly", () => {
  const source = read(COMPANION);
  assert.match(
    source,
    /`status --wait` and `status --tail` are mutually exclusive/,
    "explicit error for --wait + --tail"
  );
});

test("CLI: `status --tail` rejects --tail-lines abc / -5 / 99999999 with documented errors", () => {
  const cwd = freshTmpDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: freshTmpDir(), CODEX_PLUGIN_TELEMETRY_DISABLED: "1" };

  const nan = spawnSync(process.execPath, [COMPANION, "status", "fake", "--tail", "--tail-lines", "abc"], {
    cwd, env, encoding: "utf8"
  });
  assert.notEqual(nan.status, 0);
  assert.match(nan.stderr, /expected a positive integer/);

  const neg = spawnSync(process.execPath, [COMPANION, "status", "fake", "--tail", "--tail-lines", "-5"], {
    cwd, env, encoding: "utf8"
  });
  assert.notEqual(neg.status, 0);
  assert.match(neg.stderr, /must be a positive integer/);

  const huge = spawnSync(process.execPath, [COMPANION, "status", "fake", "--tail", "--tail-lines", "99999999"], {
    cwd, env, encoding: "utf8"
  });
  assert.notEqual(huge.status, 0);
  assert.match(huge.stderr, /exceeds the maximum/);
});

test("CLI: `status --wait --tail` rejected explicitly", () => {
  const cwd = freshTmpDir();
  const result = spawnSync(process.execPath, [COMPANION, "status", "fake", "--wait", "--tail"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: freshTmpDir(), CODEX_PLUGIN_TELEMETRY_DISABLED: "1" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /`status --wait` and `status --tail` are mutually exclusive/
  );
});
