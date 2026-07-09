# CLAUDE.md — @opnd-io/opnd-codex-plugin

본 repo 특유 규칙. global `~/.claude/CLAUDE.md` 의 모든 룰이 적용되며, 본 문서는 그 위에 추가되는 plugin-specific 가이드.

## Plugin home 격리 — auth sync 정책

v2.0+ 부터 plugin sessions 는 `$HOME/.codex/claude-code/` 격리 (Codex Desktop history feed 분리 목적). 사용자가 `codex logout && codex login` 실행하면 `~/.codex/auth.json` 만 갱신됨 → plugin 의 `~/.codex/claude-code/auth.json` 은 stale → 다음 plugin 호출 시 `Your access token could not be refreshed because your refresh token was already used` 에러로 fail.

**복구 절차** (실측 2026-05-28):

1. `cp ~/.codex/auth.json ~/.codex/claude-code/auth.json` — auth file 동기화
2. broker daemon kill — PowerShell: `Get-Process | Where-Object { $_.ProcessName -ceq 'codex' } | Stop-Process -Force` (소문자 `codex.exe` 만, 대문자 `Codex.exe` Desktop 앱은 제외)
3. `node plugins/opnd-codex/scripts/codex-companion.mjs setup --json` 으로 `ready/loggedIn/verified: true` 확인

