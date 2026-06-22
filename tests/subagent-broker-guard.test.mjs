import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

// A codex launcher that fails `--version` so getCodexAvailability reports the
// LOCAL codex as unavailable — simulates a subagent whose PATH cannot resolve a
// working codex while the (main-session) broker is what actually runs it.
function installBrokenCodex(binDir) {
  writeExecutable(path.join(binDir, "codex"), "#!/bin/sh\nexit 1\n");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), "@echo off\r\nexit /b 1\r\n", "utf8");
  }
}
import {
  CodexAppServerClient,
  NO_SURVIVABLE_BROKER_CODE,
  NO_SURVIVABLE_BROKER_MESSAGE
} from "../plugins/opnd-codex/scripts/lib/app-server.mjs";

/**
 * #21 — subagent-safe broker guard.
 *
 * A codex-rescue subagent runs inside a kill-on-close Job Object. It must NEVER
 * host the codex app-server in-process, nor lazily spawn a broker from its own
 * doomed job. `--require-broker` (always set by codex-rescue.md) forces the run
 * through a pre-existing main-session broker (warmed at SessionStart) and fails
 * fast with an actionable diagnostic if no live broker exists — surfaced on
 * STDOUT (exit 0) so the subagent passes it through instead of hiding it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "opnd-codex", "scripts", "codex-companion.mjs");
const AGENT_MD = path.join(ROOT, "plugins", "opnd-codex", "agents", "codex-rescue.md");

// Isolated state dir => no broker.json => no live broker; eager warm off.
function subagentEnv(binDir) {
  return {
    ...buildEnv(binDir), // prepends fake codex to PATH, deletes broker endpoint env
    CODEX_PLUGIN_DATA_DIR: makeTempDir("codex-data-"),
    CODEX_PLUGIN_EAGER_BROKER: "0"
  };
}

test("connect requireExistingBroker with no live broker throws the tagged #21 diagnostic (no spawn)", async () => {
  const dataDir = makeTempDir("codex-data-");
  const repo = makeTempDir();
  const savedData = process.env.CODEX_PLUGIN_DATA_DIR;
  const savedEndpoint = process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  process.env.CODEX_PLUGIN_DATA_DIR = dataDir;
  delete process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  try {
    await assert.rejects(
      () => CodexAppServerClient.connect(repo, { requireExistingBroker: true, brokerLivenessTimeoutMs: 200 }),
      (err) => {
        assert.equal(err.code, NO_SURVIVABLE_BROKER_CODE);
        assert.equal(err.message, NO_SURVIVABLE_BROKER_MESSAGE);
        return true;
      }
    );
  } finally {
    if (savedData === undefined) delete process.env.CODEX_PLUGIN_DATA_DIR;
    else process.env.CODEX_PLUGIN_DATA_DIR = savedData;
    if (savedEndpoint === undefined) delete process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
    else process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = savedEndpoint;
  }
});

test("task --require-broker --profile is rejected (direct-spawn flags incompatible with subagent guard)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, "task", "--require-broker", "--profile", "myprof", "do it"], {
    cwd: repo,
    env: subagentEnv(binDir)
  });
  assert.notEqual(result.status, 0);
  const out = result.stderr + result.stdout;
  assert.match(out, /cannot be combined with `--require-broker`/);
  assert.match(out, /#21/);
});

test("task --require-broker --fast is rejected", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, "task", "--require-broker", "--fast", "do it"], {
    cwd: repo,
    env: subagentEnv(binDir)
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /#21/);
});

test("foreground task --require-broker with no live broker => diagnostic on STDOUT, exit 0, not stderr", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, "task", "--require-broker", "investigate the bug"], {
    cwd: repo,
    env: subagentEnv(binDir)
  });
  assert.equal(result.status, 0, `exit 0 expected (diagnostic belongs on stdout); stderr=${result.stderr}`);
  assert.match(result.stdout, /#21/);
  assert.match(result.stdout, /main Claude thread/);
  assert.doesNotMatch(result.stderr, /#21/);
});

test("background task --require-broker with no live broker fails fast (no doomed local spawn)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, "task", "--background", "--require-broker", "investigate the bug"], {
    cwd: repo,
    env: subagentEnv(binDir)
  });
  assert.match(result.stdout, /could not be started|No live Codex broker/);
  assert.doesNotMatch(result.stdout, /started in the background/);
  assert.notEqual(result.status, 0, "a failed background launch exits non-zero for scripted callers");
});

// Codex review P2 — `--require-broker` must bypass the LOCAL codex availability
// check (the broker carries its own codex). Otherwise a subagent whose PATH
// cannot resolve codex fails before reaching the live broker, making the
// broker-only route unusable.
test("foreground task --require-broker bypasses the local codex availability check", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installBrokenCodex(binDir); // local `codex --version` fails -> getCodexAvailability unavailable
  const env = {
    ...buildEnv(binDir), // prepends the broken codex to PATH, deletes broker endpoint env
    CODEX_PLUGIN_DATA_DIR: makeTempDir("codex-data-"), // no broker
    CODEX_PLUGIN_EAGER_BROKER: "0"
  };
  const result = run("node", [SCRIPT, "task", "--require-broker", "do it"], { cwd: repo, env });
  // Reaches connect and reports the broker diagnostic — NOT a local "codex not installed" error.
  assert.match(result.stdout, /#21/);
  assert.doesNotMatch(result.stdout + result.stderr, /Codex CLI is not installed/);
});

test("codex-rescue agent always forwards --require-broker on the task invocation", () => {
  const md = fs.readFileSync(AGENT_MD, "utf8");
  assert.match(md, /codex-companion\.mjs" task --require-broker/);
  assert.match(md, /always (append|pass) `--require-broker`/i);
});
