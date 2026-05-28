# Session Handoff — codex-plugin-cc v1.0.4 → v2.0.0

**최종 update**: 2026-05-17
**브랜치 상태**: `main` @ `7f6905d` (origin/main 과 sync)
**fork**: `https://github.com/tgkim-openerd/codex-plugin-cc` (사용자 personal)

---

## 1. 완료 (다음 세션에서 다시 할 필요 없음)

### 4 release train 완료 + main merge + origin push

| Train | Branch | Commits | Status |
|---|---|---|---|
| v1.0.5 | `feat/v1.0.5-phase0-stability` | 8 | ✅ merged + pushed |
| v1.0.6 | `feat/v1.0.6-windows-auth-hardening` | 8 | ✅ merged + pushed |
| v2.0.0 | `feat/v2.0.0-sandbox-default-omit` | 7 (2 BREAKING) | ✅ merged + pushed |
| v1.2.0 | `feat/v1.2.0-features` | 4 | ✅ merged + pushed |
| release-meta | `chore/v2.0.0-release-meta` | 1 | ✅ merged + pushed |

총 **27 신규 commits + 4 v1.0.4 inherited = 31 commits** since v1.0.4 base.

### 해결된 upstream issues (30+ 항목)

§ `plugins/codex/CHANGELOG.md` v1.0.5 / v1.0.6 / v2.0.0 / v1.2.0 섹션 참조.

### 신규 contract test 13 파일 (67+ tests, all GREEN)

- `tests/teardown.test.mjs`, `tests/finalizing-timeout.test.mjs`,
  `tests/sigterm-handler.test.mjs`, `tests/pid-liveness-reaper.test.mjs`,
  `tests/hook-stdin-async.test.mjs`, `tests/broker-idle-watchdog.test.mjs`,
  `tests/broker-race.test.mjs`, `tests/worktree-detection.test.mjs`,
  `tests/profile-flag.test.mjs`, `tests/auth-bypass.test.mjs`,
  `tests/stale-auth-annotate.test.mjs`, `tests/sandbox-default-omit.test.mjs`,
  `tests/full-access-alias.test.mjs`, `tests/stop-gate-rate-limit.test.mjs`,
  `tests/review-background-wire.test.mjs`, `tests/codex-home-isolation.test.mjs`

### 환경 사전 조건 (다시 확인 필요)

- 본 repo는 `commit.gpgsign=true` global 설정 + GPG 비밀키 부재
- 모든 commit 은 `-c commit.gpgsign=false -c user.email=<user-email-redacted> -c user.name=tgkim`
- 사용자 명시 1회 승인 + 본 세션 한정 → 다음 세션에서 새로 승인 필요
- `unset CLAUDE_PLUGIN_DATA` 가 test suite 실행 전에 필요 (codex 플러그인 활성 환경의 leak)

---

## 2. 미완 (다음 세션의 후보 작업)

### Phase 4 Windows deep-investigation (3 PR, ULTRAPLAN-IMPL v2 § 0.2 - needs Claude judgment)

