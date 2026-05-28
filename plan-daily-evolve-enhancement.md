# Plan: daily-evolve-pipeline Phase X.5 Enhancement

> 날짜: 2026-05-28
> 상태: 계획 중 — Phase 0.5 완료 (Phase 0~6 baseline 의 noise/metric/scope fix). Phase 1.5+ 후속 enhancement plan
> 입력: plan-daily-evolve-pipeline.md (baseline) + 2026-05-28 dry-run 결과 분석 + 사용자 평가

## 목표

baseline plan (Phase 0~6) 의 PoC heuristic + scope 한계를 Production-grade 으로 강화. 각 Phase 의 `.5` enhancement 는 actual Codex 호출 + 자동화 강화 + noise 추가 제거.

## 정의 제약

**baseline 의 `사용자 ≤30분 morning triage` 제약 유지. Codex 호출 비용 증가가 cost cap 안 머무름.** enhancement 가 cognitive load 늘리면 별도 plan 분리.

## Phase 0.5 — Baseline 안정화 (완료)

✅ ledger `decision_count` propagation (이전 `{0,0,0}` hard-code fix)
✅ `cost_units_consumed` 누적 (L3 + L7 + L5 합산)
✅ memory scope 본 plugin project 만 (60 noise → 0)
✅ `exceeds_actions_budget` alert (manual_actions > 60 시 ⚠ surface)

## Phase 1.5 — Actual Codex L3 pair 호출

- `codex-triage.mjs` 가 heuristic stub 대신 `/opnd-codex:pair --wait --output-profile decision-triage --task-key daily-evolve-{date}` subprocess 호출
- response JSON parse → 3분류 (autonomous_safe / needs_user / needs_claude_judgment) 매핑
- L5/L7 contract fallback (invalid JSON → fail-closed needs_user, Codex unavailable → heuristic fallback)
- task-key 로 session continuity (plugin task-session registry — 같은 date task 의 Codex session 재사용)

### 변경 파일
- `scripts/daily-evolve/codex-triage.mjs` — subprocess + response parse + fallback
- `scripts/daily-evolve/lib/codex-pair-call.mjs` (신규 helper)
- `tests/daily-evolve/fixtures/llm/decision-triage-*.json` (실제 Codex response sample)

## Phase 2.5 — Actual Codex L7 + tarball deep diff

- `fork-research.mjs` 의 `heuristicL7` 대신 actual Codex pair 호출 (per fork × 1 short turn)
- `lib/fork-tarball.mjs` 의 helper 로 actual tarball download + unzip + local static scan
- API budget 19 → 30 상향 (단, austerity trigger 도 같이 강화)
- fork ranking 의 commit message NLP (Codex 가 commit message 의 의도 분석)

### 변경 파일
- `scripts/daily-evolve/fork-research.mjs` — actual L7 호출 + tarball download orchestrator
- `scripts/daily-evolve/lib/fork-tarball.mjs` — download 함수 추가 (gh api tarball stream)
- `tests/daily-evolve/fork-tarball-stream.test.mjs` — integration test

## Phase 3.5 — Source 정밀도 강화

- **memory scope** — Phase 0.5 의 본 project 우선 + plugin keyword fallback 외, 추가 휴리스틱:
  - feedback file 의 last-modified < 30d 만 surface (stale memory 제외)
  - memory entry 가 plugin 동작과 conflict 여부 LLM 분석
- **unreleased-gap self-reference exclude**:
  - `docs/daily-evolve/*` `docs/upstream-tracking/*` `state/*` 패턴은 grep scan 제외
  - 본 routine 의 output path 가 false positive 일으키지 않게
- **TODO-stale 정확도**:
  - git blame author-time 외 commit message 분석 (Codex 가 "TODO 의 의도" 가 still valid 인지)
  - rename 추적 (`git log --follow`)

### 변경 파일
- `scripts/daily-evolve/source-aggregator.mjs` — readMemoryFeedback / readUnreleasedGap / readStaleTodos 강화
- `scripts/daily-evolve/lib/source-filter.mjs` (신규 — self-reference exclude rules)

## Phase 4.5 — Actual `gh pr create --draft` 자동 생성

