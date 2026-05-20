import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeTempDir } from "./helpers.mjs";
import { getCodexAuthStatus } from "../plugins/opnd-codex/scripts/lib/codex.mjs";

// PR-5.4 (#233) regression — auth gate must bypass when the user runs Codex
// against a non-OpenAI endpoint (custom base URL via openai_base_url) or
// explicitly opts out via CODEX_PLUGIN_SKIP_AUTH. The previous implementation
// failed the gate even though the codex subprocess worked fine against the
// custom endpoint.

test("CODEX_PLUGIN_SKIP_AUTH=1 bypasses the auth check entirely", async () => {
  const env = { ...process.env, CODEX_PLUGIN_SKIP_AUTH: "1" };
  const result = await getCodexAuthStatus(process.cwd(), { env });
  // When the env override fires, source must be "bypass" and loggedIn true
  // even though no real auth happened. If codex CLI isn't available the gate
  // returns source:"availability" first — accept that as the test's no-op.
  if (result.source !== "availability") {
    assert.equal(result.source, "bypass");
    assert.equal(result.loggedIn, true);
    assert.match(result.detail, /Auth check bypassed/);
  }
});

test("CODEX_PLUGIN_SKIP_AUTH=true (string form) also bypasses", async () => {
  const env = { ...process.env, CODEX_PLUGIN_SKIP_AUTH: "true" };
  const result = await getCodexAuthStatus(process.cwd(), { env });
  if (result.source !== "availability") {
    assert.equal(result.source, "bypass");
    assert.equal(result.loggedIn, true);
  }
});

test("Custom ~/.codex/config.toml with openai_base_url triggers heuristic bypass", async () => {
  // Synthesize a HOME with a config.toml that has openai_base_url. The
  // bypass heuristic reads $HOME/$USERPROFILE/.codex/config.toml so we
  // redirect to a temp dir for the duration of the call.
  const fakeHome = makeTempDir();
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".codex", "config.toml"),
    'openai_base_url = "https://my-proxy.internal/v1"\n',
    "utf8"
  );

  // Build a minimal env that has HOME pointing at fakeHome AND no real
  // SKIP flag, so the config-file heuristic is the only thing that can
  // trigger the bypass.
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CODEX_PLUGIN_SKIP_AUTH: "" };

  const result = await getCodexAuthStatus(process.cwd(), { env });
  if (result.source !== "availability") {
    assert.equal(result.source, "bypass");
    assert.equal(result.loggedIn, true);
    assert.match(result.detail, /openai_base_url/);
  }
});

test("Normal config without openai_base_url does NOT trigger the bypass heuristic", async () => {
  const fakeHome = makeTempDir();
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".codex", "config.toml"),
    'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n',
    "utf8"
  );

  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CODEX_PLUGIN_SKIP_AUTH: "" };
  const result = await getCodexAuthStatus(process.cwd(), { env });
  // If codex isn't available we get "availability". Otherwise the auth
  // gate runs (source = "app-server" / etc), NOT "bypass".
  assert.notEqual(result.source, "bypass", "no bypass when openai_base_url is absent");
});