**자가검출 (v2.2.1+, issue #2 fix #1)**: `setup --json` 이 plugin-home auth.json 의 staleness(root 대비 mtime skew)를 감지하면 advisory 에 그치지 않고 `auth.verified: false` + `auth.staleHomeAuth: true` + `verificationNote` 로 **verdict 를 자동 강등**한다 (`ready` 도 false). 즉 stale 상태에서 더 이상 `verified: true` green 을 띄우지 않아 host harness 가 doomed rescue 를 시도하지 않는다. home pin(`CODEX_PLUGIN_USE_DEFAULT_HOME=1` / explicit `CODEX_HOME`) 시엔 dual-home 자체가 없어 무강등. 위 수동 복구(`cp auth.json`)는 여전히 유효하며, daily-evolve `parseSetupJson` 도 같은 신호로 `NOT_VERIFIED → FALLBACK_HEURISTIC` degrade + sync hint 를 안내. 구현: `lib/codex.mjs computeStaleHomeAuth` + `codex-companion.mjs buildSetupReport`.

**legacy shared home**: `CODEX_PLUGIN_USE_DEFAULT_HOME=1` 환경변수 설정 시 plugin 이 `~/.codex/` 공유 사용 (단점: sessions 가 Desktop history 와 섞임).

**관련 자산**: `plan-issue-setup-advisory-false-positive.md`, `plan-issue-2-additional-repro.md` — single-use refresh token rotation hypothesis 분석.

## daily-evolve state 추적 정책 (사용자 결정 #1)

`state/daily-evolve-*.json` 은 **git tracked**:

- `state/daily-evolve-runs-{YYYY}.json` — run ledger (연도별 분할, append-only, `.tmp-{pid}-{ts}` → `renameSync` atomic)
- `state/daily-evolve-cost-baseline.json` — last 7 FIFO median
- `state/daily-evolve-env-probe.json` — Phase 5+ env probe 결과
- `state/daily-evolve-self-evolve-log.json` — Phase 6 meta-review log

`state/tarball-cache/` 등 cache dir 만 gitignore. 사용자 의도: 운영 투명성 + cross-machine 일관성 우선, repo 크기보다 SoT 우선.

## commands/*.md ↔ companion phase gate 동기 갱신

`plugins/opnd-codex/commands/daily-evolve.md` 의 `description` / `argument-hint` / 본문이 `plugins/opnd-codex/scripts/codex-companion.mjs handleDailyEvolve` 의 phase 분기 (line ~2738-2768 부근) 와 **동기 유지 필수**. 새 phase / flag 추가 시 양쪽 동시 갱신.

drift 시 사용자 onboarding 막힘 — README `## What You Get` 의 command list 누락 같은 실수가 동일 패턴. 본 repo 2026-05-28 doc-sync 에서 `daily-evolve` / `rescue` / `setup` 3 command 가 README 에 누락된 사례 발견.

## lib pure 정책 (R2-L2 dep rule)

`plugins/opnd-codex/scripts/daily-evolve/lib/*.mjs` 는 `fs` / `network` (`http`/`https`/`fetch`) / `child_process` import 금지. orchestrator (`source-aggregator`, `digest-writer`, `fork-research`, `codex-triage`, `action-executor`, `self-evolve`) 만 side effect 허용.

`tests/daily-evolve/lib-dependency-rule.test.mjs` 가 source-level 가드 — 위반 시 CI fail.

## Subagent broker survival 정책 (#21, v2.2.4)

codex-rescue subagent 의 foreground `task` 는 subagent 의 kill-on-close Windows Job Object 안에서 실행되므로, app-server / broker 를 **그 컨텍스트에서 직접 spawn 하면 turn 종료 시 죽는다** (`reaper:process_died`, 결과 유실). 따라서:

- `agents/codex-rescue.md` 는 **항상 `task --require-broker`** 를 부여한다 (제거 금지). 이 플래그가 게이트: `connect` 가 live 선존 broker 만 사용하고 broker/직접 app-server 를 local-spawn 하지 않으며, 없으면 stdout(exit 0)에 진단을 surface (subagent pass-through). `--profile`/`--fast` 거부, busy/ENOENT retry-direct 억제, timeout-recovery 의 `codex exec resume` 게이트, background no-local-fallback, local codex 가용성 체크 우회.
- 살아남는 broker 의 전제는 **main-session(SILENT_BREAKAWAY_OK) 에서 spawn** 된 것. `session-lifecycle-hook.mjs` 가 SessionStart 에서 (workspace cwd 가 있을 때만, codex-on-PATH 게이트) 사전 warm-up — opt-out `CODEX_PLUGIN_EAGER_BROKER=0`. 가드는 warm 실패해도 fail-fast 라 warm 에 *의존* 하지 않음.
- 신규 코드는 plain `Error` 에 `error.code = …` 직접 대입 대신 `Object.assign(new Error(…), { code })` — checkJs(`npm run build`) 에러 추가 금지 (기존 13건은 선존 debt). 가드 회귀 테스트: `tests/subagent-broker-guard.test.mjs`.

## Codex pair iteration 정책

high-risk PR (>20 files, security/auth/PII 영역, ledger schema 변경) 만 R1-R3 0 수렴 권장. 작은 fix (typo, single function, comment) 는 single-pass 로 충분.

R1 → R2 → R3 trace 는 commit message 또는 PR body 에 agentId 명시 (예: `Codex pair R1 a838b13ee29406639 → R2 aaf4c8ef50122b1da → R3 a2a0a860aa55152c4 CONVERGED`). session_id 본체는 노출 금지 (private runtime).

## Apache 2.0 fork attribution 보존

세 항목 모두 보존 의무 (§4-b / §6 trade-name):

- `NOTICE` 의 `Modifications since 2026-05-16 © opnd-io / tgkim` 라인
- `plugins/opnd-codex/.claude-plugin/plugin.json` 의 `contributors[]` 에 upstream OpenAI 명시
- `README.md` 첫 블록쿼트의 fork 명시 + upstream link

remote 변경 / repo rename / 신규 release 시 위 셋이 정합 유지 확인 — 본 repo 2026-05-18 의 `tgkim-openerd` → `opnd-io` 이동 (commit `93cc1a2`) 이 reference.

## Test 정책

`npm test` = `node scripts/run-tests.mjs` (v2.4.0+). 셸 glob 확장에 의존하지 않도록 러너가 `tests/*.test.mjs` 와 `tests/daily-evolve/*.test.mjs` 를 직접 열거한다 — `cmd.exe` 는 glob 을 확장하지 않아 Windows 에서 조용히 깨졌다.

`npm run verify` = `npm test` + `npm run build`(checkJs). **CI 등가 게이트이므로 push 전 이것을 돌린다.** `npm test` 만으로는 checkJs 회귀를 잡지 못한다. Codex CLI 부재 시 build 단계는 명시적 `SKIPPED` 로 표기된다 (green 으로 위장하지 않음).

**러너의 env 격리** (`scripts/test-env.mjs`): 테스트 자식 프로세스는 부모 env 를 상속한다 (`helpers.run()` 은 `options.env` 가 없으면 spawnSync 에 env 를 넘기지 않는다). 따라서 러너가 (1) telemetry 를 무력화하고 — 스위트가 사용자의 실제 ledger 에 쓰고 있었다 — (2) 상속된 세션 신원(`CODEX_COMPANION_SESSION_ID` / `CODEX_COMPANION_TRANSCRIPT_PATH`)을 삭제한다. telemetry 는 명시적 값으로 opt-out 가능하지만 세션 신원은 아니다. `CODEX_PLUGIN_DATA_DIR` 는 job/state 경로도 해석하므로 의도적으로 남긴다.

> **정정 (v2.4.0)**: `tests/runtime.test.mjs` 의 review/status/result 3 case 는 "Windows fake-codex shim + temp-dir 이슈" 로 인한 baseline flake 로 등재돼 있었으나 **오귀인이었다**. 실제 원인은 결정적이다 — 상속된 `CODEX_COMPANION_SESSION_ID` 를 `filterJobsForCurrentSession` 이 읽어 sessionId 없는 fixture 를 전부 걸러냈다. CI 에는 그 변수가 없어 통과했으므로 Claude Code 세션 안에서만 실패했다. 위 env 격리로 해소됐고, 이제 **신규 PR 회귀 0 기준에 예외 없음** (제외 3 case 없음).

**fixture schema parity**: 단위 test 의 fixture 가 production parser 가 받는 실제 schema 와 정합해야 함 — 본 repo 2026-05-28 의 `auth-health-check.test.mjs` 21 fixture 가 `codex.loggedIn` (잘못된 schema) 사용 → production `auth.loggedIn` 과 drift → 정상 로그인도 NOT_LOGGED_IN 으로 잘못 degrade 되던 회귀 사례.
