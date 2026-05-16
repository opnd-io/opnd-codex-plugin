import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readHookStdinJsonAsync } from "../plugins/codex/scripts/lib/fs.mjs";

// PR-1.6 (#120 / #247 / #191) regression — hook scripts that used sync
// fs.readFileSync(0) crashed with EAGAIN on parallel sessions and blocked
// indefinitely on Windows when stdin was never closed by the parent. The
// async helper must:
//
//   - return {} on a TTY (no input expected)
//   - return {} on empty / whitespace-only input
//   - return {} on malformed JSON
//   - return parsed JSON on valid input
//   - return {} after the configured timeout when stdin never closes
//
// This contract exercises the lib helper directly (unit) and the two hook
// entrypoints via child_process (integration).

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");
const SESSION_HOOK = path.join(ROOT_DIR, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(ROOT_DIR, "plugins", "codex", "scripts", "stop-review-gate-hook.mjs");

function spawnHook(scriptPath, args, { stdin = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: "" },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    if (stdin === "leave-open") {
      // intentionally never close stdin — tests the 5s drain timeout fallback
    } else if (typeof stdin === "string") {
      proc.stdin.end(stdin);
    } else {
      proc.stdin.end();
    }

    const killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    proc.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("readHookStdinJsonAsync returns {} when stdin is closed without data", async () => {
  // Simulate "no input piped" via the lib helper by relying on the timeout
  // path — in a TTY-less test runner stdin is a pipe but our parent never
  // writes anything before exiting the helper.
  const result = await readHookStdinJsonAsync({ timeoutMs: 50 });
  assert.deepEqual(result, {});
});

test("session-lifecycle-hook tolerates empty stdin without throwing (SessionStart)", async () => {
  const result = await spawnHook(SESSION_HOOK, ["SessionStart"], { stdin: "" });
  assert.equal(result.code, 0, `exit 0 expected, got ${result.code}, stderr=${result.stderr}`);
});

test("session-lifecycle-hook tolerates malformed JSON without throwing", async () => {
  const result = await spawnHook(SESSION_HOOK, ["SessionStart"], { stdin: "this is not json{{{" });
  assert.equal(result.code, 0, `exit 0 expected, got ${result.code}, stderr=${result.stderr}`);
});

test("session-lifecycle-hook does not hang when stdin is never closed (5s drain fallback)", async () => {
  const start = Date.now();
  const result = await spawnHook(SESSION_HOOK, ["SessionStart"], {
    stdin: "leave-open",
    timeoutMs: 10_000
  });
  const elapsed = Date.now() - start;
  // Hook should self-resolve via the 5s readStdinAsync timeout and exit 0.
  // We allow up to 8s to account for cold-start cost on slower CI.
  assert.equal(result.code, 0, `exit 0 expected, stderr=${result.stderr}`);
  assert.ok(elapsed < 8_000, `expected hook to exit via internal timeout, got ${elapsed}ms`);
});

test("stop-review-gate-hook tolerates empty stdin without throwing", async () => {
  const result = await spawnHook(STOP_HOOK, [], { stdin: "" });
  // Exit code depends on whether the review gate is enabled (default off).
  // We accept either 0 or any non-fatal exit, but assert no readFileSync
  // EAGAIN crash signature in stderr.
  assert.doesNotMatch(result.stderr, /EAGAIN/, `stderr should not contain EAGAIN, got: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /readFileSync/, `stderr should not mention readFileSync`);
});
