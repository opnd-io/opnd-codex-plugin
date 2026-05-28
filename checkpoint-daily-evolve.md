# Checkpoint — daily-evolve-pipeline 작업 이어가기

> 생성: 2026-05-28
> 다음 세션 가이드 — 본 branch (`feat/daily-evolve-pipeline`) checkout 후 본 문서 부터 읽기

## 현재 상태 (one-line)

**plan-daily-evolve-pipeline.md 의 Phase 0~6 + 0.5 fix + budget removal + Phase 1.5a auth health check 모두 구현 완료. 다음 단계 = 사용자 명시 "Codex pair batch review → main merge" — 단 사용자 Codex CLI refresh token expired/revoked 로 차단 중.**

## 누적 commit (feat/daily-evolve-pipeline branch)

```
a6a0598 feat(daily-evolve): Phase 1.5a — Codex auth health check pre-flight + heuristic fallback
b6a3d21 fix(daily-evolve): fork research API budget 제거 (default unlimited + env override)
bfa9dd7 fix(daily-evolve): Phase 0.5 mini-fix — ledger propagation + budget + memory scope
bbf0e45 feat(daily-evolve): Phase 6 — Self-Evolve Meta Loop (마지막 phase 완료)
e5ca7c5 feat(daily-evolve): Phase 5.0+5 — env probe + scheduled-tasks MCP morning 9 KST
d21467c feat(daily-evolve): Phase 4 — Action Executor + L5 협의 + dedupe + PR draft 후보
330b42e feat(daily-evolve): Phase 3 — 7-source 완전 통합 + PII redact
fefa418 fix(daily-evolve): Codex Phase 2 R2 review MEDIUM 3건
4bc48b4 feat(daily-evolve): Phase 2 — Active Fork Research + L7 가중치 조정
1aaeb66 fix(daily-evolve): Codex Phase 1 review MEDIUM/LOW 3건
f7c443c feat(daily-evolve): Phase 1 — Codex L3 Triage 통합 (heuristic stub + cost cap)
314ad50 feat(daily-evolve): Phase 0 PoC — upstream PR/Issue + telemetry → daily digest
d51b7db chore: snapshot prior to fork relationship restore (Phase 0 직전)
```

## 검증 상태

- daily-evolve unit tests: **252/252 pass**
- 전체 npm test 회귀: 0 (3 pre-existing baseline 만 잔존, plan-upstream-backlog.md `## 비범위`)
- Codex pair plan critique R1-R7: 50 finding 100% 적용, 0 수렴
- Codex pair implement reviews (Phase 0 R1-R3 / Phase 1 R1-R2 / Phase 2 R1-R2): 모두 0 수렴
- **Phase 1.5a Codex pair batch review: 미수행 (Codex CLI 만료로 차단)**

## 차단 상황 — Codex CLI refresh token expired/revoked

사용자가 다른 session (itruck-backend ITRUCK-865) 작업 중 Codex 인증 풀린 상태가 본 session 까지 동일 영향.

본 routine 의 실 dry-run 검증 결과:
```
[daily-evolve] auth health: not_logged_in — degrade=fallback_heuristic
(Codex auth health: 인증 만료 — `codex logout && codex login` 후 다음 routine 부터 정상 복구)
```

→ Phase 1.5a 의 health check pre-flight 가 정확 작동. routine 자체는 heuristic fallback 으로 degrade — 실패 X.

## 다음 세션 — 이어가야 할 action

### Step 1. Codex 재인증 (사용자 manual — 본 routine 이 자동 수행 불가)
```bash
codex logout
codex login   # browser OAuth flow
```
완료 후 검증:
```bash
node plugins/opnd-codex/scripts/codex-companion.mjs setup --json
# ready=true, codex.loggedIn=true, codex.verified=true 확인
```

### Step 2. Phase 1.5a 의 Codex pair batch review (사용자 명시)
누적 Phase 0~6 + 0.5 + budget 은 이전 turn 들에서 batch review 0 수렴 완료. **Phase 1.5a 만 신규 review 필요**.

