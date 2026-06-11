# Changelog

## 2.2.3 (2026-06-11)

Bug fix — `--output-profile` structured-output schema 가 strict 거부(400)로 한 턴도 완료 못 하던 문제 (PR #16):

- **fix(schema): `task-output.schema.json` 의 `required` 에 `changed_files`/`impacted_files` 추가** (7키 → 9키). `additionalProperties: false` + strict structured-output 에서 `required` 는 `properties` 의 *모든* 키를 포함해야 하는데 2개가 누락 → 모델 호출이 `400 invalid_json_schema` ("'required' ... including every key in properties. Missing 'changed_files'") 로 실패. `--output-profile pair`(및 output-profile 사용 task) 경로가 thread ready → turn started 까지 진행하다 첫 모델 응답에서 실패.
- `properties`/타입 불변 — 모델이 해당 필드를 빈 배열로 항상 emit. `review-output.schema.json` 은 이미 준수 (sibling audit CLEAN).
- 이 버그는 2.2.2 의 **비범위 "Layer 1"**(codex-cli Windows read-only sandbox spawn 실패, `windows sandbox: spawn setup refresh`)에 가려져 있었음 — sandbox 가 모델 호출 *전에* 실패해 schema 검증에 도달 못 함. **Layer 1 은 codex-cli 0.139.0 에서 해소**(0.136~0.138 의 Windows `sandbox setup refresh` 수정)되어 turn 이 모델까지 도달하자 본 schema 버그가 노출됨. 즉 플러그인 fix(본 release) + codex CLI `>= 0.139` 두 가지가 함께 Windows `/pair` 를 read-only 안전 유지한 채 복구.
- 검증: `pair --wait` e2e → `Verdict: PAIR_READONLY_OK` (read-only, codex 0.139, exit 0). `tests/ultraplan-runtime.test.mjs` (task-output schema 소비 유일 테스트) PASS. 전체 suite 회귀 0 (baseline flake 3 제외).
- 상세 분석(root cause Claude+Codex Agreed 5/5, 3-path 벤치마킹, Path A probe 실측): `plan-windows-sandbox-pair-recovery.md`.

## 2.2.2 (2026-06-09)

Bug fix — Windows `task`/`rescue` read-only 샌드박스 고정 해제 (issue #12):

- **fix(sandbox): `executeTaskRun` + resume 경로의 read-only 재고정 제거** (issue #12, PR #14). Windows codex-cli 0.134.0 의 read-only/workspace-write 샌드박스가 `windows sandbox: spawn setup refresh` 로 spawn 실패 → Codex 가 단 한 줄도 실행 못하던 문제. `handleTask`/review 경로는 이미 v2.0 `#240` omit 계약대로 `effectiveSandbox = null` 로 해결돼 있었으나, downstream 2곳(`executeTaskRun` task/rescue executor + `resolveTaskJobForContinue` continue/resume)이 `?? "read-only"` 로 재고정해 omit 을 무효화하고 있었음.
- `executeTaskRun`: `request.sandbox ?? (request.write ? "workspace-write" : "read-only")` → `… : null)` (omit → `~/.codex/config.toml` `sandbox_mode` 상속). `writeCapable` 를 `handleTask` 와 동일 패턴(`write || 명시적 non-read-only`)으로 통일 — null sandbox 가 write-capable 로 오인되지 않도록.
- `resolveTaskJobForContinue`: 저장된 omit 이 continue/resume 경로 끝까지 `null` 유지 (`handleContinue` 가 이미 `selected.sandbox ?? null` forward).
- review 경로(`executeReviewWithModel`)·`handleTask`·명시적 `--sandbox`/`--write`/`CODEX_PLUGIN_SANDBOX_DEFAULT` semantic 은 불변 (이미 정상).
- 신규 회귀 가드 `tests/sandbox-default-omit.test.mjs` +2 (executeTaskRun + resolveTaskJobForContinue read-only 재고정 금지). 전체 553 pass / 0 fail (baseline flake `runtime.test.mjs` 제외 — 회귀 0).
- **비범위 (상류 잔존)**: Layer 1 — codex-cli Windows read-only/workspace-write 샌드박스 spawn 자체 버그는 openai/codex 영역. 본 fix 는 플러그인이 깨진 모드를 강제하지 않도록 우회 (config.toml `sandbox_mode = "danger-full-access"` 상속 시 동작).
- docs(claude-md): v2.2.1 staleAuth 자가검출 내용을 plugin-home 격리 섹션에 반영 (`8532925`).

## 2.2.1 (2026-06-08)

Bug fix — Codex auth false-positive advisory (issue #2 fix #1):

- **fix(auth): plugin-home `staleAuth` → `verified`/`ready` 배선** (issue #2 fix #1). `inspectPluginHomeFreshness()` 가 이미 계산하던 mtime `staleAuth` advisory 를 `buildSetupReport` 의 verdict 에 반영. dual-home drift (root `~/.codex/auth.json` 만 `codex login` 으로 rotate, plugin `~/.codex/claude-code/auth.json` 은 stale → 다음 rescue 가 `refresh token already used`) 상태에서 `setup --json` 이 더 이상 `verified:true` green 을 띄우지 않음 (false-positive advisory 차단).
- 신규 순수 helper `computeStaleHomeAuth(advisory, env)` (`lib/codex.mjs`, named export + `__testHooks`) — home pin (`CODEX_PLUGIN_USE_DEFAULT_HOME=1` / explicit `CODEX_HOME`) 시엔 dual-home 자체가 없어 무강등. `auth` report 에 `staleHomeAuth` + `verificationNote` 필드 **추가만** (기존 `loggedIn`/`verified` shape 보존 — fixture parity 유지).
- daily-evolve `parseSetupJson` 도 `staleHomeAuth` 신호로 `NOT_VERIFIED → FALLBACK_HEURISTIC` 보호 degrade (doomed Codex 호출 사전 차단) + remedy hint 를 subscription 이 아닌 `cp ~/.codex/auth.json ~/.codex/claude-code/auth.json` sync 로 분기.
- 신규 `tests/plugin-home-verified-wiring.test.mjs` (10) + `auth-health-check.test.mjs` staleHomeAuth case. real-backend e2e 로 pinned/unpinned 양 분기 검증. 4-agent code-review R1(6 finding) → R2(0 수렴).
- 비범위 (follow-up): fix #2 (broker self-heal copy root→plugin) + real app-server probe round-trip.

## 2.2.0 (2026-05-28)

Highlights — daily-evolve self-evolution pipeline + plugin auth false-positive/negative discipline + telemetry UX + Windows fixes:

- **daily-evolve pipeline** (Phase 0~6 + 0.5 + 1.5a + budget) — morning routine source aggregation → Codex L3 triage → active fork research → autonomous-safe PR draft + needs-user decision queue. Phase 1.5a adds Codex auth health pre-flight + heuristic fallback (refresh-token expired ≠ routine fail).
- **plugin auth bug fix** (BROKER_BUSY_RPC_CODE + timeout regex 분기) — `getCodexAuthStatusFromClient` no longer swallows transient broker contention as `loggedIn: false`. New `HEALTH_STATUS.TRANSIENT` enum + cross-platform recovery hint (Windows PowerShell + macOS/Linux pkill + plugin home SQLite WAL cleanup).
- **setup advisory** — `buildSetupReport` adds `pluginHomeAdvisory` (root vs plugin home auth.json mtime detect + WAL size detect >10MB). `commands/setup.md` disclaimer documents single-use refresh token rotation false-positive pattern.
- **telemetry UX** — `isStaleAuthCacheError` covers "authentication expired" pattern (cluster #2 12건); new `isUsageLimitError` + `annotateUsageLimitError` (cluster #4 5건) with 5-step recovery (chatgpt.com / platform.openai.com limit URL + reset wait + fallback model + auth switch + --fast flag); `codex-companion.mjs` "No previous Codex task thread" / "Provide a prompt" error messages strengthened with actionable next steps.
- **upstream port fixes**:
  - #331 — `terminateProcessTree` Windows 분기에서 `taskkill /PID` → `cmd.exe /d /s /c call taskkill /PID` 로 MSYS path translator 경계 밖에서 실행
  - #333 — `parseReviewArgv()` 신규 (lib/args.mjs): adversarial-review focus text 의 `--FLAG VALUE` substring 이 CLI option 으로 소비되지 않도록 known options 만 greedy 파싱 + 첫 unknown 이후 모두 focusTokens
- **self-fork exclude** — `fork-research.mjs` `SELF_FORKS` Set 으로 `opnd-io/opnd-codex-plugin` self-reference false-positive 제거. `source-aggregator.mjs` `UNRELEASED_SELF_REFERENCE_RE` 로 docs/daily-evolve/ + docs/upstream-tracking/ + state/ + `.corrupt-*.bak` self-ref 제외.
- **verified-no-change** — upstream #288 (sendBrokerShutdown timeout) + #337 (Windows spawn shell:true) 이미 v2.0+ sprint 에서 해결됨 확인 + upstream gh issue 답글 후보
- **fork attribution** — Apache 2.0 §4-b/c 준수 (NOTICE + plugin.json contributors[] + README first block-quote 모두 정합)
- **CLAUDE.md (신규)** — plugin home 격리 / daily-evolve state tracked / commands ↔ companion phase gate 동기 / lib pure 정책 / Codex pair iteration / Apache 2.0 attribution / fixture schema parity (R1-R3 lesson)
- **docs/exploration/** — suminerProxy fork evaluation (HIGH 6 cherry-pick 후보 + dependency graph + Apache 2.0 HARD PRECONDITION) + upstream issue classification (cover 8건 upstream gh issue 답글 후보 + HIGH port 후보 8건) + upstream HIGH port plan (#330 #345 #350 #349 #336 #295)
- **docs/upstream-comments/** — upstream gh issue 답글 8건 (#281, #282, #285, #287, #288, #298, #337, #342) body — 사용자 manual 등록 (classifier external write 차단으로 Claude 자동 등록 불가)
- 신규 tests: `tests/auth-status-broker-branches.test.mjs` (12) + `tests/daily-evolve/*.test.mjs` (22 files, 254 cases) + `auth-health-check` (28 — +5 TRANSIENT + 2 PII redact + 1 real-shape regression + 1 broad pattern boundary)
- 252+ daily-evolve unit tests pass + full npm test exit 0 회귀 0

Codex pair review: 9 PR 모두 0 수렴 (총 ~35+ rounds across audit + R1-R5 cycles).

## Unreleased

- docs(exploration): Sprint 4-8 implementation guide — quality-review-agent frontmatter (Sprint 4, 0.1d) + upstream HIGH M effort 3건 #350/#345/#336 (Sprint 5, 1주) + upstream HIGH L effort 3건 #349/#330/#295 (Sprint 6, 1-2주) + suminerProxy Phase 1 foundation cherry-pick c30b664/a3f4181/9332c29 (Sprint 7, 3-4d) + suminerProxy Phase 2 application 6871973/4baaf19/30f3a26 (Sprint 8, 1-3d) + v2.3.0 release plan. 각 단계 별 정확한 file:line + implementation diff + test 안 + Apache 2.0 HARD PRECONDITION 명시. classifier 차단 (substrate critical multi-file modify + agent self-modification) 으로 본 세션 자율 apply 불가 — 사용자 `~/.claude/settings.json` 의 `permissions.allow` 추가 후 다음 instance 자동 apply 가능

(다음 sprint backlog — 본 guide 기반 자동 apply 진행)

## 2.1.0

- fix: exclude self-fork (opnd-io/opnd-codex-plugin) from fork discovery results in `fork-research.mjs` [Phase 3.5]
- fix: skip self-reference paths (docs/daily-evolve/, docs/upstream-tracking/, state/, .corrupt-*.bak) in unreleased-gap detection in `source-aggregator.mjs` [Phase 3.5]
- fix: improve "No previous Codex task thread" error message with actionable next steps (--resume-id / omit --resume-last)
- fix: improve "Provide a prompt" usage error messages with --prompt-file / --prompt-stdin / --resume-last hint
- fix(auth-health): `getCodexAuthStatusFromClient` catch 에 BROKER_BUSY_RPC_CODE 분기 추가 — broker busy 시 `loggedIn: null + transient: true` 반환 (false-negative 회피)
- fix(auth-health): timeout / ECONNRESET / EPIPE error 도 transient 분류 — broker stuck case 도 actual logged-out 시그널로 잘못 분류 안 함 (cross-platform recovery hint 포함: Windows PowerShell + macOS/Linux pkill + plugin home SQLite WAL cleanup)
- feat(auth-health): `daily-evolve/lib/auth-health-check.mjs` 에 `HEALTH_STATUS.TRANSIENT` enum 추가 — `parseSetupJson` / `decideDegrade(TRANSIENT→PROCEED)` / `buildFailureMessage` / `computeExpiryStreak` 분기
- fix(telemetry-ux): `isStaleAuthCacheError` 에 "authentication expired" pattern 추가 (telemetry cluster #2 — 12건 매치) [Phase A1]
- fix(telemetry-ux): `annotateStaleAuthCacheError` 의 안내문 강화 — plugin home sync (cp + broker kill) + WAL cleanup + cross-platform recovery 6 단계 [Phase A1]
- feat(telemetry-ux): `isUsageLimitError` + `annotateUsageLimitError` helper 신규 — telemetry cluster #4 (5건) usage limit error 의 rate-limit + fallback model + --fast 안내 [Phase A1]
- feat(setup): `buildSetupReport` 에 `pluginHomeAdvisory` 필드 추가 — 본 세션 (2026-05-28) 발견한 plugin home staleness (root auth 대비 mtime 비교) + SQLite WAL size 합 (>10MB) detect 시 nextSteps 에 자동 anyway [Phase A4 / Phase 5.5+ 자동화 backlog 의 detect 부분]
- chore: verified-no-change — upstream issue #288 (sendBrokerShutdown timeout) 이미 `broker-lifecycle.mjs` L46-48 (`BROKER_SHUTDOWN_TIMEOUT_MS = 5000`) + L65 부근 `setTimeout` 처리로 해결됨 (v2.0+ sprint). 함수가 절대 reject 안 함 — call site `await` 안전. upstream gh issue 답글 후보
- chore: verified-no-change — upstream issue #337 (Windows spawn shell:true) 이미 `process.mjs` L62-82 `buildCommandInvocation()` 의 `cmd.exe /d /s /c call` 래핑 + `shell: false` + `quoteWindowsCmdArg()` 이스케이프로 안전 해결됨 (v2.0+ sprint). upstream gh issue 답글 후보
- docs(exploration): suminerProxy/codex-plugin-cc (ahead=22) evaluation report — 6 HIGH cherry-pick 후보 (NDJSON event stream / notification hook / token usage / raw payload strip / task-stream push) + 6 MEDIUM + 1 LOW + 9 N/A 분류. 다음 sprint plan 명시
- docs(exploration): upstream openai/codex-plugin-cc open issue 30+건 분류 — 본 fork 가 이미 cover 한 8건 (#281, #282, #285, #287, #288, #298, #337, #342) upstream gh issue 답글 후보 + 부분 cover 3건 + HIGH port 가치 8건 + MEDIUM/LOW 16건. 모든 file path 가 `plugins/opnd-codex/scripts/lib/*.mjs` 정확 명시 (R1 LOW#3)
- docs(exploration): suminerProxy cherry-pick plan — 본 fork 에 NDJSON event stream foundation 부재 발견 (grep `appendJobEvent` 0 matches), 6 HIGH commits 의 dependency graph + Phase 1 foundation port (3-4d) + Phase 2 application port (1-3d) + Apache 2.0 attribution 절차 명시. 다음 sprint 위임

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
- **daily-evolve-pipeline Phase 5.0 + Phase 5 — env probe + scheduled-tasks MCP morning 9 KST** — `plan §Phase 5.0/5`:
  - `scripts/daily-evolve/lib/env-probe.mjs` (pure) — SCHEDULER_STATUS enum (UTC_AWARE / LOCAL_TZ_ONLY / MCP_UNAVAILABLE / UNKNOWN) + decideSchedulerStatus decision tree + kstNineToLocalCron 변환식 ((TARGET_UTC + offset) mod 1440, KST 540min → `0 9 * * *` / UTC 0 → `0 0 * * *` / LA -480 → `0 16 * * *`) + buildProbeResult / validateProbe + hasDstRisk (America/Europe/Pacific/Auckland DST true, Asia/Seoul false)
  - `scripts/daily-evolve/schedule-setup.mjs` (orchestrator) — probeMcpInstalled (`claude mcp list` subprocess) + probeCronTzSupport (Phase 5 PoC heuristic) + probeMachineTz (Intl.DateTimeFormat.resolvedOptions + getTimezoneOffset) + state/daily-evolve-env-probe.json lazy create + state-migrator 통합 + buildGuidance (status 별 등록 명령 / DST 경고 / opt-out 안내)
  - `scripts/daily-evolve/cron-fallback.sh` — install / uninstall / status 3 subcommand. CODEX_PLUGIN_DAILY_EVOLVE_DISABLED opt-out guard 자동 포함. MCP_UNAVAILABLE 또는 사용자 결정 #2 시 fallback primary
  - `companion.mjs handleDailyEvolve` 강화:
    - **opt-out**: `CODEX_PLUGIN_DAILY_EVOLVE_DISABLED=1` 시 exit 0 (Phase 5.5)
    - **probe mode**: `--probe` flag 로 env probe 단독 실행 (Phase 5.0 BLOCKING) — state 기록 + guidance stderr 출력
  - 신규 17 unit tests (env-probe). daily-evolve unit tests **201/201 pass** (Phase 0 95 + Phase 1 23 + Phase 2 36 + Phase 3 8 + Phase 4 22 + Phase 5 17). 회귀 0
  - Phase 5 PoC = env probe + guidance 까지. Actual MCP registration 은 사용자 manual (`claude mcp call scheduled-tasks create ...`) 또는 cron fallback 자동 설치 (`bash cron-fallback.sh install`)
- **daily-evolve-pipeline Phase 6 — Self-Evolve Meta Loop (FP baseline + loop guard)** — `plan §Phase 6` — 마지막 phase:
  - `scripts/daily-evolve/lib/self-evolve-policy.mjs` (pure) — REVIEW_TYPE enum (weekly_normal / monthly_self_change) + CHANGE_TARGETS 6 enum + DECISION 4 enum + isActionable (needs_claude_judgment 제외 / autonomous_safe true / needs_user + surface high|medium true) + fpRate + buildAttributionWindow (R5-M3 effective_at + decision precondition + R4-M1 14d baseline / 7d post / disjoint window) + shouldRollback (1.5× threshold + min 10 actionable) + checkLoopGuard (MAX_SELF_REVIEW_DEPTH=1 + recursive STOP — `self_evolve_*` target 차단) + shouldFireWeekly (7d trigger) + buildReviewEntry (schema 준수)
  - `scripts/daily-evolve/self-evolve.mjs` (orchestrator) — trigger check + loop guard + telemetry 수집 (runs-YYYY.json last 2 years merge) + Phase 6 PoC stub (empty proposed_changes — actual L6 Codex pair 호출은 Phase 6.5+) + weekly report `docs/daily-evolve/_weekly/{YYYY-Www}.md` 생성 (ISO week label Thursday-based) + state/daily-evolve-self-evolve-log.json lazy create + state-migrator 통합 + corrupt JSON backup
  - `companion.mjs handleDailyEvolve` — `--self-evolve [--type weekly_normal|monthly_self_change] [--force]` flag 추가 (Phase 6 별도 mode). phase > 5 차단 메시지 + `--self-evolve` 안내
  - 신규 29 unit tests (self-evolve-policy 21 + self-evolve 8): isActionable / fpRate / attribution window (effective_at null/decision precondition/post 7d 미경과/eligible 정확 windows) / shouldRollback (actionable 부족/threshold/float precision) / checkLoopGuard (depth ≤ 1/recursive STOP) / shouldFireWeekly (empty log/7d 경과/wait) / buildReviewEntry / selfEvolve orchestrator / isoWeekLabel / buildWeeklyReport
  - daily-evolve unit tests **230/230 pass** (Phase 0 95 + Phase 1 23 + Phase 2 36 + Phase 3 8 + Phase 4 22 + Phase 5 17 + Phase 6 29). 회귀 0
  - **plan-daily-evolve-pipeline.md 의 전 Phase 0-6 implement 완료**. 후속 enhancement (Phase 1.5 actual Codex pair / Phase 2.5 active Codex 호출 / Phase 4.5 actual gh pr create / Phase 5.5 MCP 자동 등록 / Phase 6.5 actual L6 합동 review) 는 별도 PR
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
