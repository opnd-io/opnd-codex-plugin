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
| `/codex:setup` reports `loggedIn: false` even though `codex login` succeeded | [#12 Plugin loggedIn false after codex login (v2.0.0 home isolation)](#12-plugin-says-loggedin-false-after-a-successful-codex-login-v200-home-isolation) |

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

## 12. Plugin says `loggedIn: false` after a successful `codex login` (v2.0.0 home isolation)

**Symptom**:

```bash
$ codex login
Successfully logged in

$ /codex:setup
# JSON output contains:
"auth": {
  "available": true,
  "loggedIn": false,
  "detail": "The active provider requires OpenAI authentication",
  "requiresOpenaiAuth": true
}
```

Every `/codex:rescue`, `/codex:task`, `/codex:review` invocation that triggers the auth gate then fails with the same `loggedIn: false` even though `codex exec` from a normal shell still works.

**Cause**: v2.0.0 PR-5.6 changed `CODEX_HOME` for plugin-spawned codex processes to `$HOME/.codex/claude-code/` so plugin sessions stop polluting the Codex Desktop history feed (see [#11](#11-codex-desktop-history-pollution)). `codex login` from a normal shell still writes `auth.json` into the **shared** `~/.codex/` because that is the codex home it sees. The plugin's app-server, running with the isolated home, never reads that token.

This is by design but easy to miss — the first-run notice mentions the home change but does not call out the auth file as a separate file to migrate.

**Fix** (pick one):

**Option A — one-time copy** (lowest impact, preserves history isolation):

```bash
cp ~/.codex/auth.json ~/.codex/claude-code/auth.json
```

Repeat after every `codex logout && codex login` cycle (or after any token rotation surfaced by section [#9](#9-stale-auth-cache-after-codex-logout--codex-login)).

**Option B — log in directly into the plugin home** (write-through, no copy needed):

```bash
CODEX_HOME="$HOME/.codex/claude-code" codex login
```

Same flow as a normal `codex login`, but the token lands in the plugin's home from the start. Re-run this instead of plain `codex login` whenever you rotate the token.

**Option C — opt out of home isolation** (shares Codex Desktop history again, restores v1.x behavior):

```bash
export CODEX_PLUGIN_USE_DEFAULT_HOME=1
```

Choose this only if you actively resume plugin-launched threads in Codex Desktop or do not mind the history pollution from [#11](#11-codex-desktop-history-pollution).

**Verify the fix**:

```bash
/codex:setup --json | grep -E "loggedIn|detail"
# Expect:  "loggedIn": true, "detail": "ChatGPT login active for <email>"
```

**Related**: If the auth annotation says the token "could not be refreshed" instead of `loggedIn: false`, you have hit section [#9](#9-stale-auth-cache-after-codex-logout--codex-login) (broker-cached stale token), not this section.

---

## When to file an upstream issue

If your symptom does not match any section above:

1. Run `/codex:setup --json` and capture the output (env, CLI version, plugin version)
2. Reproduce with `--background` + `/codex:status --wait` so you have logs
3. File at https://github.com/openai/codex-plugin-cc/issues with:
   - exact command
   - `/codex:setup --json` output
   - relevant log excerpt from `~/.claude/plugins/data/codex-openai-codex/state/<workspace>/jobs/<job-id>.log`
   - relevant JSONL events from `~/.claude/plugins/data/codex-openai-codex/telemetry/events.jsonl` filtered by your job's `traceId` (printed in the job log header as `trace.id=<16-char-hex>`), e.g.: `jq -c 'select(.traceId == "abcdef1234567890")' ~/.claude/plugins/data/codex-openai-codex/telemetry/events.jsonl`
   - OS / shell / Node / codex-cli versions

### Telemetry stream — what it is and how to opt out

v2.1.0 added an append-only JSONL telemetry stream at `~/.claude/plugins/data/codex-openai-codex/telemetry/events.jsonl`. Each job emits at minimum `enqueued` (background only) / `started` / one of `completed | failed | cancelled | terminated | timeout`, all tagged with a 16-character `traceId` so events for one logical run can be stitched back together across the broker / worker boundary. The stream is local-only — nothing is sent anywhere. It exists for the user to grep their own history when filing a bug.

Schema (v1):

```json
{"schemaVersion":1,"ts":"2026-05-18T10:50:00.123Z","event":"started","traceId":"abc...","jobId":"task-...","jobClass":"rescue","phase":"starting","cwd":"/repo/x"}
```

Opt-out (every event short-circuits before any filesystem access):

```bash
export CODEX_PLUGIN_TELEMETRY_DISABLED=1
```

Debug missing events (surface swallowed write errors on stderr):

```bash
export CODEX_PLUGIN_TELEMETRY_DEBUG=1
```

If the file is missing entirely after running a job, check the opt-out env var first, then `CODEX_PLUGIN_TELEMETRY_DEBUG=1` + re-run to see the underlying error.

## 13. Non-UTF-8 host locale + Codex JSONL parser crash (#310)

**Symptom**: Codex panics with an "invalid utf-8 sequence" stack trace, typically on `LANG=zh_TW.Big5`, `zh_CN.GBK`, `ja_JP.EUC-JP`, `ko_KR.EUC-KR`, or an unset `LANG` combined with `LC_ALL=C`.

**Cause**: The upstream codex CLI's JSONL parser reads from its stdio assuming a UTF-8 byte stream. A multi-byte sequence in non-UTF-8 encoding surfaces as invalid UTF-8 and panics the parser. Root cause is in the codex CLI itself.

**Plugin-side mitigation (v2.1.0+)**: The plugin overrides `LANG` and `LC_ALL` to `C.UTF-8` **for the spawned codex child only**. Your shell env is untouched. A one-shot stderr notice prints on the first override per process:

```text
[codex-plugin-cc] non-UTF-8 host locale detected (LANG=zh_TW.Big5, LC_ALL=<unset>). Spawning codex with LANG=C.UTF-8 + LC_ALL=C.UTF-8 to avoid the #310 JSONL parser crash. Restore your host locale with CODEX_PLUGIN_PRESERVE_LOCALE=1.
```

**Opt out** (if you need localized codex output — translated messages, region-specific date formats, etc.):

```bash
export CODEX_PLUGIN_PRESERVE_LOCALE=1
```

With opt-out the host locale passes through unchanged and the #310 crash risk returns.

**Verify the mitigation is active**:

```bash
grep -n "applyUtf8LocaleOverride" plugins/codex/scripts/lib/app-server.mjs
```

---

Known investigations in progress (not yet fixed in v2.0.0, no plugin-side mitigation yet):

- #295 `CreateProcessAsUserW failed: 1920` on Windows + sandbox=elevated
- #277 review `--background` hang 2-30 min on Windows + CLI 0.125+
- #141 macOS SCDynamicStore NULL panic inside Antigravity sandbox

---

## A. Diagnostic data to gather for the spike-grade open issues

Sections #1-#13 ship plugin-side fixes / mitigations. The remaining items in the "Known investigations" list are **spike-grade** — root cause is in the OS layer, the codex CLI, or an upstream protocol, and the fix needs a dedicated investigation we have not yet been able to run. While that work is pending, the most useful thing a reporter can do is capture diagnostic data the next investigation can replay against. This section enumerates what to capture per issue so the eventual fix lands faster.

### #295 — Windows `CreateProcessAsUserW failed: 1920`

The codex CLI's elevated sandbox path on Windows tries to launch a child as the impersonated user; Windows error 1920 ("the file cannot be accessed by the system") fires intermittently. We do not have a clean repro on a non-elevated dev box.

Capture before filing:

```powershell
# 1. Exact codex CLI + plugin version + OS build.
codex --version
node "$env:USERPROFILE\.claude\plugins\cache\openai-codex\codex\1.0.2\scripts\codex-companion.mjs" setup --json | Select-Object -First 30
[Environment]::OSVersion

# 2. Effective sandbox config the plugin sees.
type "$env:USERPROFILE\.codex\config.toml"

# 3. The full stderr trace from the failing run, including the Win32 error.
$env:CODEX_PLUGIN_TELEMETRY_DEBUG = "1"   # surface swallowed write errors
node "$env:USERPROFILE\.claude\plugins\cache\openai-codex\codex\1.0.2\scripts\codex-companion.mjs" task --sandbox workspace-write "smallest reproducer you can find" 2>&1 | Tee-Object -FilePath repro.log

# 4. Token state at failure (sanity check — auth.json must exist + be readable).
Get-ChildItem "$env:USERPROFILE\.codex\auth.json"
Get-ChildItem "$env:USERPROFILE\.codex\claude-code\auth.json"  # if v2.0.0+
```

Workaround until the spike: omit `--sandbox workspace-write` and let codex pick the unelevated default. The plugin's v2.0.0 sandbox-inherit behavior (BREAKING #1 in MIGRATION_v2.0.md) means most users do not need the explicit flag.

### #277 — Windows `review --background` hang 2-30 min on CLI 0.125+

Background review on Windows occasionally pins for minutes before producing output. Bisection across 5 codex CLI versions in the v2.0.0 sprint did not isolate a single regression revision, so the cause is most likely environmental (Defender / antivirus scanning the spawned child, NTFS lock contention on the broker pipe, or Windows pipe scheduling under load) rather than a CLI regression.

Capture before filing:

```powershell
# 1. /codex:status while the hang is in progress — the new --tail/--watch
#    surfaces both the job log and the v2.1.0 telemetry traceId.
node "$env:USERPROFILE\.claude\plugins\cache\openai-codex\codex\1.0.2\scripts\codex-companion.mjs" status <jobId> --watch --tail-lines 100 | Tee-Object -FilePath hang.log

# 2. Exit codex Desktop + AV exclusion on the plugin home and re-run. If the
#    hang vanishes with AV bypassed, that is the cause and the user needs to
#    add an AV exclusion (not a plugin bug).
Add-MpPreference -ExclusionPath "$env:USERPROFILE\.codex"
Add-MpPreference -ExclusionPath "$env:USERPROFILE\.claude\plugins\data\codex-openai-codex"

# 3. Capture the broker process tree while hung — useful to tell whether
#    the child is alive but blocked on I/O vs already-dead-PID-not-reaped.
Get-Process node, codex | Format-List Id, ParentProcessId, CPU, StartTime
```

Workaround: `/codex:review --wait` (foreground) usually does not hit the hang because there is no broker pipe in play.

### #6.7 — MCP elicitation forwarding + tool-loop guard

The MCP protocol's `elicitation/create` request flows from server → host; the plugin's tool-loop guard needs to know when an elicitation is in-flight so it does not interrupt mid-question. Fix needs a protocol fixture matrix (server/host pairs that emit valid + malformed elicitation frames) which we do not have yet.

Capture before filing:

```bash
# 1. The exact MCP server you connected. The codex CLI talks to multiple
#    server kinds (filesystem, web, custom) and elicitation behavior
#    differs.
codex mcp ls 2>&1 | head -40

# 2. The full JSONL trace from the broker for the failing turn. The PR-9.1
#    telemetry stream includes traceId so events from one logical run can
#    be grepped out:
jq -c 'select(.traceId == "<traceId-from-failing-job>")' \
  ~/.claude/plugins/data/codex-openai-codex/telemetry/events.jsonl

# 3. The verbatim elicitation request the server sent (look for
#    "elicitation/create" in the per-job log file).
grep -A 20 "elicitation/create" \
  ~/.claude/plugins/data/codex-openai-codex/state/<workspace>/jobs/<job-id>.log
```

Workaround: avoid MCP servers that issue elicitation until the fixture matrix lands. The plugin still works without the loop-guard fix; it is only the protocol-spec-compliant behavior that is missing.

### #141 — macOS SCDynamicStore NULL panic inside Antigravity sandbox

Apple Silicon + the Antigravity sandbox occasionally fails to bring up the SCDynamicStore, panicking the codex CLI. Root cause is in Antigravity itself — outside the plugin's reach.

Capture before filing:

```bash
# 1. Apple Silicon model + OS build + Antigravity version
system_profiler SPHardwareDataType | grep -E "Model|Chip"
sw_vers
defaults read /Applications/Antigravity.app/Contents/Info.plist CFBundleShortVersionString

# 2. The codex CLI stderr at panic — include the full SCDynamicStore trace
codex exec "smallest repro" 2>&1 | tee repro.log

# 3. Whether the same prompt works in a non-sandboxed shell. If yes, the
#    bug is Antigravity's, not codex's.
```

Workaround: run codex outside the Antigravity sandbox (system Terminal.app / iTerm2). The plugin behaves identically; it is only the panicking child that needs the unsandboxed environment.

### Why these are not yet plugin-side fixed

For each: the plugin would have to either (a) detect the environment condition on its own and refuse to spawn (hostile UX — the user wants the operation to work, not to be told "no"), or (b) work around the OS / protocol bug with shims that the upstream may fix at any time, leaving the plugin carrying dead workaround code. The capture-and-file path is the lowest-risk move while the upstreams catch up.
