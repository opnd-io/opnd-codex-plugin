import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyUtf8LocaleOverride,
  buildPluginCodexEnv,
  __resetAppServerNoticeCache
} from "../plugins/codex/scripts/lib/app-server.mjs";

// PR-4.5 mitigation (#310) — plugin-side workaround for the upstream
// codex CLI's Big5 / GBK / EUC-* JSONL parser crash on non-UTF-8 hosts.
// The mitigation injects LANG=C.UTF-8 + LC_ALL=C.UTF-8 into the spawned
// codex child env when the host locale is not UTF-8. The user's own
// shell env is not modified.
//
// Contract:
//   - UTF-8 host (LANG=en_US.UTF-8 / LC_ALL=ja_JP.UTF-8 / etc.) →
//     pass-through, no override.
//   - Non-UTF-8 host (LANG=zh_TW.Big5 / LC_ALL=C / unset) → inject
//     C.UTF-8 into the spawned env.
//   - CODEX_PLUGIN_PRESERVE_LOCALE=1 → opt out unconditionally
//     (no override even on non-UTF-8 host).
//   - One-shot stderr notice on the first override per process so the
//     user is not surprised by silent locale rewrite affecting codex
//     output formatting.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_SERVER = path.join(ROOT, "plugins", "codex", "scripts", "lib", "app-server.mjs");

function freshTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-locale-test-"));
}

// Audit finding #3 — the override target is platform-aware. POSIX gets the
// portable glibc `C.UTF-8`; Windows uses the UCRT-friendly `en_US.UTF-8`.
// Tests assert against this so they pass on every CI matrix without
// hard-coding the wrong value.
const EXPECTED_OVERRIDE = process.platform === "win32" ? "en_US.UTF-8" : "C.UTF-8";

