// PR-7.7 (#213) — user-level config defaults.
//
// Goal: let users stop typing the same `--model gpt-5.4-mini --effort medium`
// on every rescue / review / task invocation. Pick up plugin-level defaults
// from a JSON file at one of:
//
//   1. $CODEX_PLUGIN_USER_CONFIG (env override — primarily for tests + ad-hoc
//      `CODEX_PLUGIN_USER_CONFIG=/tmp/x.json /codex:rescue …`)
//   2. $XDG_CONFIG_HOME/codex-plugin-cc/config.json (or ~/.config/...)
//   3. ~/.codex/plugin-cc.json (legacy fallback so existing users do not
//      have to relocate the file just because we picked XDG)
//
// Design constraints (load-bearing):
//   - Load is best-effort. A missing file is a clean `{}`. A corrupted file
//     prints ONE stderr warning per process + falls back to `{}` — telemetry
//     about the failure goes nowhere else, by design (we do not want a
//     malformed config to break every Codex call).
//   - Defaults NEVER override an explicit CLI option. The caller resolves
//     `cliValue ?? userConfigValue ?? null` — that ordering belongs to the
//     caller because only the caller knows whether `null` meant "user
//     omitted" vs "user explicitly passed empty". This module returns the
//     user-config value or `undefined`; it does not perform the merge.
//   - Per-process cache. The config file is read once on the first call;
//     subsequent calls return the cached object. Tests can reset via
//     `__resetUserConfigCache()`.
//   - Schema is an allow-list. Unknown keys are kept in the cache but only
//     the documented `getUserDefault(name)` accessors will surface known
//     defaults to the runtime. Future additions are additive.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USER_CONFIG_ENV = "CODEX_PLUGIN_USER_CONFIG";
const XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME";
const XDG_CONFIG_RELATIVE = path.join("codex-plugin-cc", "config.json");
const LEGACY_RELATIVE = path.join(".codex", "plugin-cc.json");

// Audit finding #1 — `defaultStopReviewGate` was speculative but `handleSetup`
// never reads it, so accepting it in the allow-list would silently no-op.
// Keep the allow-list to keys we actually consume. New keys land here when
// the consuming code lands.
const KNOWN_DEFAULT_KEYS = Object.freeze([
  "defaultModel",   // string — passed to --model when CLI omits it
  "defaultEffort",  // one of: none | minimal | low | medium | high | xhigh
  "defaultSandbox"  // one of: read-only | workspace-write | danger-full-access
]);

// Cache lives at module-scope so the file system is touched at most once
// per process. Tests reset via __resetUserConfigCache(). Production callers
// always pass `process.env` (the default), which makes this a per-process
// singleton in practice — see the "Cache scope" note in MIGRATION_v2.0.md.
let cachedConfig = null;
let cachedSource = null; // path the cache was loaded from (null if no file matched)
let warnedAboutCorruptOnce = false;
let warnedAboutExplicitUnreadableOnce = false;
let warnedAboutUnknownKeysOnce = false;

export function __resetUserConfigCache() {
  cachedConfig = null;
  cachedSource = null;
  warnedAboutCorruptOnce = false;
  warnedAboutExplicitUnreadableOnce = false;
  warnedAboutUnknownKeysOnce = false;
}

function isWindows() {
  return process.platform === "win32";
}

function resolveHomeDir(env) {
  // Audit finding #3 — on Windows, Git Bash / MSYS sets `HOME=/c/Users/x`
  // (POSIX style), which `fs.existsSync` then has to interpret through the
  // emulation layer; while `USERPROFILE=C:\Users\x` is the native Windows
  // form Node can use directly. Prefer the native variable on win32 so
  // candidate paths land in the right shape.
  if (isWindows()) {
    return env.USERPROFILE ?? env.HOME ?? os.homedir();
  }
  return env.HOME ?? env.USERPROFILE ?? os.homedir();
}

function resolveCandidatePaths(env) {
  const candidates = [];
  const explicit = env[USER_CONFIG_ENV];
  if (explicit && String(explicit).trim()) {
    candidates.push({ path: String(explicit).trim(), source: "env" });
  }
  const xdg = env[XDG_CONFIG_HOME_ENV];
  if (xdg && String(xdg).trim()) {
    candidates.push({ path: path.join(String(xdg).trim(), XDG_CONFIG_RELATIVE), source: "xdg" });
  } else {
    const home = resolveHomeDir(env);
    if (home) {
      candidates.push({ path: path.join(home, ".config", XDG_CONFIG_RELATIVE), source: "xdg-default" });
    }
  }
  const home = resolveHomeDir(env);
  if (home) {
    candidates.push({ path: path.join(home, LEGACY_RELATIVE), source: "legacy" });
  }
  return candidates;
}

