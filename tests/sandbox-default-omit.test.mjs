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
  const url = new URL("../plugins/opnd-codex/scripts/lib/codex.mjs", import.meta.url);
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

test("codex.mjs: runAppServerReview review path does NOT hard-code sandbox", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/lib/codex.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  // PR-2.1 / BREAKING #1 (#240 / #167 / #304) — MIGRATION_v2.0.md row 1 of
  // BREAKING #1 documents that `/opnd-codex:review` + `/opnd-codex:adversarial-review`
  // omit the sandbox field so the app-server falls back to the user's
  // ~/.codex/config.toml `sandbox_mode`. The earlier `executeReviewWithModel`
  // body hard-coded `sandbox: "read-only"` which bypassed the helper omit
  // path entirely. This regression guard re-locks the documented contract.
  const reviewBlock = source.match(
    /async function executeReviewWithModel\([\s\S]+?startThread\(client, cwd, \{[\s\S]+?\}\)/
  );
  assert.ok(reviewBlock, "executeReviewWithModel startThread block found");
  assert.doesNotMatch(
    reviewBlock[0],
    /sandbox:\s*"read-only"/,
    "review path must NOT hard-code sandbox:\"read-only\" — MIGRATION_v2.0 BREAKING #1 row 1"
  );
  assert.match(
    reviewBlock[0],
    /sandbox:\s*options\.sandbox/,
    "review path forwards options.sandbox so resolveSandboxValue can omit / inherit / honor explicit value"
  );
});

// CDX-004 — runtime contract guards. Source-level regex catches the literal
// `sandbox: "read-only"` hard-code, but the actual omit/inherit contract is
// realized by `resolveSandboxValue` + `buildThreadParams`. Exercise those
// helpers directly so the test stays green only if the real runtime path
// emits the right `params.sandbox` shape (or omits it entirely).

test("CDX-004 runtime: resolveSandboxValue falls back to env when caller omits sandbox", async () => {
  const { __testHooks } = await import("../plugins/opnd-codex/scripts/lib/codex.mjs");
  const { resolveSandboxValue } = __testHooks;

  // Caller did not pass sandbox + no env override -> null (-> param omit).
  assert.equal(
    resolveSandboxValue({ sandbox: null, env: {} }),
    null,
    "no caller value + no env -> null so buildThreadParams omits the field"
  );

  // Env override present -> returned verbatim.
  assert.equal(
    resolveSandboxValue({ sandbox: null, env: { CODEX_PLUGIN_SANDBOX_DEFAULT: "read-only" } }),
    "read-only",
    "CODEX_PLUGIN_SANDBOX_DEFAULT honored when caller did not pass sandbox"
  );

  // Caller-provided sandbox wins over env.
  assert.equal(
    resolveSandboxValue({ sandbox: "workspace-write", env: { CODEX_PLUGIN_SANDBOX_DEFAULT: "read-only" } }),
    "workspace-write",
    "explicit caller value wins over env override"
  );
});

test("CDX-004 runtime: buildThreadParams omits sandbox when caller passes null", async () => {
  const { __testHooks } = await import("../plugins/opnd-codex/scripts/lib/codex.mjs");
  const { buildThreadParams } = __testHooks;

  // Mirror what `executeReviewWithModel` (post-fix) hands to startThread:
  // sandbox forwarded from outer options. When the slash command did not
  // pass `--sandbox`, the outer options carries sandbox=null and no env
  // override, so the produced params must NOT contain a `sandbox` key.
  const params = buildThreadParams("/tmp/fake-workspace", { sandbox: null, env: {} });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(params, "sandbox"),
    "sandbox field is absent from params when caller did not specify one"
  );

  // With env override active the field is present so app-server inherits it.
  const paramsWithEnv = buildThreadParams("/tmp/fake-workspace", {
    sandbox: null,
    env: { CODEX_PLUGIN_SANDBOX_DEFAULT: "read-only" }
  });
  assert.equal(paramsWithEnv.sandbox, "read-only", "env override surfaces in params");

  // Explicit caller value short-circuits the env path.
  const paramsExplicit = buildThreadParams("/tmp/fake-workspace", {
    sandbox: "workspace-write",
    env: { CODEX_PLUGIN_SANDBOX_DEFAULT: "read-only" }
  });
  assert.equal(paramsExplicit.sandbox, "workspace-write", "explicit caller value wins");
});

test("codex.mjs: CODEX_PLUGIN_SANDBOX_DEFAULT env override is honored", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/lib/codex.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /CODEX_PLUGIN_SANDBOX_DEFAULT/, "legacy-restore env var documented");
  assert.match(source, /pickSandboxDefault/, "default picker helper present");
});

test("codex-companion.mjs: first-run V2 notice helper exists and is gated", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /maybeEmitV2FirstRunWarning/, "warning helper present");
  assert.match(source, /CODEX_PLUGIN_SUPPRESS_V2_NOTICE/, "suppress env var documented");
  assert.match(source, /sandbox default is now inherited/i, "notice text present");
});

test("codex-companion.mjs: handleTask sandbox-default logic respects CODEX_PLUGIN_SANDBOX_DEFAULT", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /effectiveSandbox = sandbox \?\? null/, "default is null, not read-only");
  assert.match(source, /legacyDefault = String\(process\.env\.CODEX_PLUGIN_SANDBOX_DEFAULT/, "legacy env var read");
});
