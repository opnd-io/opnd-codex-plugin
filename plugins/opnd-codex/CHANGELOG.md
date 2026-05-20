# Changelog

## Unreleased

- `codex.mjs` `runAppServerReview`: review path no longer hard-codes `sandbox: "read-only"`. It now forwards `options.sandbox` through the same `resolveSandboxValue` helper the task path uses, completing the v2 BREAKING #1 contract documented in `docs/MIGRATION_v2.0.md` row 1 (review / adversarial-review omit sandbox so the app-server inherits `~/.codex/config.toml` `sandbox_mode`). Adversarial-review was already on this path; only the structured-review entrypoint had been left on the legacy hard-code. Legacy v1.x behavior is still restorable with `CODEX_PLUGIN_SANDBOX_DEFAULT=read-only`
- `codex-companion.mjs` `runStatusWatch`: replaced the content-`Set` line-dedup with a byte-offset watermark (`readLogTailFromOffset`). Repeated identical lines (heartbeats, structurally-equal progress events) are no longer silently dropped on `status --watch`. The 1000-entry dedup cap is removed; memory is bounded by the per-tick 8 MB read cap (matches `readLogTail`). Truncate / rotation resets the watermark; unterminated trailing lines flush on terminal-state exit
- `lib/log-tail.mjs` (CDX-001 / CDX-002 / CDX-003 audit follow-up): watermark helper extracted into a dedicated lib module so tests can call it directly instead of mirroring the algorithm against fs primitives. First-tick now uses a single atomic `readLogTailFromOffset(file, 0, "")` call — eliminates the race window between the prior `readLogTail` + separate `fs.statSync().size` pair where any append landing between the two calls silently disappeared. A streaming `TextDecoder("utf-8", { fatal: false })` is threaded through the helper so a multi-byte UTF-8 sequence split across two ticks is buffered and reunified instead of finalizing as U+FFFD
- `lib/codex.mjs` `__testHooks` (CDX-004 audit follow-up): expose `resolveSandboxValue` + `buildThreadParams` so the sandbox-default-omit contract test exercises the actual runtime helpers (omit when caller passes nothing, env override honored, explicit caller value wins) instead of relying on a source-level regex against `executeReviewWithModel`
- **Project rename → `opnd-codex-plugin`** (PR #8) — BREAKING for invocation: the marketplace is now `opnd-codex-plugin`, the plugin is `opnd-codex`, and every slash command moves from `/codex:*` to **`/opnd-codex:*`**. Install alias is now `opnd-codex@opnd-codex-plugin`; the plugin directory moved `plugins/codex/` → `plugins/opnd-codex/`. Gated by a Claude+Codex legal/policy delta review (`safe-with-conditions`); `LICENSE` / `NOTICE` / `Copyright 2026 OpenAI` / upstream `openai/codex-plugin-cc` attribution all preserved, and internal `codex.mjs` / "Codex CLI" references are intentionally untouched (nominative use of the wrapped OpenAI Codex CLI)
- **Upstream Tier 1 8-HIGH manual port** (PR #3) — fork could not cherry-pick cleanly against the v2.0/v2.1 hardening, so eight upstream HIGH items were manually ported: per-turn inactivity watchdog (`TurnWatchdogError`, exit 124 — upstream #312), child env-injection sanitization (#190), `--prompt-file` path containment (#289), git ref `--end-of-options` injection guard (#290), UTF-8-safe prompt truncation (#314), and JSONL ANSI-escape strip + non-JSONL stdout guard via the new `lib/jsonl.mjs` `cleanProtocolLine` (#24 / #311)
- **`pair` / `capsule` / `output-profile` / `task-key` workstream landed** (PR #4) — `17385e4` had committed `codex-companion.mjs` importing `readCapsule` (untracked) and `readTaskSession` (an uncommitted `state.mjs` export), so a clean tree failed to load. PR #4 lands the rest of that delta — `lib/capsule.mjs`, `lib/task-identity.mjs`, task-session persistence in `state.mjs`, `schemas/output-profiles/`, `prompts/profiles/`, the `pair` command — plus the PR #3 code-review fixes ARCH-002 (`git.mjs collectReviewContext` `--end-of-options`) and SEC-001 (`ENV_INJECTION_VECTORS` + `GIT_CONFIG_*` prefix, NTFS-unsafe task-session filename)
- **Pair-readiness fixes A1–A4** (PR #6, from the Claude×Codex adversarial readiness review) — A1: `waitForApprovalDecision` was an unbounded `while (true)`; now bounded by `CODEX_PLUGIN_APPROVAL_WAIT_MS` (default 30 min, `0` = unbounded). A2: the per-turn watchdog now defaults ON — `CODEX_TURN_WATCHDOG_MS` (default 10 min silence bound, `0` disables). A3: `teardownBrokerSession` defaults to a real `terminateProcessTree` kill instead of skipping when no `killProcess` callback is passed. A4: `--prompt-file` containment now resolves symlinks (`realpathSync`) so a symlink inside cwd cannot bypass `CODEX_PLUGIN_PROMPT_FILE_STRICT`
- **Upstream backlog #59 / #113 / #238 / #75 closed** (PR #7) — #59: `resolveStateDir` migrates state written to the tmpdir fallback (a `/opnd-codex:*` command run without `CLAUDE_PLUGIN_DATA`) into the persistent plugin-data dir, rewriting absolute path references (manual port of upstream PR #125). #113: `setup.md` documents Windows mojibake `npm install` stderr handling. #238: README FAQ explains the `disable-model-invocation` commands. #75: `TROUBLESHOOTING.md` #15 documents that host `.claude/settings.json` deny rules are separate from the plugin's Codex approval system (a full bridge stays on the backlog)

## 2.1.0

The v2.1.0 line was already advertised in `README.md` (observability + UX changes) but was never given an explicit changelog block. The features below were already on `main` ahead of this header — this entry retroactively pins their PR / issue references so `package.json`, `README.md`, and `CHANGELOG.md` finally agree on the released version. See the audit map under `docs/exploration/2026-05-18-163003-codex-as-claude-subagent.md` (axis AH).

- **JSONL telemetry stream + `trace.id` correlation** (PR-9.1, PR-9.2): append-only `${CLAUDE_PLUGIN_DATA}/telemetry/events.jsonl` with `schemaVersion: 1`, 16-char hex `traceId` per job, `enqueued / started / completed / failed / cancelled / terminated` events. Opt-out via `CODEX_PLUGIN_TELEMETRY_DISABLED=1`. POSIX writes rely on `fs.appendFileSync` atomicity (<4 KB lines); Windows lacks documented atomic-append, called out as a known best-effort trade-off in the source. Never-crashing — every emit is wrapped in `try/catch`
- **`/opnd-codex:status --tail [--tail-lines <N>]` + `/opnd-codex:status --watch [--watch-interval-ms <ms>]`** (PR-3.5, #264 / #237): one-shot tail dump or polling watch of the per-job log + `traceId`-matched telemetry events. Mutually exclusive with `--wait`. Exits on terminal status (`completed / failed / cancelled / terminated / timeout`). Watch loop streams only newly-appended log bytes (see also the byte-offset watermark fix in the `Unreleased` block)
- **User-level config defaults** (PR-7.7, #213): `~/.codex-plugin-cc/config.json` (or `$XDG_CONFIG_HOME/codex-plugin-cc/config.json`, or `$CODEX_PLUGIN_USER_CONFIG`) lets users persist `defaultModel`, `defaultEffort`, and `defaultSandbox` for `task` / `review`. CLI flags still win; unknown keys emit one stderr warning per process
- **Opt-in audible completion bell** (PR-7.4, #134): `CODEX_PLUGIN_BELL_ON_COMPLETE=1` rings `\x07` to stderr whenever a tracked job reaches a terminal state. Wired into success / catch / `markJobTerminated` / `handleCancel` so all four exit paths emit exactly once. Default OFF
- **Non-UTF-8 host locale mitigation** (PR-4.5, #310): the plugin spawns Codex with `LANG=C.UTF-8` / `LC_ALL=C.UTF-8` (POSIX) or `LANG=en_US.UTF-8` / `LC_ALL=en_US.UTF-8` (Windows) when the host locale is missing or non-UTF-8, defeating the upstream Codex JSONL parser crash on hosts like `zh_TW.Big5`. Walks the POSIX `LC_ALL > LC_CTYPE > LANG` precedence ladder; empty `LC_ALL=""` is treated as unset. One-shot stderr notice on first override. Opt-out via `CODEX_PLUGIN_PRESERVE_LOCALE=1`
- **Non-interactive command fallbacks** (PR-7.8, #223): `/opnd-codex:review` / `/opnd-codex:adversarial-review` / `/opnd-codex:rescue` / `/opnd-codex:setup` detect missing `AskUserQuestion` (e.g. `claude --print`, CI) and pick safe defaults — review/adversarial-review default to `--background` so `claude --print` is not blocked for minutes; rescue defaults to `--fresh` so a prior session is not silently inherited; setup defaults to "Skip for now" so no auto `npm install -g @openai/codex` is attempted without operator consent

### Documented silent drift (axis AJ — same release, called out separately)

These are not new behavioral changes since v2.1.0 first appeared on `main`, but they were not in the v2.0.0 `BREAKING` list and so previously surfaced as invisible drift to users migrating from v2.0.0:

- **Telemetry schema = `schemaVersion: 1`** is the contract bumped versions will respect. Field set: `ts, schemaVersion, event, traceId, jobId, jobClass, phase, cwd, elapsedMs, errorClass, fallbackPath, model, effort, threadId, extras`. Treat the file as best-effort / lossy under Windows multi-process concurrency
- **Locale override (PR-4.5)** mutates **the spawned codex child env only**. The user's shell env is untouched. Notice fires once per process. The override target is `C.UTF-8` on POSIX and `en_US.UTF-8` on Windows — these differ on purpose (`C.UTF-8` is a glibc-ism that Windows UCRT historically declines)
- **Broker idle-watchdog defaults** are 10 min grace + 2 min interval (`CODEX_BROKER_IDLE_GRACE_MS` / `CODEX_BROKER_IDLE_INTERVAL_MS`). Orphan brokers reaped within ~12 min instead of the older ~35 min worst case
- **Stop-review-gate hook**: rate-limit / quota / timeout / invalid-JSON / empty-output now return `decision: "allow"` with a stderr warning (was a `decision: "block"` rewake loop that burned CC session tokens). The hook still BLOCKS for genuine review failures; only infrastructure failure signatures are downgraded to ALLOW + warn (PR-3.1, #306 / #248 / #273 — also listed in `## 2.0.0 — BREAKING`)

## 1.2.0

- `task --resume-id <thread-id>` — resume a specific Codex thread by app-server id, mutually exclusive with `--resume-last` / `--fresh` (#230)
- `task --context <text>` — prepend a `<context>...</context>` block before the user prompt for cheap orientation (#284)
- `task --fast` — request the Codex fast service tier (~1.5x speed / ~2x credits) via `-c service_tier=fast`. Forces direct codex spawn (broker bypass) so a fast caller does not change tier for non-fast siblings (#210)
- `review --branch <ref>` / `adversarial-review --branch <ref>` — review a remote branch without local checkout. Default base is the repo default branch; pair with `--base` for explicit ranges (#114)

## 2.0.0 — BREAKING

- **BREAKING**: plugin codex sessions now land in `$HOME/.codex/claude-code/` (`CODEX_HOME` override) instead of polluting `~/.codex/` and the Codex Desktop history feed. Restore legacy shared home with `CODEX_PLUGIN_USE_DEFAULT_HOME=1` (#282)
- **BREAKING**: sandbox default is inherited from `~/.codex/config.toml` (`sandbox_mode`) instead of hard-coded `read-only` / `workspace-write`. Linux bwrap failures, macOS Seatbelt `.git` blocks, and `--write + git push` DNS failures are gone. Restore legacy with `CODEX_PLUGIN_SANDBOX_DEFAULT=read-only` (#240 / #167 / #304)
- one-shot first-run notice on stderr documents both BREAKING changes + the opt-out env vars. Suppress with `CODEX_PLUGIN_SUPPRESS_V2_NOTICE=1`
- `task --full-access` / `--dangerously-skip-permissions` — convenience aliases that imply `--sandbox danger-full-access --approval never`. Explicit `--sandbox` / `--approval` still win. Prints a stderr warning when active (#124 / #145)
- `task --prompt-stdin` — explicit pipe marker for multi-KB prompts that would otherwise trip the upstream argv-size rejection that masquerades as "user denied" (#308). One-shot stderr warning when an inline prompt exceeds 3 KB
- `review --max-findings <N>` — lift the implicit 2-3 finding cap (default 20, hard cap 100). prompts/adversarial-review.md updated to instruct the model accordingly (#298)
- `review --background` is finally wired through `enqueueBackgroundTask` (it had been declared in options but never read) (#279 / #207)
- stop-review-gate hook: rate-limit / quota / timeout / invalid-JSON / empty-output all return `decision: "allow"` with a stderr warning instead of a `decision: "block"` rewake loop that burned CC session tokens on every retry (#306 / #248 / #273)

## 1.0.6

- Windows + Git Bash / MSYS2: hook commands `cd "$CLAUDE_PLUGIN_ROOT"` first so node receives a relative script path that resolves on every drive. MODULE_NOT_FOUND on cross-drive setups is gone (#285)
- review prompt: when the workspace is a linked git worktree, surface that fact in the collection-guidance block so Codex stops probing `--git-dir` / `safe.directory` for ~10 sandbox-declined commands (#280)
- `task --profile <name>` — select a `[profiles.<name>]` block from `~/.codex/config.toml` for the invocation. Forces a direct codex spawn so the broker's fixed profile does not override (#251)
- `clientInfo.name` reports `codex-plugin-cc` instead of `Claude Code`. gpt-5.5 no longer rejects with 400 `invalid_request_error` from the upstream allow-list (#199 / #276)
- delegated session thread name now includes the jobId when the user did not pass a prompt (fall-back path), so /opnd-codex:status + Codex Desktop can tell repeated "continue" sessions apart (#283)
- review structured-output path: when the user's default model is `gpt-5.5` and the upstream still rejects it for structured review, auto-fallback to `gpt-5.4` once with a warning. Explicit `--model` is always honored (#270)
- custom `openai_base_url` in `~/.codex/config.toml` (or `CODEX_PLUGIN_SKIP_AUTH=1`) bypasses the OpenAI auth gate. Self-hosted endpoints and proxies work without patching plugin source (#233)
- stale-auth-cache failure path is annotated with a clear "restart Claude Code so the next invocation re-reads ~/.codex/auth.json" hint after `codex logout && codex login` (#281)

## 1.0.5

- `tests/helpers.mjs`: track every `makeTempDir()` workspace + broker session dir, sweep on process exit / SIGINT / SIGTERM / SIGHUP / SIGBREAK. Test orphan brokers under `/tmp/cxc-*` no longer accumulate to 100+ on dev machines (#163)
- `runTrackedJob`: install foreground SIGTERM / SIGINT / SIGHUP / SIGBREAK handlers around the runner. Killed jobs now reach a terminal `status:"failed" + phase:"terminated" + failureReason:"signal:<NAME>"` instead of an indefinite `status:"running"` zombie (#228)
- `codex.mjs`: bound the `finalizing` phase. A turn stuck after `exitedReviewMode` / `final_answer` for 5 min self-fails with a deterministic error message, releasing the state lock. Override via `CODEX_FINALIZING_PHASE_TIMEOUT_MS` (#183)
- `state.mjs` PID liveness reaper: `listJobs(cwd, { reap: true })` (now used by every read entrypoint + stop-review-gate) sweeps running / queued jobs whose pid is dead OR whose `processStartedAt` no longer matches the OS-reported birth time. `failureReason` = `reaper:process_died` / `reaper:pid_reused`. Resolves the shared root cause behind #222 / #164 / #202 / #264
- async + bounded hook stdin drain in `lib/fs.mjs` (`readStdinAsync` / `readHookStdinJsonAsync`). Both `session-lifecycle-hook` and `stop-review-gate-hook` migrate off the synchronous `fs.readFileSync(0)` that crashed with EAGAIN on parallel sessions and blocked the Stop hook for the full 900s timeout on Windows Git Bash (#120 / #247 / #191)
- broker idle watchdog tightened to 10 min grace + 2 min interval (env override `CODEX_BROKER_IDLE_GRACE_MS` / `CODEX_BROKER_IDLE_INTERVAL_MS`). Orphan brokers are reaped within ~12 min instead of ~35 min in the worst case (#193)
- `ensureBrokerSession` runs the entire read-decide-spawn-write critical section under `withBrokerLockAsync` (new mkdir-based `.broker.lock/` directory, parallel to the state lock). Closes the third race in #286 where two parallel `/opnd-codex:*` from the same cwd both spawned orphan brokers
- `codex-rescue` agent + `codex-cli-runtime` skill: never use `--background` / `run_in_background` inside a git worktree (cwd matches `.git/worktrees/*` or `*/.claude/worktrees/*`). Foreground keeps the Bash call alive so the host harness waits for the result instead of deleting the worktree mid-run (#198)

## 1.0.4

- `/opnd-codex:agent`: approval-aware control with `--approval` policy (`never` / `on-request` / `on-failure` / `untrusted`) and pending-approval surfacing in `/opnd-codex:status`
- `/opnd-codex:rescue` and `/opnd-codex:agent`: `--sandbox` override (`read-only` / `workspace-write` / `danger-full-access`) for explicit sandbox control
- Hardened approval controls: stricter approval state tracking and risk classification
- Windows companion runtime: hardened test suite for cross-platform consistency
- `/opnd-codex:rescue`: routes through the Agent tool to prevent Skill recursion
- Bash arg quoting fix for `cancel`, `result`, `status` commands
- README: corrected invalid `xhigh` reasoning effort
- `codex-rescue` agent: `model:` declared in frontmatter
- Companion: honors `--cwd` when reporting session runtime

## 1.0.3

- App-server auth status used for Codex readiness
- Graceful handling of older Codex CLI without `thread/name/set`
- App-server spawn inherits `process.env` when no explicit env is provided
- Windows: respects `SHELL` for Git Bash
- Working-tree review no longer crashes on untracked directories
- Implicit resume-last and default cancel selection scoped to the current Claude session

## 1.0.2

- CI: pull request workflow added (tests + build)
- Tests: portable across platforms, repo roots derived from test file locations
- Reduced background task timing flakiness in tests
- Windows ENOENT fix when spawning `codex app-server`

## 1.0.1

- Windows: `shell: true` on `spawnSync` so `.cmd` shims resolve

## 1.0.0

- Initial version of the Codex plugin for Claude Code
