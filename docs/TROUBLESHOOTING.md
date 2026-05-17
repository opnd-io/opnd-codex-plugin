# Troubleshooting

Common failure modes and their fixes / workarounds in v2.0.0.

For BREAKING changes from v1.x, see [MIGRATION_v2.0.md](MIGRATION_v2.0.md) first.

---

## Symptom index

| Symptom | Section |
|---|---|
| Session stalls in infinite "block → retry" loop after rate limit | [#1 Stop-review-gate rewake loop](#1-stop-review-gate-rewake-loop-rate-limit--token-burn) |
| `/codex:rescue` returns "user denied" without showing a prompt | [#2 Large inline prompt silently rejected](#2-large-inline-prompt-silently-rejected-by-claude-code-bash) |
| Job stuck at `status: "running"` indefinitely after worker crash | [#3 Zombie running state](#3-zombie-running-state-after-worker-crash) |
| Bash tool times out on long-running rescue task | [#4 600s Bash limit on foreground rescue](#4-600s-bash-limit-on-foreground-rescue) |
| Hook fails with `MODULE_NOT_FOUND` on Windows cross-drive | [#5 Windows cross-drive hook MODULE_NOT_FOUND](#5-windows-cross-drive-hook-module_not_found) |
| `gpt-5.5` returns HTTP 400 invalid_request_error | [#6 gpt-5.5 invalid_request_error](#6-gpt-55-invalid_request_error) |
| `bwrap: setting up uid map: Permission denied` on Linux | [#7 Linux bwrap failure](#7-linux-bwrap-failure-on-vps--container) |
| Codex pinned in deleted directory after worktree cleanup | [#8 Worktree + background hang](#8-worktree--background-hang) |
| `"access token could not be refreshed"` after `codex login` | [#9 Stale auth cache](#9-stale-auth-cache-after-codex-logout--login) |
| All sessions show identical "Continue from the current..." name in Codex Desktop | [#10 Identical default-prompt session names](#10-identical-default-prompt-session-names) |
| Plugin sessions burying real chats in Codex Desktop | [#11 Codex Desktop history pollution](#11-codex-desktop-history-pollution) |

---

## 1. Stop-review-gate rewake loop (rate limit → token burn)

**Symptom**: After hitting the ChatGPT 5h rate limit, every session-end triggers a Codex review that fails, the gate returns `decision: "block"`, Claude Code retries, the gate fails again. Loop burns CC session token budget until you intervene.

**Fix**: v2.0.0 PR-3.1. The gate now classifies rate-limit / timeout / parse-error / empty-output as **infrastructure failure** (returns `decision: "allow"` with a stderr warning) instead of policy block. No rewake loop.

**Verify** the fix is active:

```bash
grep -n "detectInfrastructureFailure" plugins/codex/scripts/stop-review-gate-hook.mjs
```

If you still see the loop on v2.0.0+, file an issue with the stderr excerpt — the rate-limit signature set might be missing your provider's phrasing.

**Workaround** (v1.x): disable the review gate entirely:

```bash
/codex:setup --disable-review-gate
```

---

## 2. Large inline prompt silently rejected by Claude Code Bash

**Symptom**: `/codex:rescue` (or any flow that passes a multi-KB prompt as an argv string) fails with `"The user doesn't want to proceed with this tool use. The tool use was rejected ..."` even though no permission prompt was shown.

**Cause**: Claude Code's Bash tool silently rejects argv larger than ~6 KB. The wording is identical to a real user deny, so the parent agent can't distinguish.

**Fix**: v2.0.0 PR-3.2 added `--prompt-stdin` + a one-shot stderr warning when an inline prompt exceeds 3 KB.

**Workaround**: write the prompt to a file and use `--prompt-file`:

```bash
# Instead of:
/codex:rescue "<6KB of investigation context>"

# Do:
echo "<6KB of context>" > /tmp/prompt.md
/codex:rescue --prompt-file /tmp/prompt.md
```

Or pipe via stdin:

```bash
cat /tmp/prompt.md | /codex:rescue --prompt-stdin
```

---

## 3. Zombie running state after worker crash

**Symptom**:

- `/codex:status` shows a job with `status: "running"` for hours
- `/codex:status --wait` polls indefinitely against a dead PID
- `/codex:result <id>` returns "No job found" while `/codex:status <id>` shows the running record
- `--resume-last` cannot find the latest task because zombies block

**Cause** (v1.x): plugin did not check whether the recorded `pid` was alive. SIGKILL / OOM / broker disconnect bypassed catch blocks, leaving `status: "running"` forever.

**Fix**: v2.0.0 PR-1.1. Every read entrypoint (`/codex:status`, `/codex:result`, `--resume-last`, stop-review-gate) now reaps dead jobs via OS-level liveness check + birth-time comparison.

**Verify**:

```bash
node plugins/codex/scripts/codex-companion.mjs status
# Stale "running" jobs should be auto-reaped to "failed" / "terminated"
```

If a job is genuinely stuck (not dead), cancel it:

```bash
/codex:cancel <job-id>
```

---

## 4. 600s Bash limit on foreground rescue

**Symptom**: `/codex:rescue` for a long-running investigation (>10 min) — the wrapper returns "task dispatched" but the parent agent has no result. The codex-companion task continues in background but its output is lost.

**Cause**: Claude Code Bash tool has a 600s max timeout. Foreground rescue tasks beyond that time get killed at the wrapper level.

**Workaround** (v1.x and v2.0.0):

1. For tasks expected to take >5 min, use `--background`:

   ```bash
   /codex:rescue --background investigate the slow regression
   ```

2. Poll `/codex:status` until terminal:

   ```bash
   /codex:status task-mp7sdta9-ppf8we --wait
   ```

3. Retrieve result:

   ```bash
   /codex:result task-mp7sdta9-ppf8we
   ```

**Note**: v1.0.5 added a finalizing-phase timeout (5 min) so a stuck task no longer pins the process forever; you'll see a deterministic error after the timeout. Override via `CODEX_FINALIZING_PHASE_TIMEOUT_MS=<ms>`.

---

## 5. Windows cross-drive hook MODULE_NOT_FOUND

**Symptom**: On Windows + Git Bash / MSYS2, all 3 hooks (SessionStart, SessionEnd, Stop) fail with:

```
Error: Cannot find module 'D:\c\Users\Gower\.claude\plugins\cache\openai-codex\codex\1.0.4\scripts\stop-review-gate-hook.mjs'
  code: 'MODULE_NOT_FOUND'
```

The bogus `D:\c\` prefix is the giveaway — project drive (D:) prepended to POSIX-style `/c/...`.

**Fix**: v1.0.6 PR-4.2. hooks.json now chdir into `CLAUDE_PLUGIN_ROOT` first, then runs `node scripts/...` with a relative path. The shell handles the chdir natively (Git Bash translates `/c/...` → `C:\...`).

**Verify**:

```bash
cat plugins/codex/hooks/hooks.json | grep "cd \\\"\\${CLAUDE_PLUGIN_ROOT}"
# Should match every "command" line
```

---

## 6. gpt-5.5 invalid_request_error

**Symptom**:

```
{"type":"error","status":400,"error":{"type":"invalid_request_error",
 "message":"The 'gpt-5.5' model requires a newer version of Codex.
 Please upgrade to the latest app or CLI and try again."}}
```

even though your `codex --version` is current.

**Cause**: Two distinct issues:

1. v1.x sent `clientInfo.name: "Claude Code"` which the upstream allow-list rejected for newer models (v1.0.6 PR-5.1 changed to `codex-plugin-cc`).
2. The structured-review path (`/codex:review` / `/codex:adversarial-review`) had an upstream allow-list lag specifically for `gpt-5.5` (v1.0.6 PR-5.8 added auto-fallback to `gpt-5.4`).

**Fix**: v1.0.6. Both are addressed.

**Workaround** (older versions): explicitly pass `--model gpt-5.4`:

```bash
/codex:review --model gpt-5.4
```

---

## 7. Linux bwrap failure on VPS / container

**Symptom**:

```
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
bwrap: setting up uid map: Permission denied
```

Linux VPS or container where unprivileged user namespaces are restricted.

**Cause** (v1.x): plugin hard-coded `sandbox: "read-only"` for review, forcing the codex CLI's bundled bwrap path even when the user had configured `sandbox_mode = "danger-full-access"`.

**Fix**: v2.0.0 PR-2.1. The plugin now omits the sandbox field, letting the app-server inherit your `~/.codex/config.toml`. Set:

```toml
# ~/.codex/config.toml
sandbox_mode = "danger-full-access"
```

and the plugin will honor it.

**Verify**:

```bash
/codex:setup
# Should print the effective sandbox source as "user config" or similar
```

If you need to restore v1.x hard-coded behavior:

```bash
export CODEX_PLUGIN_SANDBOX_DEFAULT=read-only
```

---

## 8. Worktree + background hang

**Symptom**: `/codex:rescue --background` invoked inside a git worktree (`.git/worktrees/...`) hangs indefinitely. The host harness deletes the worktree as soon as the rescue subagent returns "task dispatched", leaving Codex running in a deleted directory.

**Fix**: v1.0.5 PR-1.8. The rescue agent + SKILL contract now detect worktree-isolation context and force foreground (no `--background`, no `run_in_background`).

**Workaround** (older versions): explicitly run foreground in worktree dirs:

```bash
/codex:rescue --wait investigate the regression
```

---

## 9. Stale auth cache after `codex logout && codex login`

**Symptom**: After fresh login, plugin-mediated calls (`/codex:rescue`, `/codex:adversarial-review`) fail with:

```
[codex] Codex error: Your access token could not be refreshed because you have since
logged out or signed in to another account. Please sign in again.
```

even though direct `codex exec` works fine with the same `~/.codex/auth.json`.

**Cause**: `codex app-server` caches the auth token at startup and does not re-read `~/.codex/auth.json` on subsequent invocations. Fresh login does not invalidate the daemon's cache.

**Fix**: v1.0.6 PR-5.2 adds an annotation that explains the real action.

**Workaround**: restart Claude Code (which respawns the broker + app-server). On POSIX:

```bash
pkill -f "codex app-server"
# Restart Claude Code; next invocation will re-read auth.json
```

On Windows:

```powershell
Stop-Process -Name codex -Force
```

---

## 10. Identical default-prompt session names

**Symptom**: In Codex Desktop, every "continue / resume" session appears with the same name:

```
Codex Companion Task: Continue from the current thread state. Pick...
```

All sessions indistinguishable.

**Fix**: v1.0.6 PR-5.7. When the user does not supply a prompt (fall-back path), the session name now includes the jobId for disambiguation:

```
Codex Companion Task: Continue from the current thread state. Pick... [task-mp7sdta9-ppf8we]
```

No action needed beyond upgrading to v1.0.6+.

---

## 11. Codex Desktop history pollution

**Symptom**: Codex Desktop's history feed buries your real chat threads under dozens of plugin-generated review / task / stop-gate threads.

**Cause** (v1.x): plugin and Codex Desktop shared `~/.codex/` as the session home.

**Fix**: v2.0.0 PR-5.6. Plugin-spawned codex now uses `$HOME/.codex/claude-code/` so its sessions are isolated.

**If you want to keep shared history** (e.g. to resume plugin threads in Codex Desktop):

```bash
export CODEX_PLUGIN_USE_DEFAULT_HOME=1
```

**If you want to migrate existing plugin sessions to the new home**:

```bash
mkdir -p ~/.codex/claude-code/sessions
cp -r ~/.codex/sessions/<plugin-thread-ids> ~/.codex/claude-code/sessions/
```

---

## When to file an upstream issue

If your symptom does not match any section above:

1. Run `/codex:setup --json` and capture the output (env, CLI version, plugin version)
2. Reproduce with `--background` + `/codex:status --wait` so you have logs
3. File at https://github.com/openai/codex-plugin-cc/issues with:
   - exact command
   - `/codex:setup --json` output
   - relevant log excerpt from `~/.claude/plugins/data/codex-openai-codex/state/<workspace>/jobs/<job-id>.log`
   - OS / shell / Node / codex-cli versions

Known investigations in progress (not yet fixed in v2.0.0):

- #295 `CreateProcessAsUserW failed: 1920` on Windows + sandbox=elevated
- #277 review `--background` hang 2-30 min on Windows + CLI 0.125+
- #310 zh-TW / non-UTF-8 locale Big5 JSONL parser crash (upstream codex CLI)
- #141 macOS SCDynamicStore NULL panic inside Antigravity sandbox
