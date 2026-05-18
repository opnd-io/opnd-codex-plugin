import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { maybeRingCompletionBell } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

// PR-7.4 (#134) — opt-in audible completion bell.
//
// Contract:
//   - Default OFF. The helper returns false and writes nothing when
//     CODEX_PLUGIN_BELL_ON_COMPLETE is unset / empty / "0" / "false" / "no".
//   - Opt-in via CODEX_PLUGIN_BELL_ON_COMPLETE=1 (also "true" / "yes",
//     case-insensitive). Writes one ASCII BEL character (`\x07`) to stderr.
//   - Best-effort: never throws on a broken stderr.
//   - Wired into every terminal-state hook (runTrackedJob success +
//     runTrackedJob throw + markJobTerminated + handleCancelCommand)
//     so any way a job ends, the bell fires once.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED = path.join(ROOT, "plugins", "codex", "scripts", "lib", "tracked-jobs.mjs");
const COMPANION = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Helper: maybeRingCompletionBell behavior
// ---------------------------------------------------------------------------

test("default OFF: empty / unset env → no bell, returns false", () => {
  for (const env of [{}, { CODEX_PLUGIN_BELL_ON_COMPLETE: "" }, { CODEX_PLUGIN_BELL_ON_COMPLETE: "0" }, { CODEX_PLUGIN_BELL_ON_COMPLETE: "false" }, { CODEX_PLUGIN_BELL_ON_COMPLETE: "no" }, { CODEX_PLUGIN_BELL_ON_COMPLETE: "off" }]) {
    let returnValue;
    const captured = captureStderr(() => {
      returnValue = maybeRingCompletionBell(env);
    });
    assert.equal(returnValue, false, `env=${JSON.stringify(env)} returns false`);
    assert.equal(captured, "", `env=${JSON.stringify(env)} writes nothing`);
  }
});

test("opt-in via CODEX_PLUGIN_BELL_ON_COMPLETE=1: writes a single BEL to stderr, returns true", () => {
  let returnValue;
  const captured = captureStderr(() => {
    returnValue = maybeRingCompletionBell({ CODEX_PLUGIN_BELL_ON_COMPLETE: "1" });
  });
  assert.equal(returnValue, true);
  assert.equal(captured, "\x07", "exactly one ASCII BEL character");
  assert.equal(captured.length, 1, "single byte, no extra newline");
});

test("opt-in variants: 'true' / 'TRUE' / 'Yes' / 'yes' all enable", () => {
  for (const truthy of ["true", "TRUE", "Yes", "yes"]) {
    const captured = captureStderr(() => {
      maybeRingCompletionBell({ CODEX_PLUGIN_BELL_ON_COMPLETE: truthy });
    });
    assert.equal(captured, "\x07", `${truthy} enabled the bell`);
  }
});

test("opt-in does not double-fire on a single call (one call → one BEL)", () => {
  const captured = captureStderr(() => {
    maybeRingCompletionBell({ CODEX_PLUGIN_BELL_ON_COMPLETE: "1" });
  });
  assert.equal(captured.length, 1, "one call = one byte");
});

test("never throws even if stderr.write throws", () => {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => {
    throw new Error("stderr is broken");
  };
  let threw = null;
  let returnValue;
  try {
    returnValue = maybeRingCompletionBell({ CODEX_PLUGIN_BELL_ON_COMPLETE: "1" });
  } catch (error) {
    threw = error;
  } finally {
    process.stderr.write = original;
  }
  assert.equal(threw, null, "helper must not propagate stderr error");
  assert.equal(returnValue, false, "returns false when write fails");
});

// ---------------------------------------------------------------------------
// Source-level wire-up: every terminal-state hook calls maybeRingCompletionBell
// ---------------------------------------------------------------------------

test("tracked-jobs.mjs: runTrackedJob success path calls maybeRingCompletionBell", () => {
  const source = fs.readFileSync(TRACKED, "utf8");
  const runTracked = source.match(/export async function runTrackedJob[\s\S]+?^\}/m);
  assert.ok(runTracked, "runTrackedJob found");
  // Two terminal arms (success + throw catch) → at least two calls.
  const calls = (runTracked[0].match(/maybeRingCompletionBell\(\)/g) ?? []).length;
  assert.ok(calls >= 2, `expected ≥2 bell calls in runTrackedJob, got ${calls}`);
});

test("tracked-jobs.mjs: markJobTerminated (signal teardown) calls maybeRingCompletionBell", () => {
  const source = fs.readFileSync(TRACKED, "utf8");
  const markTerminated = source.match(/function markJobTerminated[\s\S]+?^\}/m);
  assert.ok(markTerminated, "markJobTerminated found");
  assert.match(markTerminated[0], /maybeRingCompletionBell\(\)/, "bell wired into signal teardown");
});

test("codex-companion.mjs: handleCancelCommand calls maybeRingCompletionBell", () => {
  const source = fs.readFileSync(COMPANION, "utf8");
  assert.match(source, /import \{[^}]*\bmaybeRingCompletionBell\b[^}]*\} from "\.\/lib\/tracked-jobs\.mjs"/s, "imports the helper");
  // The cancel path lives near "phase: \"cancelled\"" writes. Confirm the
  // bell is invoked AFTER the state writes, before the user-visible
  // payload, so the bell only fires once teardown is complete.
  const cancelArea = source.match(/cancel is a terminal state[\s\S]+?maybeRingCompletionBell\(\);[\s\S]+?renderCancelReport/i);
  assert.ok(cancelArea, "cancel-path bell wired between state writes and render");
});

// ---------------------------------------------------------------------------
// Env var name + default-off invariants (regression guards)
// ---------------------------------------------------------------------------

test("env var name is CODEX_PLUGIN_BELL_ON_COMPLETE (not e.g. CODEX_BELL or CODEX_NOTIFY)", () => {
  // The name matches the rest of the v2.1.0 env-var naming convention
  // (CODEX_PLUGIN_*). Regression guard so a future rename does not silently
  // break user setups documented under the canonical name.
  const source = fs.readFileSync(TRACKED, "utf8");
  assert.match(source, /BELL_ENV = "CODEX_PLUGIN_BELL_ON_COMPLETE"/);
});

test("default behavior: a fresh env with no CODEX_PLUGIN_BELL_ON_COMPLETE → silent", () => {
  // Most-critical invariant: a user who installs the plugin and does not
  // know about this env var must NEVER hear an unexpected bell.
  const captured = captureStderr(() => {
    maybeRingCompletionBell({});
  });
  assert.equal(captured, "", "blank env produces zero bytes on stderr");
});