prompt 위치: 이 checkpoint 의 § "Codex pair Phase 1.5a review prompt" 참조 (아래 별첨).

호출 패턴:
```
Agent({
  subagent_type: "opnd-codex:codex-rescue",
  description: "Phase 1.5a auth-health-check batch review",
  prompt: "...아래 별첨..."
})
```

R1 finding 적용 → R2 0 수렴 도달 시 main 머지 진행.

### Step 3. PR #1 main 머지
- URL: https://github.com/opnd-io/opnd-codex-plugin/pull/1
- base=main, head=feat/daily-evolve-pipeline
- 머지 전략 권고: **squash merge** (13 commits → 1 commit, clean history). 단 사용자가 logical commit 보존 원하면 `--merge` (merge commit) 가능
- 명령 예시:
```bash
gh pr merge 1 --squash
# 또는 --merge (logical commit 보존)
```

## 미해결 enhancement 후보 (plan-daily-evolve-enhancement.md 참조)

| Phase | 우선 | 의의 | 진입 조건 |
|---|---|---|---|
| 3.5 | HIGH | source 정밀도 (memory <30d / unreleased self-ref exclude / TODO Codex 의도 분석) | main 머지 + 며칠 운영 후 |
| 1.5b | HIGH | actual Codex L3 호출 (heuristic stub 탈피) | 1.5a 의 health check 통과 후 |
| 4.5 | MEDIUM | actual `gh pr create --draft` 자동 생성 | 1.5b 후 |
| 5.5 | MEDIUM | MCP 자동 등록 + DST reprobe | 사용자가 DST TZ 일 때 |
| 2.5 | LOW | fork research tarball deep diff | 현재 sample size 충분 |
| 6.5 | LOW | actual L6 합동 review | 7일+ 운영 누적 후 |

## 자동 routine 상태

- **scheduled-tasks MCP 등록 완료** — `daily-evolve` task (cron `0 9 * * *` local KST, jitter ~9분)
- 다음 자동 실행: **2026-05-29 09:08:54 KST**
- task file: `C:\Users\tgkim\.claude\scheduled-tasks\daily-evolve\SKILL.md`
- 본 commit (Phase 1.5a) 머지 안 됐어도 directory source 라 다음 실행 시 자동 적용 (사용자 마지막 dry-run 의 head 가 a6a0598)
- opt-out: `CODEX_PLUGIN_DAILY_EVOLVE_DISABLED=1`

## 작업 디렉토리 + git remote

```
cwd:    D:\01.Work\01.Projects\62.codex-plugin-cc
branch: feat/daily-evolve-pipeline (HEAD: a6a0598)
remotes:
  origin   https://github.com/opnd-io/opnd-codex-plugin.git
  upstream https://github.com/openai/codex-plugin-cc.git
gh active account: TaeGyumKim (tgkim-openerd, opnd-io org admin)
```

## Personal scratch (untracked, gitignored 아님)

다음 세션이 알아야 할 untracked file 들 (이전 task 의 personal 자료):
- `plan.md` — 옛 plan
- `plan-upstream-backlog.md` — upstream 43건 백로그 plan (이전 task 완료)
- `research.md` — upstream 118 issue 분석 (이전 task)
- `checkpoint.md` — 옛 sprint (v2.1.0) checkpoint, 본 작업 무관
- `.claude/` — Claude Code per-session config

본 작업 (daily-evolve) 의 tracked plan = `plan-daily-evolve-pipeline.md` + `plan-daily-evolve-enhancement.md`.
본 작업 의 tracked checkpoint = 이 문서 (`checkpoint-daily-evolve.md`).

## Codex pair Phase 1.5a review prompt (별첨 — 다음 세션이 그대로 복붙)

