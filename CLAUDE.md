# CLAUDE.md — @opnd-io/opnd-codex-plugin

본 repo 특유 규칙. global `~/.claude/CLAUDE.md` 의 모든 룰이 적용되며, 본 문서는 그 위에 추가되는 plugin-specific 가이드.

## Plugin home 격리 — auth sync 정책

v2.0+ 부터 plugin sessions 는 `$HOME/.codex/claude-code/` 격리 (Codex Desktop history feed 분리 목적). 사용자가 `codex logout && codex login` 실행하면 `~/.codex/auth.json` 만 갱신됨 → plugin 의 `~/.codex/claude-code/auth.json` 은 stale → 다음 plugin 호출 시 `Your access token could not be refreshed because your refresh token was already used` 에러로 fail.

**복구 절차** (실측 2026-05-28):

1. `cp ~/.codex/auth.json ~/.codex/claude-code/auth.json` — auth file 동기화
2. broker daemon kill — PowerShell: `Get-Process | Where-Object { $_.ProcessName -ceq 'codex' } | Stop-Process -Force` (소문자 `codex.exe` 만, 대문자 `Codex.exe` Desktop 앱은 제외)
3. `node plugins/opnd-codex/scripts/codex-companion.mjs setup --json` 으로 `ready/loggedIn/verified: true` 확인

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

`npm test` = `node --test tests/*.test.mjs tests/daily-evolve/*.test.mjs`. 신규 phase 추가 시 양쪽 glob 에 반영 자동 (glob 확장).

baseline pre-existing flake 3 case (`tests/runtime.test.mjs` 의 review/status/result 관련 — Windows fake-codex shim + temp-dir 이슈) 는 `plan-upstream-backlog.md ## 비범위` 에 등재. 신규 PR 회귀 0 기준은 본 3 case 제외.

**fixture schema parity**: 단위 test 의 fixture 가 production parser 가 받는 실제 schema 와 정합해야 함 — 본 repo 2026-05-28 의 `auth-health-check.test.mjs` 21 fixture 가 `codex.loggedIn` (잘못된 schema) 사용 → production `auth.loggedIn` 과 drift → 정상 로그인도 NOT_LOGGED_IN 으로 잘못 degrade 되던 회귀 사례.
