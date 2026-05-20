import test from "node:test";
import assert from "node:assert/strict";

import { TurnWatchdogError } from "../plugins/opnd-codex/scripts/lib/codex.mjs";

// Manual port of upstream PR #312 contract test — fork could not
// cherry-pick #312 cleanly (codex.mjs / codex-companion.mjs hardening
// diverged), so the helper class lives next to the watchdog
// implementation in lib/codex.mjs. Audit trail:
// docs/upstream-tracking/2026-05-18-upstream-backlog-audit.md axis R6
// Tier 1 Group B.

test("TurnWatchdogError carries code, exitCode, and metadata", () => {
  const err = new TurnWatchdogError("watchdog fired after 600000ms", {
    watchdogMs: 600000,
    threadId: "thr_123",
    turnId: "turn_456"
  });

  assert.equal(err.name, "TurnWatchdogError");
  assert.equal(err.code, "TURN_WATCHDOG_TIMEOUT");
  assert.equal(err.exitCode, 124);
  assert.equal(err.watchdogMs, 600000);
  assert.equal(err.threadId, "thr_123");
  assert.equal(err.turnId, "turn_456");
  assert.equal(err.message, "watchdog fired after 600000ms");
  assert.ok(err instanceof Error);
});

test("TurnWatchdogError defaults metadata to null when omitted", () => {
  const err = new TurnWatchdogError("silent");

  assert.equal(err.code, "TURN_WATCHDOG_TIMEOUT");
  assert.equal(err.exitCode, 124);
  assert.equal(err.watchdogMs, null);
  assert.equal(err.threadId, null);
  assert.equal(err.turnId, null);
});

test("codex-companion.mjs: TurnWatchdogError imported + main catch handles exit 124", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  // Import line includes TurnWatchdogError
  assert.match(
    source,
    /TurnWatchdogError\s*\n\s*\}\s*from\s*"\.\/lib\/codex\.mjs"/,
    "TurnWatchdogError imported from lib/codex.mjs"
  );
  // main catch handles TurnWatchdogError specifically with exit 124
  assert.match(
    source,
    /if \(error instanceof TurnWatchdogError\)/,
    "main catch checks TurnWatchdogError"
  );
  assert.match(
    source,
    /process\.exitCode = error\.exitCode \?\? 124/,
    "main catch uses exit code 124 (timeout(1) convention)"
  );
  assert.match(
    source,
    /"error":\s*"TurnWatchdogTimeout"|error: "TurnWatchdogTimeout"/,
    "structured JSON line emitted on stderr"
  );
});

test("lib/codex.mjs: watchdog helpers wired into captureTurn + runAppServerTurn", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/lib/codex.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /function disarmWatchdog\(state\)/, "disarmWatchdog defined");
  assert.match(source, /function armWatchdog\(state\)/, "armWatchdog defined");
  assert.match(source, /function kickWatchdog\(state\)/, "kickWatchdog defined");

  // captureTurn arms watchdog before startRequest and disarms in finally
  const captureBlock = source.match(/async function captureTurn[\s\S]+?^\}/m);
  assert.ok(captureBlock, "captureTurn block found");
  assert.match(captureBlock[0], /armWatchdog\(state\)/, "captureTurn arms watchdog");
  assert.match(captureBlock[0], /kickWatchdog\(state\)/, "notification handler kicks watchdog");
  assert.match(captureBlock[0], /disarmWatchdog\(state\)/, "captureTurn disarms watchdog");

  // runAppServerTurn forwards watchdogMs option + CODEX_TURN_WATCHDOG_MS env
  assert.match(
    source,
    /watchdogMs:\s*\n?\s*typeof options\.watchdogMs === "number"/,
    "runAppServerTurn forwards options.watchdogMs"
  );
  assert.match(
    source,
    /Number\(process\.env\.CODEX_TURN_WATCHDOG_MS\)/,
    "runAppServerTurn falls back to CODEX_TURN_WATCHDOG_MS env"
  );

  // completeTurn calls disarmWatchdog so a normal completion does not leak the timer
  assert.match(source, /function completeTurn[\s\S]+?disarmWatchdog\(state\)/, "completeTurn disarms watchdog");
});
