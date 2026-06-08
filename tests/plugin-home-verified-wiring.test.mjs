import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// issue #2 fix #1 — the setup `verified` verdict must reflect the plugin-home
// staleness advisory. The dual-home split (buildPluginCodexEnv adds
// CODEX_HOME=$HOME/.codex/claude-code/) means `codex login` rotates only root
// ~/.codex/auth.json; a stale plugin-home auth.json makes the next rescue fail
// with `refresh token already used` while the raw probe still says verified.
// inspectPluginHomeFreshness() already detects the mtime skew (advisory.staleAuth)
// — computeStaleHomeAuth() is the pure decision that folds it into the verdict,
// and buildSetupReport() applies it to auth.verified / ready.

const codex = await import("../plugins/opnd-codex/scripts/lib/codex.mjs");

// ── (a) pure decision: computeStaleHomeAuth(advisory, env) ───────────────────

test("computeStaleHomeAuth — stale + unpinned home → true (downgrade)", () => {
  const { computeStaleHomeAuth } = codex.__testHooks;
  assert.equal(
    computeStaleHomeAuth({ staleAuth: true, staleAuthDeltaSec: 855305 }, {}),
    true
  );
});

test("computeStaleHomeAuth — stale but CODEX_PLUGIN_USE_DEFAULT_HOME=1 → false (no dual-home)", () => {
  const { computeStaleHomeAuth } = codex.__testHooks;
  assert.equal(
    computeStaleHomeAuth(
      { staleAuth: true, staleAuthDeltaSec: 999 },
      { CODEX_PLUGIN_USE_DEFAULT_HOME: "1" }
    ),
    false
  );
});

test("computeStaleHomeAuth — stale but explicit CODEX_HOME pin → false (single pinned home)", () => {
  const { computeStaleHomeAuth } = codex.__testHooks;
  assert.equal(
    computeStaleHomeAuth(
      { staleAuth: true, staleAuthDeltaSec: 999 },
      { CODEX_HOME: "/custom/.codex" }
    ),
    false
  );
});

test("computeStaleHomeAuth — fresh advisory (staleAuth:false) → false (no downgrade)", () => {
  const { computeStaleHomeAuth } = codex.__testHooks;
  assert.equal(
    computeStaleHomeAuth({ staleAuth: false, staleAuthDeltaSec: 0 }, {}),
    false
  );
});

test("computeStaleHomeAuth — missing/empty advisory → false (graceful)", () => {
  const { computeStaleHomeAuth } = codex.__testHooks;
  assert.equal(computeStaleHomeAuth(null, {}), false);
  assert.equal(computeStaleHomeAuth(undefined, {}), false);
  assert.equal(computeStaleHomeAuth({}, {}), false);
});

test("computeStaleHomeAuth — explicit null env does not throw (optional-chaining guard)", () => {
  const { computeStaleHomeAuth } = codex.__testHooks;
  // the `= process.env` default only covers undefined; a caller passing null
  // must still degrade to a non-pinned read rather than crash.
  assert.equal(computeStaleHomeAuth({ staleAuth: true }, null), true);
  assert.equal(computeStaleHomeAuth({ staleAuth: false }, null), false);
});

test("computeStaleHomeAuth — USE_DEFAULT_HOME other than '1' does NOT pin", () => {
  const { computeStaleHomeAuth } = codex.__testHooks;
  // only the literal "1" collapses the homes; "0"/"true"/"" must not suppress.
  assert.equal(
    computeStaleHomeAuth({ staleAuth: true }, { CODEX_PLUGIN_USE_DEFAULT_HOME: "0" }),
    true
  );
  assert.equal(
    computeStaleHomeAuth({ staleAuth: true }, { CODEX_HOME: "   " }),
    true
  );
});

// ── (b) wiring guard: buildSetupReport applies the downgrade ─────────────────
// buildSetupReport() is private and spawns the real codex CLI for its auth
// probe, so we guard the wiring at the source level (same approach as
// stale-auth-annotate.test.mjs) to catch a silent revert.

test("codex-companion.mjs wires staleHomeAuth into the auth verdict", () => {
  const url = new URL(
    "../plugins/opnd-codex/scripts/codex-companion.mjs",
    import.meta.url
  );
  const source = fs.readFileSync(url, "utf8");
  assert.match(source, /computeStaleHomeAuth/, "imports + uses the pure decision");
  assert.match(
    source,
    /const staleHomeAuth = computeStaleHomeAuth\(pluginHomeAdvisory, process\.env\)/,
    "derives staleHomeAuth from the advisory"
  );
  // tie verified:false specifically to the stale-home downgrade branch (not any
  // `verified: false` elsewhere in the file) so a refactor that breaks the
  // wiring cannot pass silently.
  assert.match(
    source,
    /verified: false,\s*\n\s*staleHomeAuth: true,\s*\n\s*verificationNote:/,
    "downgrades auth.verified + flags + note together in the stale-home branch"
  );
  assert.match(
    source,
    /authStatus\.loggedIn && !staleHomeAuth/,
    "folds staleHomeAuth into the top-level ready verdict"
  );
  assert.match(source, /auth: authReport/, "emits the downgraded auth report");
});

test("computeStaleHomeAuth is exported for production import (not test-only)", () => {
  assert.equal(
    typeof codex.computeStaleHomeAuth,
    "function",
    "named export present so codex-companion imports it as production code"
  );
});
