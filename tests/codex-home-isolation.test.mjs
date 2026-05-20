import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir } from "./helpers.mjs";
import { buildPluginCodexEnv } from "../plugins/opnd-codex/scripts/lib/app-server.mjs";

// PR-5.6 (#282) BREAKING regression — plugin-spawned codex children get a
// dedicated CODEX_HOME so their sessions / history feed do not pollute the
// user's Codex Desktop view. Override behavior:
//   - CODEX_PLUGIN_USE_DEFAULT_HOME=1   → restore legacy shared ~/.codex/
//   - pre-set CODEX_HOME=<path>          → user pins a custom location
//   - default                            → $HOME/.codex/claude-code/

test("default env: CODEX_HOME is set to $HOME/.codex/claude-code/", () => {
  const fakeHome = makeTempDir();
  const baseEnv = { HOME: fakeHome, USERPROFILE: fakeHome };
  const env = buildPluginCodexEnv(baseEnv);
  assert.equal(env.CODEX_HOME, path.join(fakeHome, ".codex", "claude-code"));
  assert.ok(fs.existsSync(env.CODEX_HOME), "plugin home dir is created");
});

test("CODEX_PLUGIN_USE_DEFAULT_HOME=1 restores legacy shared home (no CODEX_HOME override)", () => {
  const fakeHome = makeTempDir();
  const baseEnv = { HOME: fakeHome, USERPROFILE: fakeHome, CODEX_PLUGIN_USE_DEFAULT_HOME: "1" };
  const env = buildPluginCodexEnv(baseEnv);
  assert.equal(env.CODEX_HOME, undefined, "CODEX_HOME not injected when opt-out is set");
});

test("Pre-set CODEX_HOME is preserved (user pin)", () => {
  const fakeHome = makeTempDir();
  const customHome = makeTempDir();
  const baseEnv = { HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: customHome };
  const env = buildPluginCodexEnv(baseEnv);
  assert.equal(env.CODEX_HOME, customHome, "user-set CODEX_HOME wins");
});

test("Returns a NEW env object — never mutates the base env", () => {
  const fakeHome = makeTempDir();
  const baseEnv = { HOME: fakeHome, USERPROFILE: fakeHome };
  const before = { ...baseEnv };
  const env = buildPluginCodexEnv(baseEnv);
  assert.deepEqual(baseEnv, before, "base env is not mutated");
  assert.notStrictEqual(env, baseEnv, "returned env is a copy");
});

test("Missing HOME / USERPROFILE: returns a copy without CODEX_HOME (gracefully degrades)", () => {
  const baseEnv = { CODEX_PLUGIN_USE_DEFAULT_HOME: "" };
  const env = buildPluginCodexEnv(baseEnv);
  assert.equal(env.CODEX_HOME, undefined);
});

test("codex-companion v2 notice mentions both BREAKING changes", async () => {
  const url = new URL("../plugins/opnd-codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");
  assert.match(source, /Sandbox default is now inherited/);
  assert.match(source, /claude-code\//, "second BREAKING (home isolation) mentioned");
  assert.match(source, /CODEX_PLUGIN_USE_DEFAULT_HOME=1/, "opt-out env var documented");
});