- **PR-4.4** `CreateProcessAsUserW failed: 1920` (#295) — Windows token escalation, 1주 timebox spike 필요
- **PR-4.6** `review --background` hang 2-30 min on Windows (#277) — bisection 5 datapoint 으로 single-version regression 아님 확인됨, root cause 미특정
- **PR-4.5** non-UTF-8 locale safe JSONL parsing (#310) — upstream codex CLI 영역 coordination 필요

### Phase 6 protocol/UX (4 PR)

- **PR-3.3** codex-rescue agent ↔ SKILL `--background` 모순 제거 (#324) — 본 세션에서 in-the-wild 재현, agent prompt 단순화 필요
- **PR-3.5** streaming partial result + `/codex:status --tail/--watch` (#264 / #237)
- **PR-3.6** codex-rescue 600s 한도 → background-with-poll mode (#122)
- **PR-6.7** MCP elicitation forwarding + tool-loop guard (#258 / #250 / #115) — protocol fixture matrix 필요

### Phase 5 token refresh runtime restart (PR-5.2 follow-up)

- 현재 PR-5.2는 stderr 에 restart 안내만. 무인 cron 운영에서는 자동 broker restart 필요.
- safe-restart 게이트: in-flight job 0인 경우만 자동 sendBrokerShutdown + 재시도.
- 위험: broker 공유 중 in-flight job 영향. 사전 design 필요.

### Phase 9 (신규) Observability / telemetry

- **PR-9.1** JSONL event log (job id, thread id, phase, error class, elapsed ms, fallback path)
- **PR-9.2** correlation ID (trace.id) 전파 — broker → codex 자식까지

### Phase 8 docs (5 PR)

- **PR-8.1** README sandbox + auth section 확장
- **PR-8.2** `docs/TROUBLESHOOTING.md` 신규 — 5 failure mode 별 진단 + workaround
- **PR-8.3** `docs/MIGRATION_v2.0.md` 확장 — first-run warning + rollback env + behavior matrix + FAQ
- **PR-8.5** agent/SKILL doc consistency audit (PR-3.3 정합성 확인)

### 기타 feature

- **PR-7.4** OS-native completion 알림 (#134) — sizing M (per Codex audit C8)
- **PR-7.7** user-level config defaults (#213)
- **PR-7.8** non-interactive mode (`claude --print`) 지원 (#223)

---

## 3. 다음 세션 시작 시 권장 시퀀스

```bash
# 1. fresh checkout
git fetch origin
git checkout main && git pull --ff-only

# 2. 작업 브랜치 (split-train 다음 train 선택)
git checkout -b feat/v2.1.0-protocol-ux  # PR-3.3 / 3.5 / 3.6 / 6.7 묶음
# or
git checkout -b feat/v2.1.0-observability  # Phase 9
# or
git checkout -b feat/v2.0.1-docs  # Phase 8 docs

# 3. 환경 prep
unset CLAUDE_PLUGIN_DATA  # 매 테스트 셸에서 필요
```

### Claude 측 인스트럭션 prefix

다음 세션 첫 메시지에 다음 컨텍스트 주입 권장:

> "이전 세션에서 codex-plugin-cc v2.0.0까지 27 PR 완료. 본 세션은
>  `docs/ultraplan/SESSION-HANDOFF.md` 와 `docs/ultraplan/2026-05-16-130611-codex-plugin-cc-implementation-ultraplan.md`
>  의 미완 항목 (§ 2) 중 [선택] 을 자율 진행. GPG 우회 + 자율 push 1회 승인."

---

## 4. 본 세션의 lessons learned (간략)

### 작동한 패턴

- **Atomic PR with contract-first TDD**: 각 PR이 contract 테스트 동반 (source-level assertion 으로 회귀 차단). 27 PR 모두 GREEN
- **Split-train release**: v1.0.5 / 1.0.6 / 2.0.0 / 1.2.0 4-train 분리로 BREAKING 격리, fast-forward merge 유지
- **Opt-out env vars for BREAKING**: 각 BREAKING change 마다 env var 으로 legacy 동작 복원 가능 (`CODEX_PLUGIN_SANDBOX_DEFAULT`, `CODEX_PLUGIN_USE_DEFAULT_HOME`)
- **First-run stderr notice**: BREAKING 알림 + opt-out 안내를 every-invocation 으로 일관 노출

### 함정

- **GPG 서명 강제 + 비밀키 부재**: 자율 commit 진행 시 1회 사용자 승인 + `-c commit.gpgsign=false` 패턴. 다음 세션도 재승인 필요
- **auto-mode classifier 의 AskUserQuestion 응답 미인지**: 사용자가 plain text 로 명시 재승인 1회 더 필요 (예: "승인할게")
- **CLAUDE_PLUGIN_DATA env leak**: 호스트 Claude Code 가 set 한 env var 가 test에 leak → state.test.mjs 첫 실행 fail. `unset` 필수
- **prior codex audit 36-46min 무한 verifying**: 본 plan 의 #122 / #183 의 in-the-wild 재현. cancel auto-mode classifier 차단됨

### 측정된 비용

- Codex pair-validation 1회 (task-mp7u9kxd-7c603j) = 13min 6s + 16 findings, 모두 5필드 검증
- Prior codex audit 1회 (task-mp7sdta9-ppf8we) = 46+ min, terminal state 미도달, 본 세션 결과에 미사용

---

## 5. 잔여 미탐색 영역 (Goal: 0 — 별도 sprint)

| 영역 | 본 세션 깊이 | 권장 |
|---|---|---|
| #117 (vague body) | L0 | reporter 에 재현 정보 요청 |
| #275 self-hosted | L1 | 별도 dogfooding |
| #229 Codex Desktop context capture | L2 (deep redesign) | 별도 spec |
| #135 git worktree isolation | L1 | 별도 spec |
| #205 /codex:test | L1 | 별도 spec |
| #215 jujutsu (jj) workspaces | L1 | jj 사용자 dogfooding |
| #263 /codex:implement/execute | L1 | 별도 spec |
| #310 zh-TW Big5 root cause | L2 (codex CLI upstream) | upstream coordination |
| #141 macOS SCDynamicStore NULL | L1 | Apple Silicon + Antigravity dogfooding |
| issue 101+ (이전 100건 cap) | L0 | `gh issue list --search …` 확장 |

---

## 6. 참고 산출물

- [docs/ultraplan/2026-05-16-125443-codex-plugin-cc-feasibility-ultraplan.md](./2026-05-16-125443-codex-plugin-cc-feasibility-ultraplan.md) — feasibility 평가
- [docs/ultraplan/2026-05-16-130611-codex-plugin-cc-implementation-ultraplan.md](./2026-05-16-130611-codex-plugin-cc-implementation-ultraplan.md) — 38 PR 구현 plan (v2 Codex audit 반영)
- [docs/ultraplan/2026-05-16-130611-codex-pair-validation-result.md](./2026-05-16-130611-codex-pair-validation-result.md) — Codex 독립 audit 결과 (16 finding × 5필드)
- [plugins/codex/CHANGELOG.md](../../plugins/codex/CHANGELOG.md) — 모든 release 의 변경 사항
- patch 백업: `docs/ultraplan/pr-0.1-broker-teardown.patch`, `docs/ultraplan/pr-1.3-finalizing-timeout-prod.patch`
