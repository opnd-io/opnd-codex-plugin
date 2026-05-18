# Migration: v1.x → v2.0.0

This guide covers the two BREAKING defaults introduced in v2.0.0 and how to roll back to v1.x behavior.

> TL;DR — If you want everything to behave exactly like v1.x, set:
>
> ```bash
> export CODEX_PLUGIN_SANDBOX_DEFAULT=read-only
> export CODEX_PLUGIN_USE_DEFAULT_HOME=1
> # Optional: silence the v2 first-run notice
> export CODEX_PLUGIN_SUPPRESS_V2_NOTICE=1
> ```

---

## What changed

### BREAKING #1 — sandbox default is inherited from `~/.codex/config.toml`

| | v1.x | v2.0.0 |
|---|---|---|
| `/codex:review` / `/codex:adversarial-review` | hard-coded `sandbox: "read-only"` | omitted; app-server uses `sandbox_mode` from `~/.codex/config.toml` |
| `/codex:task` (no `--write`) | hard-coded `sandbox: "read-only"` | omitted; user config wins |
| `/codex:task --write` | hard-coded `sandbox: "workspace-write"` | promoted to `workspace-write` only when `--sandbox` is not passed (preserved for backwards compat on the write path) |
| `/codex:task --sandbox <value>` | honored | honored (unchanged) |

**Issues this fixes**: openai/codex-plugin-cc#240 (Linux bwrap failures), #167 (no override on VPS), #304 (`git push` DNS errors on write tasks).

**How to opt out**:

```bash
# Restore v1.x default for every codex-plugin-cc invocation
export CODEX_PLUGIN_SANDBOX_DEFAULT=read-only
# Or, if you previously relied on the write-task workspace-write promotion:
export CODEX_PLUGIN_SANDBOX_DEFAULT=workspace-write
```

You can also set this per-command instead of globally:

```bash
CODEX_PLUGIN_SANDBOX_DEFAULT=read-only /codex:review
```

### BREAKING #2 — plugin sessions land in `$HOME/.codex/claude-code/`

| | v1.x | v2.0.0 |
|---|---|---|
| `CODEX_HOME` for plugin-spawned codex | inherited (default `~/.codex/`) | set to `$HOME/.codex/claude-code/` so plugin sessions are isolated from Codex Desktop's history feed |
| `CODEX_HOME` pre-set in your env | inherited | inherited (user pin wins) |
| Direct `codex exec` from your shell | unchanged | unchanged (only plugin spawns are isolated) |

**Issues this fixes**: openai/codex-plugin-cc#282 (plugin jobs polluting Codex Desktop history feed).

**How to opt out**:

```bash
# Restore v1.x shared home behavior
export CODEX_PLUGIN_USE_DEFAULT_HOME=1
```

If you want plugin sessions in a different custom location:

```bash
# Plugin (and direct codex) both use this custom home
export CODEX_HOME=/path/to/custom/codex
```