/**
 * Load the user-level config file. Best-effort:
 *   - Returns the first candidate path that exists AND parses as JSON.
 *   - Missing file at every candidate → `{}` (silent).
 *   - File exists but JSON parse fails → ONE stderr warning per process,
 *     then `{}`.
 *
 * The cache key is the env object — production callers pass nothing and get
 * `process.env`. Tests pass a custom env (different USER_CONFIG path) and
 * `__resetUserConfigCache()` before each invocation so the cache cannot
 * leak between cases.
 */
export function loadUserConfig({ env = process.env } = {}) {
  if (cachedConfig != null) {
    return cachedConfig;
  }
  const candidates = resolveCandidatePaths(env);
  for (const candidate of candidates) {
    const { path: candidatePath, source } = candidate;
    if (!fs.existsSync(candidatePath)) continue;
    let raw;
    try {
      raw = fs.readFileSync(candidatePath, "utf8");
    } catch (readError) {
      // Audit finding #2 — if the EXPLICIT $CODEX_PLUGIN_USER_CONFIG path
      // exists but cannot be read (EACCES, file-as-dir, etc.), do NOT fall
      // through to lower-priority candidates. Falling through lets a stale
      // XDG / legacy file silently shadow the user's intentional override.
      // Warn once and treat as empty.
      if (source === "env") {
        if (!warnedAboutExplicitUnreadableOnce) {
          warnedAboutExplicitUnreadableOnce = true;
          process.stderr.write(
            `[codex-plugin-cc] explicit CODEX_PLUGIN_USER_CONFIG at ${candidatePath} is unreadable (${readError?.message ?? readError}) — treating as empty (no fall-through to other candidates).\n`
          );
        }
        cachedConfig = {};
        cachedSource = candidatePath;
        return cachedConfig;
      }
      // For non-explicit candidates (XDG / legacy), keep the previous
      // "skip + try next" behavior — an unreadable file at a default path
      // is more likely accidental than intentional.
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Audit finding #6 — warn once when the file declares keys that
        // are not in the allow-list. Helps catch typos like
        // `defaultModelName` vs `defaultModel`.
        const unknown = Object.keys(parsed).filter((key) => !KNOWN_DEFAULT_KEYS.includes(key));
        if (unknown.length > 0 && !warnedAboutUnknownKeysOnce) {
          warnedAboutUnknownKeysOnce = true;
          process.stderr.write(
            `[codex-plugin-cc] user config at ${candidatePath} contains unknown keys: ${unknown.join(", ")}. Allow-list: ${KNOWN_DEFAULT_KEYS.join(", ")}.\n`
          );
        }
        cachedConfig = parsed;
        cachedSource = candidatePath;
        return cachedConfig;
      }
      // Anything else (array, string, number, null) is a configuration
      // mistake — warn once and treat as empty.
      if (!warnedAboutCorruptOnce) {
        warnedAboutCorruptOnce = true;
        process.stderr.write(
          `[codex-plugin-cc] user config at ${candidatePath} is not a JSON object — ignoring.\n`
        );
      }
      cachedConfig = {};
      cachedSource = candidatePath;
      return cachedConfig;
    } catch (error) {
      if (!warnedAboutCorruptOnce) {
        warnedAboutCorruptOnce = true;
        process.stderr.write(
          `[codex-plugin-cc] user config at ${candidatePath} is not valid JSON (${error?.message ?? error}) — ignoring.\n`
        );
      }
      cachedConfig = {};
      cachedSource = candidatePath;
      return cachedConfig;
    }
  }
  cachedConfig = {};
  cachedSource = null;
  return cachedConfig;
}

/**
 * Returns the configured default for `key` or `undefined` if either:
 *   - no user config file was found, or
 *   - the file did not set this key, or
 *   - `key` is not in the documented allow-list KNOWN_DEFAULT_KEYS.
 *
 * The caller does the merge with CLI values: `cliValue ?? getUserDefault(...)`.
 */
export function getUserDefault(key, { env = process.env } = {}) {
  if (!KNOWN_DEFAULT_KEYS.includes(key)) return undefined;
  const config = loadUserConfig({ env });
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  // Trim string defaults so a trailing newline from a hand-edited file does
  // not silently pollute the value.
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return value;
}

export function getUserConfigSource() {
  return cachedSource;
}

export { KNOWN_DEFAULT_KEYS };
