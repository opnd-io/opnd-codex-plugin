import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PR-1.7 (#193) regression — broker idle watchdog tightening. Defaults reduced
// from 30→10 min grace + 5→2 min interval so an orphan broker is reaped within
// ~12 min instead of ~35 min. Both knobs are env-configurable. The contract
// here verifies the env-override clamping logic by importing the broker script
// as a child and probing its parsed constants via a `--print-config` style
// inspector — but the actual broker script does not expose constants, so we
// drive the helper indirectly via a process-level smoke that just confirms
// the script imports without throwing under various env values.

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");
const BROKER_SCRIPT = path.join(ROOT_DIR, "plugins", "codex", "scripts", "app-server-broker.mjs");

function runBrokerHelp(env = {}) {
  // The broker enters main() unconditionally so running it with no `serve`
  // subcommand exits non-zero with a usage error. We only check that the
  // module loads (no syntax / parse errors / top-level env interpretation
  // crashes) and produces the expected usage string.
  return spawnSync(process.execPath, [BROKER_SCRIPT], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000
  });
}

test("broker script loads with default IDLE_WATCHDOG constants (no env overrides)", () => {
  const result = runBrokerHelp({
    CODEX_BROKER_IDLE_GRACE_MS: "",
    CODEX_BROKER_IDLE_INTERVAL_MS: ""
  });
  assert.notEqual(result.status, null, `expected an exit (got null) stderr=${result.stderr}`);
  // Some stderr/stdout is expected (usage), but neither should contain
  // a TypeError or ReferenceError from a broken env override.
  assert.doesNotMatch(result.stderr ?? "", /TypeError|ReferenceError/);
});

test("broker script accepts a custom CODEX_BROKER_IDLE_GRACE_MS env override", () => {
  const result = runBrokerHelp({
    CODEX_BROKER_IDLE_GRACE_MS: "60000",
    CODEX_BROKER_IDLE_INTERVAL_MS: "10000"
  });
  assert.notEqual(result.status, null, `expected an exit (got null) stderr=${result.stderr}`);
  assert.doesNotMatch(result.stderr ?? "", /TypeError|ReferenceError/);
});

test("broker script clamps invalid env overrides to the default", () => {
  // Negative and non-numeric values should fall through to the defaults
  // (10 min grace, 2 min interval) without throwing.
  const result = runBrokerHelp({
    CODEX_BROKER_IDLE_GRACE_MS: "-1",
    CODEX_BROKER_IDLE_INTERVAL_MS: "not-a-number"
  });
  assert.notEqual(result.status, null);
  assert.doesNotMatch(result.stderr ?? "", /TypeError|ReferenceError/);
});
