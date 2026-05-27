# Changelog

## Unreleased

- **daily-evolve-pipeline Phase 0 PoC** (`plan-daily-evolve-pipeline.md`) — 매일 morning 9 KST 자동 routine 의 첫 phase. Codex pair R1-R7 0-수렴 (총 50 finding 적용, 합의 25건) 후 implement 진입. Phase 0 scope:
  - `scripts/daily-evolve/lib/` — 7 pure modules (zero npm, node 내장만):
    - `verdict-schema.mjs` — (verdict, signal_type) 2-축 enum + JSON schema (R2-M6)
    - `dedupe-key.mjs` — sha256 PR dedupe key + normalized_title (R3-M1 강화 — CJK punctuation / Extended_Pictographic / semver prerelease / PR/Issue 번호 lookbehind)
    - `fixed-resolver.mjs` — FIXED 3-evidence + reject pattern (R3-M2)
    - `cost-profile-registry.mjs` — Codex pair profile cost_units (R3-H3 / R4-M2 / R5-L1 max(1,ceil) / R5-L2 schema)
    - `state-migrator.mjs` — schema migration runner + MigrationError + 5 fail-closed reason enum (R3-H4 / R4-H2)
    - `run-ledger.mjs` — `daily-evolve-runs-YYYY.json` schema + buildEntry/finalizeEntry/queryLastN/mergeLedgers (R3-M6 / R4-M4 / R5-M5)
    - `citation-check.mjs` — Levenshtein similarity + agentId 형식 + fuzzy threshold 0.8 (R3-M3)
  - `scripts/daily-evolve/` — 3 orchestrators (side effect 허용):
    - `source-aggregator.mjs` — upstream PR + Issue (gh api) + telemetry (events.jsonl) → `docs/upstream-tracking/{YYYY-MM-DD}/raw.json`
    - `diff-analyzer.mjs` — (verdict, signal_type) 분류 + fixed-resolver 통합 (touchedPath/testAssertion/linkedPRMerge evidence inject)
    - `digest-writer.mjs` — `docs/daily-evolve/{YYYY-MM-DD}.md` + cognitive metadata header (decision_count / estimated_reading_minutes / manual_actions_required) + no_changes/failures/last_3_runs 별도 섹션 + ≤500줄 cap + citation-check 통합
  - `commands/daily-evolve.md` + `codex-companion.mjs handleDailyEvolve` — 수동 trigger (`/opnd-codex:daily-evolve [YYYY-MM-DD] [--skip-gh-api]`) + atomic run-ledger entry write
  - `tests/daily-evolve/*.test.mjs` — 8 test files, 88 unit tests (verdict-schema / dedupe-key / fixed-resolver / cost-profile-registry / state-migrator / run-ledger / citation-check / lib-dependency-rule). Phase 0.9 lib dep rule guard 가 lib/*.mjs 의 forbidden fs/network import 검출
  - `state/daily-evolve-runs-YYYY.json` — run status ledger (FULL git tracked per 사용자 #1, tarball cache 만 gitignore 예외)
  - `package.json scripts.test` glob 확장 (`tests/*.test.mjs tests/daily-evolve/*.test.mjs`)
  - **Default 결정 7건 적용** (사용자 implement 진입 시): LLM 분담 (a) / CRON_TZ env-probe 분기 / status UI = digest header only / Phase 6 rollback 자동 draft / state lazy create / no needs_claude_judgment metric / token-normalized cost only
  - Phase 1+ (Codex L3 triage, active fork L7, autonomous PR L5, scheduled-tasks MCP, self-evolve meta loop) 는 후속 진입
- **daily-evolve-pipeline Phase 1 — Codex L3 Triage 통합** — `plan §Phase 1`:
  - `scripts/daily-evolve/lib/triage-metric.mjs` (pure) — decision_count (3분류 별) / estimated_reading_minutes (CJK+ASCII word count / 200wpm) / manual_actions_required / triage_budget_minutes 30 / exceeds_budget alert
  - `scripts/daily-evolve/lib/cost-cap.mjs` (pure) — median 계산 + computeCap (baseline median × 3, initial=20) + appendBaseline (last 7 FIFO) + SKIP_REASONS enum (CLAUDE.md taxonomy 일치)
  - `scripts/daily-evolve/codex-triage.mjs` (orchestrator) — N≥3 fan-out 후 triage 실행. Phase 1 PoC = heuristic stub (verdict 기반: FIXED/WONTFIX→autonomous_safe, QUESTION→needs_claude_judgment, PARTIAL/NOT-FIXED→needs_user). actual Codex pair 호출은 Phase 1.5+
  - Cost cap: `state/daily-evolve-cost-baseline.json` lazy create + median × 3 초과 시 skip_reason=cost_cap_exceeded + 모든 record needs_user fallback. baseline append + last 7 trim
  - State migrator 통합 — corrupt JSON backup `.corrupt-${ISO}.bak` + fresh start
  - `digest-writer.mjs` 통합 — triageSummary inject 시 metric header (table 형식) + Codex L3 Triage Summary 박스 (fan_out / skipped / skip_reason / cost_units / cap / baseline_median) 출력. Phase 0 호환 (triageSummary 부재 시 기존 simple metric)
  - `companion.mjs handleDailyEvolve` phase 분기 — `--phase 1` 시 triage 호출 후 결과 inject. phase 0 fallback 유지
  - `tests/daily-evolve/{triage-metric,cost-cap,codex-triage}.test.mjs` — 23 신규 unit tests (lib pure + orchestrator stub + boundary fan_out=3)
  - 총 daily-evolve unit tests **118/118 pass** (Phase 0 95 + Phase 1 23). 회귀 0
- **daily-evolve-pipeline Phase 2 — Active Fork Research + L7 Codex 가중치 조정** — `plan §Phase 2`:
  - `scripts/daily-evolve/lib/fork-ranking.mjs` (pure) — 5-axis baseline score (upstream_merge_recency 0.30 / matching_plugin_paths 0.25 / unique_touched_paths 0.20 / commit_author_diversity 0.15 / non_vendor_diff_ratio 0.10) + `isActive` 정의 (pushed<30d / ahead≥5 / author_diversity≥2 / non_vendor_ratio≥0.3 / not archived) + `RENAME_MAP` effective_after 2026-05-20 (PR #8 rename) + `LICENSE_WHITELIST` (Apache-2.0 / MIT / BSD-2/3) + `applyL7Adjustment` (boost 1.3 / demote 0.7 / maintain 1.0 / insufficient_info 1.0) + `selectTopN` (score desc + stars tie-breaker, longest-prefix 매칭으로 sub-directory baseline cover 정확)
  - `scripts/daily-evolve/lib/fork-tarball.mjs` (pure) — vendor path patterns (node_modules / vendor / dist / build / .nuxt / target / __pycache__ / .venv / coverage) + vendor file patterns (*.lock / *.min.js / *.bundle.js / *-lock.json) + binary extension/size/magic heuristic + `nonVendorDiffRatio` + `normalizePosixPath` (Windows `\` → `/`)
  - `scripts/daily-evolve/fork-research.mjs` (orchestrator) — `gh api .../forks` + license filter + per-fork compare (budget guard ≤ 19 API calls/run) + active 정의 check + Top N=10 baseline score + L7 heuristic stub (boost/demote/maintain/insufficient_info, Phase 2 PoC — actual Codex pair 호출은 Phase 2.5+) + Top N=5 final (austerity mode N=3 trigger) + IMPORT-CANDIDATE record 변환
  - `companion.mjs handleDailyEvolve` phase 분기 — `--phase 2` 시 fork-research 호출 + records 를 analyzed 에 append + triage 후 digest. phase 0/1 호환 유지
  - `digest-writer.mjs` 통합 — forkSummary inject 시 "Phase 2 Active Fork Research Summary" 박스 출력 (total_forks / license_skipped / active_forks / top_candidates / l7_calls / l7_cost_units / api_calls / n_final / austerity_mode)
  - 신규 36 unit tests (fork-ranking 18 + fork-tarball 9 + fork-research 9). daily-evolve unit tests **154/154 pass** (Phase 0 95 + Phase 1 23 + Phase 2 36). 회귀 0
- **daily-evolve-pipeline Phase 3 — 7-source 완전 통합 + PII redact** — `plan §Phase 3`:
  - `scripts/daily-evolve/lib/pii-redact.mjs` (pure) — Email (RFC 5322 simplified) / GitHub PAT (ghp_/gho_/ghs_/ghu_) / OpenAI sk-* / Slack xox* / 40-hex / Windows `C:\Users\...` / POSIX `/home/...` `/Users/...` `/tmp/...` 절대경로 마스킹. `redactAll` / `containsPii` / `<email>` `<token>` `<path>` 마커 (grep 친화)
  - `source-aggregator.mjs` 4 신규 sub-source: `readMemoryFeedback` (`~/.claude/projects/.../memory/feedback_*.md` scan) / `readUnreleasedGap` (CHANGELOG `## Unreleased` 의 백틱 path/ref ↔ fork 코드 grep diff) / `readStaleTodos` (TODO/FIXME grep + git blame author-time, ≥30d stale) / `readFailureCluster` (telemetry errorMessage top 5 count)
  - `diff-analyzer.mjs` 4 신규 signal_type 분류:
    - failure cluster → `verdict=NOT-FIXED, signal_type=telemetry-ux`
    - memory feedback → `QUESTION, memory-drift`
    - unreleased gap → `PARTIAL, unreleased-gap`
    - stale TODO → `PARTIAL, todo-stale`
  - `digest-writer.mjs` — record 의 PII surface field (`preview`/`body`/`error_message`/`title`) 모두 `redactAll` 적용 후 출력. 새 record 객체 immutable (mutation 없음). hits 누적 카운트
  - `companion.mjs handleDailyEvolve` — phase > 3 차단 메시지 (Phase 0-3 only)
  - 신규 8 unit tests (pii-redact). daily-evolve unit tests **162/162 pass** (Phase 0 95 + Phase 1 23 + Phase 2 36 + Phase 3 8). 회귀 0
- **daily-evolve-pipeline Phase 4 — Action Executor + L5 협의 + dedupe + PR draft 후보** — `plan §Phase 4`:
  - `scripts/daily-evolve/lib/action-policy.mjs` (pure) — L5 heuristic stub (signal_type+verdict 기반: TODO_STALE ≥30d→pr_draft / UNRELEASED_GAP→needs_user / TELEMETRY_UX→needs_user (HIGH surface) / MEMORY_DRIFT→needs_user (HIGH) / FORK_IMPORT_CANDIDATE→needs_user / upstream FIXED→skip / 그 외→skip + low) + `isLive` 7d TTL boundary + `pruneCache` (immutable) + `buildPRBody` (verdict+signal_type+L5+dedupe+rollback schema) + L5_DECISIONS/L5_SURFACE_VALUES enum
  - `scripts/daily-evolve/action-executor.mjs` (orchestrator) — autonomous_safe filter → L5 협의 → dedupe key 확인 → PR candidate (cap 안) or surface (needs_user / skip-with-value) or skip. `state/daily-evolve-pr-cache.json` lazy create + state-migrator 통합 + corrupt JSON backup `.corrupt-${ISO}.bak`. 5 PR 동시 cap 초과 시 needs_user 로 strand
  - `codex-companion.mjs handleDailyEvolve` phase 분기 — `--phase 4` 시 actionExecute 호출 후 결과 writeDigest 에 inject. phase > 4 차단
  - `digest-writer.mjs` 통합 — actionSummary inject 시 "Phase 4 Action Executor Summary" 박스 출력 (input_total / autonomous_input / candidates / surfaced / skipped / cost_units / cache 변화) + PR draft candidates 목록 (dedupe_key prefix + title)
  - 신규 22 unit tests (action-policy 13 + action-executor 9). daily-evolve unit tests **184/184 pass** (Phase 0 95 + Phase 1 23 + Phase 2 36 + Phase 3 8 + Phase 4 22). 회귀 0
  - Phase 4 PoC = L5 heuristic stub + PR candidate 까지 (실제 `gh pr create` 는 Phase 4.5+)
- **Upstream backlog import + Tier-HIGH fixes** — a deep `/research` pass cross-checked all 118 OPEN `openai/codex-plugin-cc` issues against the fork's current code (58 already FIXED, 19 PARTIAL, 24 NOT-FIXED). The 43 unresolved items are now tracked in `docs/backlog/upstream-imported.md`, and the seven Tier-HIGH items were fixed:
  - **#338** — the SessionStart hook re-exported the generic `CLAUDE_PLUGIN_DATA` into the shared `CLAUDE_ENV_FILE`, hijacking every other plugin's per-plugin scoping. It now exports a codex-namespaced `CODEX_PLUGIN_DATA_DIR`; `resolveStateDir` / `resolveTelemetryDir` / `codex-efficiency-report` / `readTraceEvents` read `CODEX_PLUGIN_DATA_DIR ?? CLAUDE_PLUGIN_DATA`. `app-server.mjs` keeps `CLAUDE_PLUGIN_DATA` for its own children (broker + codex), which is not the shared-env leak (documented inline)
  - **#309** — the gpt-5.5 → gpt-5.4 "requires a newer version of Codex" fallback was review-only; on CLI 0.130 it also 400s `task`/`agent` runs. `runAppServerReview` keeps the shared `withModelFallback` helper; `runAppServerTurn` now retries **only `turn/start`, on the same already-created thread** — the thread is created once, so the fallback never leaves an orphan thread (a whole-function retry would re-run `thread/start`). The model-version 400 is a `turn/start`-time rejection, so the retried turn/start is the first and only real turn
  - **#41** — a reused broker app-server caches its token at startup and ignores `codex logout && codex login`. `getCodexAuthStatus` now detects the stale-auth signature on the returned status object (not only thrown exceptions), tears the broker down once under `withBrokerLockAsync`, and re-probes so a fresh login is recognized. Behavioral tests cover restart-once / no-restart-on-healthy / at-most-once / explicit-endpoint-skip
  - **#105** — GUI-launched sessions (macOS app, some IDEs) do not inherit the shell PATH, so `node` is not found and every command + hook fails. Hook commands and slash-command invocations now resolve node as `command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node` instead of a bare `node`. New TROUBLESHOOTING #16
  - **#158** — `codex-rescue` could fall back to its own non-Codex analysis when the `Bash` call was denied, falsely implying Codex ran. The agent spec now mandates an explicit one-line failure marker and forbids substituting any self-authored analysis on a failed/denied `Bash` call
  - **#232** — the `codex-rescue` subagent (Bash-only) cannot prompt, so pending Codex approvals stalled. The `/opnd-codex:rescue` command layer (which has `AskUserQuestion`) now detects the `Pending approvals:` block in the verbatim output and routes each decision through `/opnd-codex:approve` / `/opnd-codex:deny`
  - **#211** — `disable-model-invocation: true` was removed from all nine commands that carried it; they were hidden from the skill list (also blocking user-initiated invocation in some hosts). Side-effecting commands are now model-invocable — use Claude Code `permissions.deny` rules for a hard guard. README FAQ updated
- **`/analyze` recommendation hardening** — nine robustness fixes surfaced by a 4-agent (3 Claude + 1 Codex) codebase analysis:
  - `stop-review-gate-hook.mjs` `runStopReview`: the stop-review prompt embeds `last_assistant_message`, which can be arbitrarily large. It was passed as a `spawnSync` argv element, tripping the OS argv-size limit (`E2BIG` on POSIX, a silent spawn failure on Windows) so the gate skipped with no review ever running. The prompt now flows over stdin via `task --prompt-stdin` + `spawnSync({ input })` — payload size is bounded by the pipe, not `ARG_MAX`
  - `app-server-broker.mjs`: the per-socket `data` handler is `async` and yields at `await appClient.request(...)`. Node serializes listener *invocation* but not async *completion*, so a second `data` event could mutate `buffer` and broker turn-ownership state (`activeRequestSocket` / `activeStreamSocket`) mid-await. Each chunk is now chained onto the previous via a per-socket `dataChain` promise so buffer parsing and turn routing stay strictly sequential
  - `lib/codex.mjs` `captureTurn`: overlapping captures on the same client shared a single notification-handler save/restore slot, so a capture that finished before a still-active sibling clobbered the sibling's handler. Handlers are now tracked as a per-client LIFO stack (`WeakMap`); a finished capture removes itself by identity and the stack top is reinstated, correct even on out-of-order completion
  - `codex-companion.mjs` `readTaskPrompt` / `readTaskPromptSource`: switched from the sync `readStdinIfPiped` (`fs.readFileSync(0)`, documented EAGAIN-crash risk on a non-blocking inherited stdin fd) to the event-based async `readStdinAsync`; the `handleTask` / `handleContinue` call sites now `await` the prompt source
  - `lib/app-server.mjs`: `void this.handleServerRequest(message)` is fire-and-forget, but its `sendMessage()` calls can throw on an already-closed transport, escaping as an `unhandledRejection`. A `.catch()` now logs the failure to stderr instead
  - `plugin.json` version synced `2.0.0` → `2.1.0` to match `package.json`; `package-lock.json` name/version refreshed from the stale `@openai/codex-plugin-cc@1.0.4` to `@opnd-io/opnd-codex-plugin@2.1.0` after the PR #8 rename
  - `commands/setup.md`: `setup --json $ARGUMENTS` quoted to `"$ARGUMENTS"` for consistency with every other command and to prevent word-splitting; four bare `.catch(() => {})` teardown handlers given fallback-expectation comments
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
