import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Contract tests for the A1-A4 fixes from the Claude×Codex adversarial
// pair-readiness review (docs/code-review/2026-05-20-pair-readiness-adversarial.md).
// These guard against regressing the fixes; they are source-level contract
// checks consistent with the existing turn-watchdog / commands test style.

const companionUrl = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url);
const codexUrl = new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url);
const brokerUrl = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url);

test("A1 — waitForApprovalDecision is bounded by a timeout", () => {
  const source = fs.readFileSync(companionUrl, "utf8");

  assert.match(source, /const DEFAULT_APPROVAL_WAIT_TIMEOUT_MS = /, "approval wait timeout constant defined");
  assert.match(source, /CODEX_PLUGIN_APPROVAL_WAIT_MS/, "CODEX_PLUGIN_APPROVAL_WAIT_MS env override exists");

  const block = source.match(/async function waitForApprovalDecision[\s\S]+?\n\}/);
  assert.ok(block, "waitForApprovalDecision block found");
  assert.match(block[0], /const deadline =/, "computes a deadline");
  assert.match(block[0], /Date\.now\(\) >= deadline/, "loop body checks the deadline");
  assert.match(block[0], /timed out after/, "throws a clear timeout error on expiry");
});

test("A2 — turn watchdog defaults ON with a conservative bound + escape hatch", () => {
  const source = fs.readFileSync(codexUrl, "utf8");

  assert.match(source, /const DEFAULT_TURN_WATCHDOG_MS = /, "DEFAULT_TURN_WATCHDOG_MS constant defined");
  assert.match(source, /function resolveDefaultTurnWatchdogMs\(\)/, "resolveDefaultTurnWatchdogMs helper defined");
  // runAppServerTurn falls back to the resolver when no explicit option is passed
  assert.match(source, /:\s*resolveDefaultTurnWatchdogMs\(\)/, "runAppServerTurn uses the default-on resolver");
  // CODEX_TURN_WATCHDOG_MS=0 is the explicit disable escape hatch
  assert.match(source, /override > 0 \? override : null/, "CODEX_TURN_WATCHDOG_MS=0 disables the watchdog");
});

test("A3 — teardownBrokerSession defaults to a real process-tree kill", () => {
  const source = fs.readFileSync(brokerUrl, "utf8");

  assert.match(source, /import \{ terminateProcessTree \} from "\.\/process\.mjs"/, "terminateProcessTree imported");
  const block = source.match(/export function teardownBrokerSession[\s\S]+?\n\}/);
  assert.ok(block, "teardownBrokerSession block found");
  assert.match(block[0], /killProcess \?\? terminateProcessTree/, "null killProcess falls back to terminateProcessTree");
});

test("A4 — prompt-file containment resolves symlinks before the check", () => {
  const source = fs.readFileSync(companionUrl, "utf8");

  // realpathSync is applied to both the resolved path and cwd so a symlink
  // inside cwd pointing outside cannot bypass CODEX_PLUGIN_PROMPT_FILE_STRICT.
  assert.match(source, /realResolved = fs\.realpathSync\(resolved\)/, "resolved path realpath-resolved");
  assert.match(source, /realCwd = fs\.realpathSync\(cwd\)/, "cwd realpath-resolved");
  assert.match(source, /path\.relative\(realCwd, realResolved\)/, "containment check uses the realpath-resolved pair");
});
