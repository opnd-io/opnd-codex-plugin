import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TurnWatchdogError,
  resumeTimedOutThread,
  runAppServerTurnWithTimeoutResume
} from "../plugins/opnd-codex/scripts/lib/codex.mjs";
import {
  SKIP_REASON_RETRY_BUDGET_EXCEEDED,
  SKIP_REASON_TIMEOUT
} from "../plugins/opnd-codex/scripts/lib/codex-skip-taxonomy.js";

function fakeSpawnFactory({ stdout = "", stderr = "", exitCode = 0, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killCalls = [];
    child.kill = (signal) => {
      child.killCalls.push(signal);
      return true;
    };
    setImmediate(() => {
      if (stdout) {
        child.stdout.emit("data", stdout);
      }
      if (stderr) {
        child.stderr.emit("data", stderr);
      }
      if (!hang) {
        child.emit("close", exitCode, null);
      }
    });
    return child;
  };
  return { calls, spawnImpl };
}

test("runAppServerTurnWithTimeoutResume resumes once after a turn timeout", async () => {
  const timeout = new TurnWatchdogError("watchdog timeout", {
    threadId: "thread-timeout",
    watchdogMs: 10
  });
  let resumeCalls = 0;

  const result = await runAppServerTurnWithTimeoutResume(process.cwd(), {
    env: {},
    runTurnImpl: async () => {
      throw timeout;
    },
    resumeTimedOutThreadImpl: async (threadId) => {
      resumeCalls += 1;
      assert.equal(threadId, "thread-timeout");
      return {
        status: 0,
        stdout: "final output\n",
        stderr: "",
        timedOut: false
      };
    }
  });

  assert.equal(resumeCalls, 1);
  assert.equal(result.status, 0);
  assert.equal(result.threadId, "thread-timeout");
  assert.equal(result.finalMessage, "final output");
  assert.equal(result.error, null);
  assert.equal(result.retryInfo.recovered, true);
});

test("runAppServerTurnWithTimeoutResume returns retry_budget_exceeded when resume also times out", async () => {
  const timeout = new TurnWatchdogError("watchdog timeout", {
    threadId: "thread-budget",
    watchdogMs: 10
  });
  let resumeCalls = 0;

  const result = await runAppServerTurnWithTimeoutResume(process.cwd(), {
    env: {},
    runTurnImpl: async () => {
      throw timeout;
    },
    resumeTimedOutThreadImpl: async () => {
      resumeCalls += 1;
      return {
        status: 124,
        stdout: "",
        stderr: "still waiting\n",
        timedOut: true,
        error: new Error("resume timed out")
      };
    }
  });

  assert.equal(resumeCalls, 1);
  assert.equal(result.status, 124);
  assert.equal(result.error.skipReason, SKIP_REASON_RETRY_BUDGET_EXCEEDED);
  assert.equal(result.error.threadId, "thread-budget");
  assert.equal(result.retryInfo.resumeAttempts, 1);
  assert.match(result.error.message, /retry budget exceeded/);
});

test("runAppServerTurnWithTimeoutResume does not resume successful turns", async () => {
  let resumeCalls = 0;
  const result = await runAppServerTurnWithTimeoutResume(process.cwd(), {
    runTurnImpl: async () => ({
      status: 0,
      threadId: "thread-ok",
      turnId: "turn-ok",
      finalMessage: "ok",
      reasoningSummary: [],
      turn: { id: "turn-ok", status: "completed" },
      error: null,
      stderr: "",
      fileChanges: [],
      touchedFiles: [],
      commandExecutions: []
    }),
    resumeTimedOutThreadImpl: async () => {
      resumeCalls += 1;
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    }
  });

  assert.equal(resumeCalls, 0);
  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "ok");
});

test("resumeTimedOutThread spawns codex exec resume with stdin ignored", async () => {
  const { calls, spawnImpl } = fakeSpawnFactory({ stdout: "done\n" });
  const result = await resumeTimedOutThread("thread-spawn", {
    cwd: process.cwd(),
    env: {},
    spawnImpl,
    timeoutMs: 1000
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args, [
    "exec",
    "resume",
    "thread-spawn",
    "도구 사용 금지, 즉시 최종 출력"
  ]);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "done\n");
});

test("resumeTimedOutThread classifies its own timeout", async () => {
  const { spawnImpl } = fakeSpawnFactory({ hang: true });
  const result = await resumeTimedOutThread("thread-timeout", {
    cwd: process.cwd(),
    env: {},
    spawnImpl,
    timeoutMs: 5
  });

  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.error.skipReason, SKIP_REASON_TIMEOUT);
  assert.equal(result.error.threadId, "thread-timeout");
});
