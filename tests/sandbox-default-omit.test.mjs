import { test } from "node:test";
import assert from "node:assert/strict";

// PR-2.1 (#240 / #167 / #304) BREAKING regression — thread/start +
// thread/resume must NOT inject a hard-coded sandbox value when the caller
// did not supply one. The app-server then falls back to the user's
// ~/.codex/config.toml `sandbox_mode`, which is the documented behavior of
// the codex CLI itself.

// codex.mjs does not export the helpers directly; we inspect the source
// because the runtime contract is "the field is absent from the request",
// which is hard to assert without spinning up a real app-server.

test("codex.mjs source: buildThreadParams omits sandbox when caller passes nothing", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  // Match the new builder pattern: sandbox is conditionally added, not
  // unconditionally set with ?? "read-only".
  assert.doesNotMatch(
    source,
    /sandbox:\s*options\.sandbox\s*\?\?\s*"read-only"/,
    "old `?? \"read-only\"` pattern must be gone in buildThreadParams"
  );
  assert.match(source, /resolveSandboxValue\(options\)/, "new resolver helper present");
  assert.match(
    source,
    /if \(sandbox != null\) \{\s*params\.sandbox = sandbox;/,
    "sandbox is only added when non-null"
  );
});

test("codex.mjs: CODEX_PLUGIN_SANDBOX_DEFAULT env override is honored", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /CODEX_PLUGIN_SANDBOX_DEFAULT/, "legacy-restore env var documented");
  assert.match(source, /pickSandboxDefault/, "default picker helper present");
});

test("codex-companion.mjs: first-run V2 notice helper exists and is gated", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /maybeEmitV2FirstRunWarning/, "warning helper present");
  assert.match(source, /CODEX_PLUGIN_SUPPRESS_V2_NOTICE/, "suppress env var documented");
  assert.match(source, /sandbox default is now inherited/, "notice text present");
});

test("codex-companion.mjs: handleTask sandbox-default logic respects CODEX_PLUGIN_SANDBOX_DEFAULT", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /effectiveSandbox = sandbox \?\? null/, "default is null, not read-only");
  assert.match(source, /legacyDefault = String\(process\.env\.CODEX_PLUGIN_SANDBOX_DEFAULT/, "legacy env var read");
});
