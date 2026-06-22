import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  codexOnPath,
  eagerBrokerEnabled,
  warmBrokerBestEffort
} from "../plugins/opnd-codex/scripts/session-lifecycle-hook.mjs";

/**
 * #21 — eager broker warm-up at SessionStart.
 *
 * The foreground codex task path hosts the app-server under whatever process
 * spawns the broker. If the FIRST broker is spawned lazily from a `codex-rescue`
 * subagent, it lands in that subagent's kill-on-close Job Object and dies at
 * turn end (taking the result). Warming the broker from the main-session
 * SessionStart context (silent-breakaway Job Object) means later subagents
 * REUSE a surviving broker instead.
 *
 * These tests pin the gating logic (opt-out + cheap codex-on-PATH probe) with
 * an injected `ensureBroker` so no real broker is spawned.
 */

test("eagerBrokerEnabled defaults on, opts out on 0/false/off/no", () => {
  assert.equal(eagerBrokerEnabled({}), true);
  assert.equal(eagerBrokerEnabled({ CODEX_PLUGIN_EAGER_BROKER: "" }), true);
  assert.equal(eagerBrokerEnabled({ CODEX_PLUGIN_EAGER_BROKER: "1" }), true);
  for (const off of ["0", "false", "FALSE", "off", "Off", "no"]) {
    assert.equal(eagerBrokerEnabled({ CODEX_PLUGIN_EAGER_BROKER: off }), false, off);
  }
});

test("warmBrokerBestEffort: opted out -> no ensureBroker call", async () => {
  let called = false;
  const r = await warmBrokerBestEffort("/repo", {
    env: { CODEX_PLUGIN_EAGER_BROKER: "0", PATH: "/anything" },
    codexOnPath: () => true,
    ensureBroker: async () => {
      called = true;
      return { endpoint: "pipe:x" };
    }
  });
  assert.equal(called, false);
  assert.deepEqual(r, { warmed: false, reason: "opted-out" });
});

test("warmBrokerBestEffort: codex not on PATH -> no ensureBroker call", async () => {
  let called = false;
  const r = await warmBrokerBestEffort("/repo", {
    env: {},
    codexOnPath: () => false,
    ensureBroker: async () => {
      called = true;
      return { endpoint: "pipe:x" };
    }
  });
  assert.equal(called, false);
  assert.deepEqual(r, { warmed: false, reason: "codex-not-on-path" });
});

test("warmBrokerBestEffort: enabled + codex on PATH -> warms via ensureBroker", async () => {
  let seenCwd = null;
  const r = await warmBrokerBestEffort("/repo/root", {
    env: {},
    codexOnPath: () => true,
    ensureBroker: async (cwd) => {
      seenCwd = cwd;
      return { endpoint: "pipe:\\\\.\\pipe\\cxc-test" };
    }
  });
  assert.equal(seenCwd, "/repo/root");
  assert.deepEqual(r, { warmed: true, reason: "ok" });
});

test("warmBrokerBestEffort: ensureBroker not-ready -> warmed:false, no throw", async () => {
  const r = await warmBrokerBestEffort("/repo", {
    env: {},
    codexOnPath: () => true,
    ensureBroker: async () => null
  });
  assert.deepEqual(r, { warmed: false, reason: "not-ready" });
});

test("warmBrokerBestEffort: ensureBroker throws -> swallowed, never breaks session start", async () => {
  const r = await warmBrokerBestEffort("/repo", {
    env: {},
    codexOnPath: () => true,
    ensureBroker: async () => {
      throw new Error("broker spawn boom");
    }
  });
  assert.equal(r.warmed, false);
  assert.equal(r.reason, "error");
  assert.match(r.error, /broker spawn boom/);
});

test("codexOnPath: real probe against a temp dir with/without a codex launcher", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-path-"));
  assert.equal(codexOnPath({ PATH: dir }), false, "empty dir -> not found");
  const launcher = process.platform === "win32" ? "codex.exe" : "codex";
  fs.writeFileSync(path.join(dir, launcher), "#!/bin/sh\n", "utf8");
  assert.equal(codexOnPath({ PATH: dir }), true, "launcher present -> found");
  assert.equal(codexOnPath({ PATH: "" }), false, "empty PATH -> false");
});