> **⚠ Auth-token side effect of BREAKING #2.** `codex login` writes `auth.json` into the codex home it sees in the current shell — by default `~/.codex/auth.json`. The plugin's spawned codex looks in **`~/.codex/claude-code/auth.json`** instead, so an unmigrated v1.x setup will keep returning `loggedIn: false` from `/codex:setup` even after a successful `codex login`. Two equivalent fixes:
>
> ```bash
> # Option A — copy your existing token into the plugin home (one-time)
> cp ~/.codex/auth.json ~/.codex/claude-code/auth.json
> ```
>
> ```bash
> # Option B — login directly into the plugin home (also re-runnable after rotation)
> CODEX_HOME="$HOME/.codex/claude-code" codex login
> ```
>
> Subsequent `codex login` invocations from a normal shell only refresh `~/.codex/auth.json`, so plan to re-copy after every rotation — or pin the plugin to the shared home with `CODEX_PLUGIN_USE_DEFAULT_HOME=1` if you do not need history isolation. See also [TROUBLESHOOTING.md #12](TROUBLESHOOTING.md#12-plugin-says-loggedin-false-after-a-successful-codex-login-v200-home-isolation).

### What is NOT BREAKING

- `clientInfo.name` now reports `codex-plugin-cc` instead of `Claude Code` (fixes gpt-5.5 400 invalid_request_error) — no user-facing surface change
- All v1.x commands (`/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, etc.) keep their original surface
- `--sandbox`, `--approval`, `--model`, `--effort` flags behave identically when passed
- Hook configuration (`hooks.json`) shape unchanged

---

## Migration checklist

### One-time

- [ ] Decide whether to opt-out of the sandbox default change. Most users will benefit from the new default; opt-out is needed if you have CI / automation that depends on the hard-coded `read-only` / `workspace-write` behavior.
- [ ] Decide whether to keep the v1.x shared `~/.codex/` home. If you frequently resume plugin-launched threads in Codex Desktop, set `CODEX_PLUGIN_USE_DEFAULT_HOME=1`.
- [ ] **Migrate your OpenAI auth token to the plugin home.** `codex login` writes only to `~/.codex/auth.json`, so the plugin will report `loggedIn: false` from `/codex:setup` until you copy it: `cp ~/.codex/auth.json ~/.codex/claude-code/auth.json` (or run `CODEX_HOME="$HOME/.codex/claude-code" codex login` to write directly). Repeat after every token rotation, or skip both by setting `CODEX_PLUGIN_USE_DEFAULT_HOME=1`. See [TROUBLESHOOTING.md #12](TROUBLESHOOTING.md#12-plugin-says-loggedin-false-after-a-successful-codex-login-v200-home-isolation) for the full failure mode.
- [ ] (Optional) Migrate existing plugin sessions to the new home: `cp -r ~/.codex/sessions/ ~/.codex/claude-code/sessions/`. Without this, your v1.x session history stays in the old location and is invisible to v2 plugin commands.

### Per-environment

- [ ] Linux hosts where `bwrap` cannot initialize: the new default fixes most failure modes if `~/.codex/config.toml` sets `sandbox_mode = "danger-full-access"`. No env var needed.
- [ ] macOS Seatbelt environments: the new default allows `.git/` writes if `~/.codex/config.toml` sets a permissive `sandbox_mode`. Otherwise no change.
- [ ] CI workflows that pipe prompts: prefer `--prompt-file` or `--prompt-stdin` over inline argv (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the ~3 KB inline-prompt issue).
- [ ] Windows + Git Bash: cross-drive hooks now resolve correctly (#285). No env var needed.

### First-run notice

The plugin prints a stderr notice on the first invocation per process listing both BREAKING changes and their opt-out env vars. Suppress with:

```bash
export CODEX_PLUGIN_SUPPRESS_V2_NOTICE=1
```

---

## New v2.0.0 features (non-breaking)

These all default to v1.x behavior unless you explicitly opt in:

| Flag | Effect |
|---|---|
| `--profile <name>` | Use `[profiles.<name>]` from `~/.codex/config.toml` for this single invocation |
| `--resume-id <thread-id>` | Resume a specific Codex thread by id (mutually exclusive with `--resume` / `--fresh`) |
| `--context <text>` | Prepend `<context>...</context>` block before the prompt |
| `--fast` | Request `service_tier=fast` (~1.5x speed, ~2x credits) |
| `--branch <ref>` (review only) | Review a remote branch without local checkout |
| `--max-findings <N>` (review only) | Lift the implicit 2-3 finding cap (default 20, hard cap 100) |
| `--full-access` / `--dangerously-skip-permissions` | Sugar for `--sandbox danger-full-access --approval never` |
| `--prompt-stdin` | Explicit pipe marker for multi-KB prompts |

---

## New v2.0.0 env vars

| Env var | Effect |
|---|---|
| `CODEX_PLUGIN_SANDBOX_DEFAULT` | Restore the v1.x hard-coded sandbox default (`read-only` or `workspace-write`) |
| `CODEX_PLUGIN_USE_DEFAULT_HOME=1` | Disable the new `$HOME/.codex/claude-code/` isolation (use shared `~/.codex/`) |
| `CODEX_PLUGIN_SKIP_AUTH=1` | Bypass the OpenAI auth gate (for custom `openai_base_url` setups) |
| `CODEX_PLUGIN_SUPPRESS_V2_NOTICE=1` | Silence the first-run BREAKING-change notice |
| `CODEX_BROKER_IDLE_GRACE_MS` | Override broker idle self-exit grace (default 10 min, was 30 min in v1.x) |
| `CODEX_BROKER_IDLE_INTERVAL_MS` | Override broker idle poll interval (default 2 min, was 5 min in v1.x) |
| `CODEX_FINALIZING_PHASE_TIMEOUT_MS` | Override the finalizing-phase fail-fast timeout (default 5 min; disable with `0`) |

## New v2.1.0 env vars

| Env var | Effect |
|---|---|
| `CODEX_PLUGIN_USER_CONFIG` | Path to a user-level JSON config file (PR-7.7, #213). Overrides the XDG / legacy discovery order. Primarily for tests and ad-hoc per-invocation overrides — see "User-level config defaults" below. |
| `CODEX_PLUGIN_PRESERVE_LOCALE` | When `=1`, disable the v2.1.0 non-UTF-8 locale mitigation (PR-4.5, #310). The plugin passes the host `LANG` / `LC_ALL` through to spawned codex children even on non-UTF-8 systems, restoring the upstream JSONL parser crash risk in exchange for localized codex output. See [`TROUBLESHOOTING.md` #13](TROUBLESHOOTING.md#13-non-utf-8-host-locale-codex-jsonl-parser-crash-310) for the full failure mode. |
| `CODEX_PLUGIN_TELEMETRY_DISABLED` | Suppress the JSONL telemetry stream entirely (default off — telemetry is on, local-only, at `~/.claude/plugins/data/codex-openai-codex/telemetry/events.jsonl`). Set to `1`, `true`, or `yes` to skip every event write. PR-9.1. |
| `CODEX_PLUGIN_TELEMETRY_DEBUG` | When `=1`, surface swallowed telemetry write errors on stderr instead of silently dropping them. Useful for diagnosing missing-event reports — leave unset in normal use. PR-9.1. |

## User-level config defaults (PR-7.7, #213)

The plugin reads a small JSON file for plugin-level defaults so users do not have to retype `--model gpt-5.4-mini --effort medium --sandbox workspace-write` on every rescue / review / task call. CLI flags **always** win — the config only fills in values that were not passed.

Discovery order (first file that exists wins):

1. `$CODEX_PLUGIN_USER_CONFIG` (explicit override path)
2. `$XDG_CONFIG_HOME/codex-plugin-cc/config.json` (or `~/.config/codex-plugin-cc/config.json` if `XDG_CONFIG_HOME` is unset)
3. `~/.codex/plugin-cc.json` (legacy fallback — no need to relocate)

Supported keys (everything else is ignored — additions stay additive):

| Key | Type | Maps to |
|---|---|---|
| `defaultModel` | string | `--model` default (alias `spark` → `gpt-5.3-codex-spark` still applies) |
| `defaultEffort` | one of `none` / `minimal` / `low` / `medium` / `high` / `xhigh` | `--effort` default |
| `defaultSandbox` | one of `read-only` / `workspace-write` / `danger-full-access` | `--sandbox` default |

Example:

```json
{
  "defaultModel": "gpt-5.4-mini",
  "defaultEffort": "medium"
}
```

**Behavior notes** (matter for debugging):

- A malformed file (invalid JSON or top-level array/scalar) emits **one** stderr warning per process and is otherwise treated as empty — the plugin never crashes because of a bad config.
- Unknown keys (typos like `defaultModelName` instead of `defaultModel`) emit **one** stderr warning per process so the silent-ignore does not bury bugs.
- An explicit `$CODEX_PLUGIN_USER_CONFIG` path that exists but cannot be read warns once and is treated as empty — the plugin will NOT fall through to XDG / legacy candidates, because the explicit env override means "use exactly this file or no file."
- Cache scope: the config is loaded once per process. Long-running brokers that fix a malformed file mid-flight need a restart to pick the change up. Production callers always pass `process.env`, so the implicit singleton is the documented contract.
- Explicit empty CLI values (`--model ""`) are treated as "clear the default", **not** as "fall through to config" — CLI always wins.
- On Windows, the home directory is resolved from `USERPROFILE` first (Git Bash / MSYS often sets `HOME=/c/Users/x` which the Node fs APIs handle inconsistently).

---

## FAQ

### Why two BREAKING changes in one release instead of two minor bumps?

The split-train release strategy (see `plugins/codex/CHANGELOG.md`) put **all** BREAKING changes in v2.0.0 with stability fixes preceding it in v1.0.5 / v1.0.6 and features following in v1.2.0. Users who do not want v2.0.0 can stop at v1.0.6 and still benefit from 16 stability + Windows / auth hardening PRs.

### How do I tell whether the new defaults will affect my setup?

Run `/codex:setup` and look at the printed `~/.codex/config.toml` summary. If your config has no `sandbox_mode` line, the new default matches the codex CLI's own default (`read-only`) and behavior is unchanged. If `sandbox_mode = "workspace-write"` is set, write tasks now honor that instead of forcing it.

### Can I roll back the BREAKING changes per-project instead of globally?

Yes. The env vars are per-process. Use a project-local `.envrc` (direnv) or a wrapper script that exports `CODEX_PLUGIN_SANDBOX_DEFAULT` / `CODEX_PLUGIN_USE_DEFAULT_HOME` before invoking `claude code`.

### What if my CI silently breaks because of the new sandbox default?

Look in stderr for the first-run notice — it appears once per process and names both BREAKING changes. Then set `CODEX_PLUGIN_SANDBOX_DEFAULT=read-only` in your CI env to pin v1.x behavior while you migrate.

### Where can I find the full per-PR change log?

`plugins/codex/CHANGELOG.md` lists all 27 PRs across the four release trains (v1.0.5, v1.0.6, v2.0.0, v1.2.0) with the issue numbers they resolve.
