import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCommandInvocation, terminateProcessTree } from "../plugins/opnd-codex/scripts/lib/process.mjs";

test("buildCommandInvocation routes Windows cmd shims through cmd.exe without shell mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-process-"));
  const shim = path.join(dir, "codex.cmd");
  fs.writeFileSync(shim, "@echo off\r\n");

  const invocation = buildCommandInvocation(shim, ["app-server"], {
    platform: "win32",
    env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }
  });

  assert.equal(path.basename(invocation.command).toLowerCase(), process.env.ComSpec ? path.basename(process.env.ComSpec).toLowerCase() : "cmd.exe");
  assert.equal(invocation.shell, false);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /^call /);
  assert.match(invocation.args[3], /codex\.cmd/);
  assert.match(invocation.args[3], /"app-server"/);
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree reports ambiguous taskkill failures instead of killing a single pid", () => {
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "win32",
        isProcessRunningImpl: () => true,
        runCommandImpl(command, args) {
          return {
            command,
            args,
            status: 255,
            signal: null,
            stdout: "",
            stderr: "localized taskkill failure text",
            error: null
          };
        }
      }),
    /localized taskkill failure text/
  );
});

test("terminateProcessTree treats an already-exited Windows root process as stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    isProcessRunningImpl: () => false,
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr: "localized taskkill failure text",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
});