function baseEnv(overrides = {}) {
  __resetAppServerNoticeCache();
  return {
    HOME: freshTmpHome(),
    USERPROFILE: freshTmpHome(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// applyUtf8LocaleOverride pure-function contract
// ---------------------------------------------------------------------------

test("applyUtf8LocaleOverride: en_US.UTF-8 LANG → no override (pass-through)", () => {
  const result = applyUtf8LocaleOverride({}, { LANG: "en_US.UTF-8" });
  assert.equal(result.applied, false);
  assert.equal(result.env.LANG, undefined, "no LANG injection when host is already UTF-8");
});

test("applyUtf8LocaleOverride: ja_JP.UTF-8 LC_ALL → no override", () => {
  const result = applyUtf8LocaleOverride({}, { LC_ALL: "ja_JP.UTF-8" });
  assert.equal(result.applied, false);
});

test("applyUtf8LocaleOverride: case-insensitive UTF8 variants accepted (UTF8 / utf-8 / Utf-8)", () => {
  for (const lang of ["en_US.UTF8", "en_US.utf-8", "en_US.Utf-8", "C.UTF-8", "POSIX.UTF-8"]) {
    const result = applyUtf8LocaleOverride({}, { LANG: lang });
    assert.equal(result.applied, false, `${lang} treated as UTF-8`);
  }
});

test("applyUtf8LocaleOverride: zh_TW.Big5 → injects C.UTF-8 LANG + LC_ALL", () => {
  const result = applyUtf8LocaleOverride({}, { LANG: "zh_TW.Big5" });
  assert.equal(result.applied, true);
  assert.equal(result.env.LANG, EXPECTED_OVERRIDE);
  assert.equal(result.env.LC_ALL, EXPECTED_OVERRIDE);
});

test("applyUtf8LocaleOverride: unset LANG + LC_ALL → injects C.UTF-8", () => {
  const result = applyUtf8LocaleOverride({}, {});
  assert.equal(result.applied, true);
  assert.equal(result.env.LANG, EXPECTED_OVERRIDE);
  assert.equal(result.env.LC_ALL, EXPECTED_OVERRIDE);
});

test("applyUtf8LocaleOverride: LANG=C (no UTF-8) → injects override", () => {
  const result = applyUtf8LocaleOverride({}, { LANG: "C" });
  assert.equal(result.applied, true);
  assert.equal(result.env.LANG, EXPECTED_OVERRIDE);
});

test("applyUtf8LocaleOverride: empty-string LANG → injects override", () => {
  const result = applyUtf8LocaleOverride({}, { LANG: "" });
  assert.equal(result.applied, true);
});

test("applyUtf8LocaleOverride: CODEX_PLUGIN_PRESERVE_LOCALE=1 → no override even on non-UTF-8 host", () => {
  const result = applyUtf8LocaleOverride({}, {
    LANG: "zh_TW.Big5",
    CODEX_PLUGIN_PRESERVE_LOCALE: "1"
  });
  assert.equal(result.applied, false);
  assert.equal(result.env.LANG, undefined, "host LANG preserved → not copied into spawned env");
});

test("applyUtf8LocaleOverride: CODEX_PLUGIN_PRESERVE_LOCALE=0 or unset → override fires when needed", () => {
  for (const val of ["", "0", "false", undefined]) {
    const env = { LANG: "zh_TW.Big5" };
    if (val !== undefined) env.CODEX_PLUGIN_PRESERVE_LOCALE = val;
    const result = applyUtf8LocaleOverride({}, env);
    assert.equal(result.applied, true, `preserve-locale=${JSON.stringify(val)} does NOT block override`);
  }
});

test("applyUtf8LocaleOverride: does NOT mutate the input env (returns a fresh copy)", () => {
  const target = { CODEX_HOME: "/x" };
  const base = { LANG: "zh_TW.Big5" };
  const result = applyUtf8LocaleOverride(target, base);
  assert.equal(target.LANG, undefined, "target untouched");
  assert.equal(base.LANG, "zh_TW.Big5", "base untouched");
  assert.equal(result.env.LANG, EXPECTED_OVERRIDE);
  assert.equal(result.env.CODEX_HOME, "/x", "target fields preserved in result");
});

// ---------------------------------------------------------------------------
// buildPluginCodexEnv integration (home isolation + locale overlay)
// ---------------------------------------------------------------------------

test("buildPluginCodexEnv: UTF-8 host → CODEX_HOME injected, no LANG/LC_ALL injection", () => {
  const env = buildPluginCodexEnv(baseEnv({ LANG: "en_US.UTF-8" }));
  assert.ok(env.CODEX_HOME, "home isolation still applies");
  assert.equal(env.LANG, "en_US.UTF-8", "host LANG passed through, not overridden");
  assert.equal(env.LC_ALL, undefined, "no LC_ALL injection when host is UTF-8");
});

test("buildPluginCodexEnv: non-UTF-8 host → CODEX_HOME + LANG/LC_ALL overridden", () => {
  const env = buildPluginCodexEnv(baseEnv({ LANG: "zh_TW.Big5" }));
  assert.ok(env.CODEX_HOME, "home isolation still applies");
  assert.equal(env.LANG, EXPECTED_OVERRIDE);
  assert.equal(env.LC_ALL, EXPECTED_OVERRIDE);
});

test("buildPluginCodexEnv: CODEX_PLUGIN_USE_DEFAULT_HOME=1 + non-UTF-8 → still overrides locale", () => {
  // Opt-out of home isolation should NOT opt out of locale mitigation —
  // they are independent concerns.
  const env = buildPluginCodexEnv(baseEnv({
    LANG: "zh_TW.Big5",
    CODEX_PLUGIN_USE_DEFAULT_HOME: "1"
  }));
  assert.equal(env.CODEX_HOME, undefined, "home isolation opted out");
  assert.equal(env.LANG, EXPECTED_OVERRIDE, "locale mitigation still fires");
});

test("buildPluginCodexEnv: CODEX_PLUGIN_PRESERVE_LOCALE=1 + non-UTF-8 → no locale override", () => {
  const env = buildPluginCodexEnv(baseEnv({
    LANG: "zh_TW.Big5",
    CODEX_PLUGIN_PRESERVE_LOCALE: "1"
  }));
  assert.equal(env.LANG, "zh_TW.Big5", "host LANG preserved as user requested");
  assert.equal(env.LC_ALL, undefined);
});

test("buildPluginCodexEnv: first non-UTF-8 invocation emits stderr notice, second does NOT", () => {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    __resetAppServerNoticeCache();
    buildPluginCodexEnv({ HOME: freshTmpHome(), USERPROFILE: freshTmpHome(), LANG: "zh_TW.Big5" });
    assert.match(captured, /non-UTF-8 host locale detected/);
    assert.match(captured, /LANG=zh_TW\.Big5/);
    assert.match(captured, /Restore your host locale with CODEX_PLUGIN_PRESERVE_LOCALE=1/);

    captured = "";
    buildPluginCodexEnv({ HOME: freshTmpHome(), USERPROFILE: freshTmpHome(), LANG: "zh_TW.Big5" });
    assert.equal(captured, "", "second call within same process → no second notice");
  } finally {
    process.stderr.write = original;
  }
});

test("buildPluginCodexEnv: UTF-8 host → no notice", () => {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    __resetAppServerNoticeCache();
    buildPluginCodexEnv(baseEnv({ LANG: "en_US.UTF-8" }));
    assert.equal(captured, "", "UTF-8 host produces no notice");
  } finally {
    process.stderr.write = original;
  }
});

// ---------------------------------------------------------------------------
// Source-level invariants (regression guards)
// ---------------------------------------------------------------------------

test("app-server.mjs exports applyUtf8LocaleOverride + __resetAppServerNoticeCache", () => {
  const source = fs.readFileSync(APP_SERVER, "utf8");
  assert.match(source, /export function applyUtf8LocaleOverride/, "applyUtf8LocaleOverride exported");
  assert.match(source, /export function __resetAppServerNoticeCache/, "reset helper exported for tests");
});

test("app-server.mjs LOCALE_PRESERVE_ENV constant + #310 cross-reference present", () => {
  const source = fs.readFileSync(APP_SERVER, "utf8");
  assert.match(source, /LOCALE_PRESERVE_ENV = "CODEX_PLUGIN_PRESERVE_LOCALE"/);
  assert.match(source, /PR-4\.5 mitigation \(#310\)/, "PR + issue cross-reference present");
});

// ---------------------------------------------------------------------------
// Codex audit findings — regression guards
// (1 HIGH + 1 MEDIUM + 4 LOW, all addressed inline or documented as trade-off)
// ---------------------------------------------------------------------------

test("audit #1 (HIGH): POSIX precedence — LC_ALL=C with LANG=en_US.UTF-8 still triggers override", () => {
  // Before the fix the override under-triggered: looksUtf8Locale(LANG) was
  // truthy so the mitigation skipped, but the EFFECTIVE locale codex sees
  // is C because POSIX gives LC_ALL absolute priority over LANG. Now we
  // walk the precedence ladder (LC_ALL → LC_CTYPE → LANG) so LC_ALL wins.
  const result = applyUtf8LocaleOverride({}, { LC_ALL: "C", LANG: "en_US.UTF-8" });
  assert.equal(result.applied, true, "LC_ALL=C wins over LANG=en_US.UTF-8");
  assert.match(result.env.LANG, /UTF-8/);
});

test("audit #1: POSIX precedence — LC_ALL=ja_JP.UTF-8 with LANG=C does NOT trigger override", () => {
  // The inverse case — LC_ALL wins for UTF-8 too, so the mitigation
  // correctly stands down.
  const result = applyUtf8LocaleOverride({}, { LC_ALL: "ja_JP.UTF-8", LANG: "C" });
  assert.equal(result.applied, false, "LC_ALL=UTF-8 wins over LANG=C");
});

test("audit #1: POSIX precedence — empty LC_ALL falls through to LC_CTYPE", () => {
  // Real-world case: LC_ALL="" (export with no value) should NOT count as
  // "LC_ALL is set" for precedence purposes. Fall through to LC_CTYPE.
  const result = applyUtf8LocaleOverride({}, {
    LC_ALL: "",
    LC_CTYPE: "zh_TW.Big5",
    LANG: "en_US.UTF-8"
  });
  assert.equal(result.applied, true, "empty LC_ALL → LC_CTYPE=Big5 wins → override fires");
});

test("audit #1: LC_CTYPE consulted before LANG when LC_ALL is unset", () => {
  const result = applyUtf8LocaleOverride({}, { LC_CTYPE: "zh_TW.Big5", LANG: "en_US.UTF-8" });
  assert.equal(result.applied, true, "LC_CTYPE=Big5 wins over LANG=UTF-8");
});

test("audit #3 (LOW): Windows uses en_US.UTF-8 (UCRT-compatible) instead of C.UTF-8", () => {
  const source = fs.readFileSync(APP_SERVER, "utf8");
  // Source-level guard — the platform branch must be explicit and use
  // en_US.UTF-8 on win32, not C.UTF-8.
  assert.match(
    source,
    /process\.platform === "win32" \? "en_US\.UTF-8" : "C\.UTF-8"/,
    "platform-aware override target"
  );
});

test("audit #4 (LOW): notice latch flips BEFORE write (documented attempted-once design)", () => {
  const source = fs.readFileSync(APP_SERVER, "utf8");
  // The comment block must spell out the intentional "attempted-once"
  // semantic so a future maintainer does not "fix" this into a retry loop
  // that pollutes the log on every spawn.
  assert.match(source, /Audit finding #4 \(LOW\) trade-off/, "trade-off documented");
  assert.match(source, /attempted-once/i, "explicit naming of the chosen semantic");
});

test("audit #5 (LOW): __resetAppServerNoticeCache documented as test-only with no NODE_ENV gate", () => {
  const source = fs.readFileSync(APP_SERVER, "utf8");
  // Documented choice — the project's existing convention is the
  // double-underscore prefix. A NODE_ENV gate would silently break
  // `node --test` which does not set NODE_ENV.
  assert.ok(
    source.includes("Audit finding #5 (LOW) — exposed from production source on purpose"),
    "trade-off heading present"
  );
  assert.ok(
    source.includes("double-underscore prefix follows the repo"),
    "convention rationale present"
  );
  assert.ok(
    source.includes("NODE_ENV check would silently"),
    "explicit reason why NODE_ENV gating was rejected"
  );
});

test("audit #6 (LOW): MIGRATION_v2.0.md cross-doc anchor matches the GFM slug", () => {
  const migration = fs.readFileSync(
    path.join(ROOT, "docs", "MIGRATION_v2.0.md"),
    "utf8"
  );
  const troubleshooting = fs.readFileSync(
    path.join(ROOT, "docs", "TROUBLESHOOTING.md"),
    "utf8"
  );

  // The actual heading sets the GFM slug; the cross-doc anchor must match
  // the slug exactly. The audit caught a double-hyphen + spurious
  // "-mitigation" suffix.
  assert.match(
    migration,
    /TROUBLESHOOTING\.md#13-non-utf-8-host-locale-codex-jsonl-parser-crash-310\b/,
    "cross-doc anchor uses single-hyphen GFM slug, no extra suffix"
  );
  // And the heading must still exist at the target.
  assert.match(
    troubleshooting,
    /^## 13\. Non-UTF-8 host locale \+ Codex JSONL parser crash \(#310\)/m,
    "target heading still present in TROUBLESHOOTING.md"
  );
});