```
사용자 명시 "Codex 와 페어로 진행" — plan-daily-evolve-pipeline.md +
plan-daily-evolve-enhancement.md 의 Phase 1.5a (Codex auth health check
+ heuristic fallback) implement batch review. Read-only.

## Context
- 이전 사용자 평가: 다른 session 의 Codex 인증 만료 → "본 routine 에서
  자동 회전 가능?" 질문
- 답변: refresh token rotation 은 Codex CLI 자동 처리. browser-based
  OAuth re-login 은 plugin 자동 불가. 단 routine 시작 시 health check
  pre-flight + 만료 시 heuristic fallback + digest failures 알림 가능
- Phase 1.5a 구현 + 사용자가 main 머지 권한 부여 (Codex pair review 후)
- commit: a6a0598
- branch: feat/daily-evolve-pipeline (Phase 0~6 + 0.5 + budget + 1.5a)
- daily-evolve unit tests 252/252 pass

## 검토 대상 (Phase 1.5a 신규)
1. lib/auth-health-check.mjs — pure helpers (parseSetupJson /
   decideDegrade / buildFailureMessage / computeExpiryStreak /
   shouldEscalate + HEALTH_STATUS 5 enum + DEGRADE_ACTION 3 enum)
2. companion handleDailyEvolve — health check pre-flight subprocess
   (process.execPath, timeout 10000ms) + ledger entry 의 auth_health
   field 추가 + digest 의 authHealthFailureMessage inject
3. digest-writer — failures 섹션 첫 줄 ⚠ ${msg} 출력
4. tests/daily-evolve/auth-health-check.test.mjs (21 tests)

## 검증 영역
- Plan spec ↔ implement 매핑 (Phase 1.5a 의 4 spec 정합)
- lib dep rule (R2-L2) 준수
- Boundary / Edge / Security (PII leakage / timeout / argv path 구성)
- Routine impact (subprocess +1~2s, fallback 정확)
- main 머지 직전 점검 (회귀 / squash vs merge 권고)

## 검증 5필드 필수
claim / verification_command / verification_result / verdict / confidence

## 출력 형식 (BLOCKING)
HIGH / MEDIUM / LOW / 합의 영역 + main merge 권고 1 블록
한국어 600-900단어
수렴 진단 + 머지 전략 권고
```

## 사용자 의도 (직접 발언 인용)

1. "추가하고 전부 적용해서 main에 머지해줄래? 코덱스와 페어로 진행" — 본 Phase 1.5a 머지 의도 명확
2. "budget 제한을 둬야하나? 제거해 주겠니" — fork research API budget 19 → Infinity (default), env override 가능
3. "플러그인에서 자동 회전하게 하는건 불가한가?" → Phase 1.5a 구현 동기
4. 사용자 default 7건 (LLM=a / CRON_TZ env-probe / status digest-only / Phase 6 rollback 자동 / state lazy / no Claude metric / token-normalized) — implement 시 모두 적용

## 핵심 risk / 주의

- main 머지 시 main + >3 files 변경 pre-commit hook 차단 가능 (CLAUDE.md `--no-verify reflexive 차단` 룰 ADR-017). 본 branch 는 feat/* 이므로 push 자체는 OK. 머지 시점에 hook 점검
- main 머지 후 자동 routine (scheduled-tasks) 가 directory source 라 즉시 적용됨 — sanity 검증 1회 권장
- Phase 1.5a 의 dry-run 검증은 stderr 알림 까지만 확인. 30s timeout 으로 finalize block 미실행 → ledger inflight stale 잔재. 다음 routine 실행 시 새 entry overwrite (cleanup 불필요)
- 본 task list (Task #19 in_progress) — 다음 세션이 TaskList 로 확인 가능. 단 task tool 의 state 는 session 별이라 새 session 에선 재구성 필요할 수 있음

## TaskList 현황 (본 세션 마감 시점)

```
#1~#18: completed (Phase 0~6 + 0.5 모든 단계 완료 + commit/push/PR)
#19: in_progress — Phase 1.5a 구현 완료, Codex pair batch review + main merge 미수행
```
