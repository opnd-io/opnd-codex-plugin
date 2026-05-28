# suminerProxy/codex-plugin-cc fork evaluation — 2026-05-28

> Daily-evolve digest (2026-05-28) 의 fork-import-candidate 2 건 중 `suminerProxy/codex-plugin-cc` (★0 / ahead=22) 평가. self-fork (`opnd-io/opnd-codex-plugin`) 는 PR #4 의 `SELF_FORKS Set` 으로 이미 제외됨.

## 평가 방법

- `gh api repos/openai/codex-plugin-cc/compare/main...suminerProxy:codex-plugin-cc:main` 으로 22 commits 비교
- 본 fork (opnd-io) 의 main commits 와 overlap / cherry-pick 가치 분석
- HIGH 가치 (~6건) / MEDIUM 가치 (~4건) / LOW (~1건) / N/A (~11건 release + merge) 분류

## suminerProxy 22 commits 분석표

| sha | commit | category | 가치 | opnd-io overlap |
|---|---|---|---|---|
| 5e8100a | test: isolate from host-runtime plugin env vars | test | LOW | 우리 #338 (session env leak) 와 angle 다름 |
| **c30b664** | **feat(state): per-job NDJSON event stream API** | feat | **HIGH** | 신규 — daily-evolve telemetry 와 정합 |
| **a3f4181** | **feat(codex): notification stream hook + normalize + usage** | feat | **HIGH** | 신규 — Codex CLI notification 수집 |
| **9332c29** | **feat(companion): per-job event stream + stall watchdog + events cmd** | feat | **HIGH** | 신규 — broker stuck (본 세션 발견) 영역과 정합 |
| 3a0ae2d | fix(events): job/exited verdict + codex 0.131 schema gaps | fix | MEDIUM | upstream Codex CLI 0.131 schema 보정 |
| 1014d10 | feat(phase-3): compact recovery + slash commands + rescue defaults to bg | feat | MEDIUM | 우리 rescue 기본 background 와 일부 overlap |
| f9f36fb / 0e258dc / bdea774 | chore(release): 1.1.0 / 1.1.1 / 1.2.1 | release | N/A | 우리 v2.1.0 와 별도 stream |
| 8e0809f / c0a6926 / c6695d7 / f9cb141 / 4691183 / 1a4a981 | Merge PRs | merge | N/A | merge commits |
| **4baaf19** | **feat(events): accumulate token usage from notifications + surface in /codex:status** | feat | **HIGH** | 신규 — `/opnd-codex:status` 에 token usage 보강 가치 |
| 2f3a397 | test: stall watchdog stuck-phase event integration | test | MEDIUM | stuck-phase 회귀 보호 |
| **6871973** | **feat(events): CODEX_EVENTS_RAW=0 env var to strip raw payloads** | feat | **HIGH** | 신규 — PII redact 와 같은 angle (PR #3 redact 정책과 정합) |
| **30f3a26** | **feat(stream): task-stream push mode + /codex:stream slash command (1.2.0)** | feat | **HIGH** | 신규 — push-mode delivery, 우리에게 없음 |
| 45a24f0 | fix(events): normalize 3 codex 0.131 schema gap methods | fix | MEDIUM | schema 보정 |
| f701412 | fix(review): unblock completion via exitedReviewMode + bound captureTurn with a timeout (#4) | fix | MEDIUM | 우리 #41 (broker-restart) 와 영역 일부 overlap |
| d224805 | feat(review): isolate codex startup context so review stays focused on the diff (#5) | feat | MEDIUM | review 영역 |

## 가치 분포

- **HIGH (cherry-pick 강력 권고)**: 6건 — c30b664, a3f4181, 9332c29, 4baaf19, 6871973, 30f3a26
- **MEDIUM (조건부)**: 4건 — 3a0ae2d, 1014d10, 2f3a397, 45a24f0, f701412, d224805 (실제 5건 ← 표 재카운트 결과)
- **LOW**: 1건 — 5e8100a (test isolation, angle 다름)
- **N/A (release + merge)**: 11건

## HIGH 6건 cherry-pick 권고 안

### 1. NDJSON Event Stream Foundation (c30b664 + a3f4181 + 9332c29 묶음)

세 commits 가 한 sprint 로 묶음 — `feat/event-stream-foundation` PR. 본 fork 의 daily-evolve telemetry 와 정합. cherry-pick 시 다음 검토:

- 기존 `events.jsonl` 와 schema 충돌 여부
- `state/jobs/{jobId}.events.ndjson` 의 plugin home 격리 영향 (본 세션 발견 broker stuck case 와 정합)
- `stall watchdog` 이 본 fork PR #4 의 transient broker fix 와 보완 관계

권고: **별 PR (Phase B 후속) — 1주+ 작업 추정**

### 2. Token Usage Surface (4baaf19)

`/opnd-codex:status` 에 token usage 누적 + 표시. 본 fork 의 `/opnd-codex:status` 와 호환 검토 후 cherry-pick.

권고: **별 PR — 2-3일 작업 추정**

### 3. Raw Payload Strip (6871973)

`CODEX_EVENTS_RAW=0` env var. 본 fork 의 PII redact 정책 (PR #3 의 plan-issue-2-additional-repro 의 PII redact + Phase 3 source-aggregator redact) 과 같은 angle — 자연스러운 통합.

권고: **별 PR (PII 강화 후속) — 1일 작업 추정**

### 4. Task-Stream Push Mode + /codex:stream (30f3a26)

push-mode delivery 신규 + `/codex:stream` slash command. 본 fork 에 없음 — 신규 capability.

권고: **별 PR — 1주 작업 추정 (UX 결정 큼)**

## MEDIUM 5건 평가

- **3a0ae2d / 45a24f0** (Codex CLI 0.131 schema gaps): 본 fork 의 lib/codex.mjs 가 이미 일부 schema gaps 처리 — 보강 가치
- **1014d10** (rescue defaults to bg): 본 fork 가 이미 rescue 기본 background — overlap 큼, fork 의 추가 부분 (compact recovery / slash commands) 만 가치
- **2f3a397** (stuck-phase integration test): NDJSON stream cherry-pick 후 동반 test
- **f701412** (review unblock): 본 fork 의 #41 broker-restart 와 영역 overlap — 별 fix 가치 검토 필요
- **d224805** (review isolate codex startup): review focus 향상, 우리 review 영역 보강

권고: **NDJSON stream cherry-pick 시 동반 cherry-pick**

## 다음 sprint plan (사용자 결정 영역)

| 우선 | 작업 | scope |
|---|---|---|
| HIGH | NDJSON event stream 묶음 cherry-pick (c30b664 + a3f4181 + 9332c29 + 동반 MEDIUM) | 1주+ |
| HIGH | Raw payload strip (6871973) — PII 정책 자연 통합 | 1일 |
| HIGH | Token usage surface (4baaf19) | 2-3일 |
| MEDIUM | Task-stream push mode (30f3a26) — UX 결정 큼 | 1주+ |
| LOW | review unblock / isolate (f701412 + d224805) | 2-3일 |

## License + attribution

- suminerProxy/codex-plugin-cc 의 license 확인 필요 (gh api 의 license field 미확인)
- cherry-pick 시 Apache 2.0 §4-b (modification attribution) 준수 — `NOTICE` 에 suminerProxy 추가
- 각 cherry-pick 별 commit message 의 `Cherry-picked from suminerProxy/codex-plugin-cc#{sha}` 명시
