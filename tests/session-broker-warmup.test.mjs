import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  codexOnPath,
  eagerBrokerEnabled,
  maybeWarmBroker,
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

/**
 * #21 follow-up — maybeWarmBroker 는 SessionStart 와 UserPromptSubmit 가 공유하는
 * warm 게이트(QUAL-002 DRY). cwd 게이트 + best-effort 계약(QUAL-001/005)을 핀한다.
 */
test("maybeWarmBroker: input.cwd 있으면 warm 을 cwd 로 호출 (UserPromptSubmit/SessionStart dispatch)", async () => {
  let seenCwd = null;
  await maybeWarmBroker({ cwd: "/repo/root" }, async (cwd) => {
    seenCwd = cwd;
  });
  assert.equal(seenCwd, "/repo/root");
});

test("maybeWarmBroker: input.cwd 없으면 warm 미호출 (plugin-root warm 함정 회피)", async () => {
  let called = false;
  await maybeWarmBroker({}, async () => {
    called = true;
  });
  assert.equal(called, false);
});

test("maybeWarmBroker: warm 이 throw 해도 삼킨다 (best-effort — prompt 차단 금지)", async () => {
  await assert.doesNotReject(
    maybeWarmBroker({ cwd: "/repo" }, async () => {
      throw new Error("warm boom");
    })
  );
});

test("maybeWarmBroker: warm 이 reason:'error' 반환 시 stderr 진단 + throw 없음 (QUAL-R3-001)", async () => {
  // warmBrokerBestEffort 는 throw 대신 {warmed:false, reason:'error', error} 를 반환하는
  // non-throw failure path 가 있다. 그 경로가 stderr 진단을 남기되 prompt 를 막지 않음을 핀한다.
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    await assert.doesNotReject(
      maybeWarmBroker({ cwd: "/repo" }, async () => ({
        warmed: false,
        reason: "error",
        error: "spawn boom"
      }))
    );
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.match(captured, /broker warm failed: spawn boom/);
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