- `action-executor.mjs` 의 PR candidate 가 dry-run 만 → actual `gh pr create --draft --base main --head daily-evolve/auto-{dedupe_key[0:12]}` 실행
- 5 PR 동시 cap 강제 (이미 cap 안에서만 후보)
- PR body schema 의 rollback 가이드 + Phase 6 self-evolve trigger 안내
- dry-run flag (`--dry-run`) — actual PR 생성 X, candidate 만 surface (현재 동작 유지)

### 변경 파일
- `scripts/daily-evolve/action-executor.mjs` — gh pr create 호출 + branch 생성 + body 전달
- `scripts/daily-evolve/lib/pr-creator.mjs` (신규 — gh CLI wrapper + retry)

## Phase 5.5 — Scheduled-tasks MCP 자동 등록 + DST 매월 reprobe

- `schedule-setup.mjs` 가 guidance 출력 대신 actual `claude mcp call scheduled-tasks create ...` 자동 호출
- DST risk TZ 인 경우 매월 1회 자동 reprobe (cron `0 0 1 * *` 추가 task) → DST 전환 시 cron 자동 update
- routine 등록 시 prompt 의 self-contained 강화 (task file 의 SKILL.md 갱신)
- `--reprobe` flag — env probe 만 재실행 후 cron expression 비교 → 변경 시 update

### 변경 파일
- `scripts/daily-evolve/schedule-setup.mjs` — actual MCP API call + DST reprobe task 등록
- `scripts/daily-evolve/lib/dst-reprobe.mjs` (신규)

## Phase 6.5 — Actual L6 Codex + Claude main 합동 review

- `self-evolve.mjs` 의 PoC stub 대신:
  1. Claude main 이 routine telemetry 분석 → heuristic 조정 draft 작성
  2. Codex pair 가 plan-review profile 로 critique
  3. Claude main 이 patch proposal
  4. PR draft 생성 (autonomous_safe 밖, 항상 사용자 review)
- FP baseline rollback 자동 trigger 구현 (R3-H1):
  - 적용 PR effective_at + 7d 경과 시 attribution window 계산
  - baseline_fp × 1.5 초과 시 rollback PR draft 자동 생성
- 매월 1회 monthly_self_change review 별도 trigger (Phase 6 자체 변경 — 사용자 explicit approval)

### 변경 파일
- `scripts/daily-evolve/self-evolve.mjs` — L6 호출 + rollback 자동
- `scripts/daily-evolve/lib/rollback-detector.mjs` (신규)

## 우선순위

| Phase | 우선 | 이유 |
|---|---|---|
| 0.5 | ✅ 완료 | baseline noise/scope 즉시 해결, 30분 budget 보호 |
| 3.5 | HIGH | source 정밀도 (false positive ↓) — 사용자 cognitive load 직접 감소 |
| 1.5 | HIGH | L3 actual Codex → triage 정확도 ↑ |
| 4.5 | MEDIUM | actual PR 자동 생성 — 사용자 confirm 후 진입 |
| 5.5 | MEDIUM | MCP 자동 등록 — DST TZ 사용자만 critical |
| 2.5 | LOW | fork research 추가 정밀 — 현재 1 active 결과 충분 |
| 6.5 | LOW | self-evolve 실 동작 — 7일+ 운영 후 의미 |

## 트레이드오프

| 선택지 | 장점 | 단점 |
|---|---|---|
| Phase 별 분리 PR | review 용이, blast radius 작음 | PR overhead |
| 우선순위 high 만 (0.5+3.5+1.5) 묶음 PR | 빠른 baseline 보강 | 단일 큰 PR, review 부담 |
| Phase 6.5 의 actual L6 호출 자동 | 진정한 self-improving | Codex cost 매주 누적 |

## 검증 기준

- Phase 0.5 통과 후 5 day 운영: false positive rate < 30% (사용자 manual 평가)
- Phase 1.5 진입 시: Codex L3 호출 cost_units median × 3 이내
- Phase 3.5 진입 시: memory_drift + unreleased_gap 합 ≤ 5/day
- Phase 4.5 진입 시: actual PR 5/week 이내 + auto-merge X 회귀 0

## 비범위

- baseline plan (Phase 0~6) 의 architecture 재설계
- 신규 source 추가 (현재 7-source 로 충분)
- 새 LLM provider 통합 (Codex + Claude 2 LLM 만)
- multi-user mode

## Annotation Cycle

본 enhancement plan 은 짧은 outline. 각 Phase X.5 진입 시 별도 detailed plan 작성 (plan-daily-evolve-phase-N.5.md). 사용자 우선순위 결정 후 진행.
