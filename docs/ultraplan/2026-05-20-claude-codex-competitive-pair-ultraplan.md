# UltraPlan — codex-plugin-cc 기반 Claude×Codex 경쟁 페어프로그래밍 운영 모델

> 작성: 2026-05-20 / 방식: Codex multi-round competitive pair (R1 blind 양측 → R2 Claude adversarial → R3 Codex defense, 7/7 attack ACCEPT, 2/2 divergence 수렴)
> 산출 위치: `docs/ultraplan/`

## GOAL

`codex-plugin-cc` 플러그인을 orchestration substrate 로 삼아, **Claude(예산 200, lead)** 와 **Codex(예산 100, challenger)** 가 경쟁적·상호 피드백형 페어프로그래밍을 수행하는 운영 모델을 설계·구축한다.

성공 정의 (4축):
- **G1 무낭비 예산** — 한 work-period 동안 Claude·Codex 양쪽 budget 이 모두 생산적으로 ~완전 소진. 어느 쪽도 idle(미사용) 도, bottleneck 도 아니어야 함.
- **G2 경쟁 검증** — 순차 handoff 가 아니라, 두 모델이 서로의 산출물을 adversarial 하게 공격·검증하는 round protocol.
- **G3 플러그인 최대 활용** — codex-plugin-cc 의 기존 기능(`/codex:pair`·`task-key`·`--capsule`·`--output-profile`·`/codex:rescue`·`/codex:review`·`codex-efficiency-report.mjs`·cost-tracker·telemetry·`prompts/profiles/`)을 워크플로 단계에 매핑.
- **G4 dormant 자산 편입** — `~/.claude` 툴킷의 적용가능-미사용 자산(review agents, node/tooling skills)을 risk-triggered 리뷰 레인으로 활성화.

---

## §1. 핵심 모델

- **Claude = lead + 통합 + 유일한 runtime-verification 권한자.** harness-coupled 작업(toolkit frontmatter/INDEX/hook/command), 멀티파일 edit, 최종 결정, 실제 실행·테스트.
- **Codex = challenger + 독립 분석 엔진.** adversarial 리뷰, root-cause 진단, counter-design, 코드/테스트 *초안* 작성, substrate 단정 cross-check. **Codex 는 코드를 *제안*하지만 *검증*하지 못한다** — Codex sandbox 는 `node`·테스트·CLI 실행 불가(본 세션 2회 `backend_unavailable` 실측).
- 두 모델 모두 상대의 핵심 산출물을 공격해야 하며, **합의는 검증이 아니다**(anti-collusion §4.3).

---

## §2. 예산 모델 (G1)

### 2.1 낭비의 이중 정의 (Codex R1 누락 → R2 ACCEPT)

| 유형 | 정의 | 측정 |
|---|---|---|
| **Idle-underspend waste** *(사용자 1차 관심 — "남는 토큰")* | work-period 종료 시 미사용 budget | `(200 − claude_units) + (100 − codex_units)` |
| **Low-quality-spend waste** | 소비됐으나 비생산적인 호출 | §2.4 waste 판정 |

G1 달성 = 두 유형 모두 0 에 수렴.

### 2.2 단위는 packet 이 아니라 ledger unit (R2-A2 ACCEPT)

비율 2:1 은 **ledger relative_units** 로 강제한다. packet 수 2:1 은 packet 크기가 제각각이라(코드 리뷰 packet ≠ 멀티파일 통합 packet) 단위 비율을 보장하지 못한다 — packet 수는 scheduling 힌트로만 사용.

### 2.3 work-period 정의 (R2-A7 ACCEPT)

기본 reset 주기 = **일(daily)** — codex-plugin-cc 가 이미 `cache/cost-*.json` 일별 파일을 쓴다. session/sprint rollup 은 일별 ledger 합산으로 파생. 200/100 은 1 work-period 예산.

### 2.4 Budget Ledger

workstream 마다 ledger 기록:

| 이벤트 | 필드 |
|---|---|
| Claude packet | `task_key, packet_type, relative_units, productive_outputs` |
| Codex packet | `task_key, command, output_profile, finding_count, relative_units` |
| Adjudication | `accepted_findings, rejected_findings, rejection_reason` |
| Waste flag | `kind(idle\|low-quality), reason, preventive_rule` |

**생산적 packet** = 다음 중 1+ 산출: 결정 / 근거 있는 reject / defect / 변경 파일 / 테스트 / metric 이벤트 / 문서화된 risk / 재사용 task-session.
**Codex 호출 waste** = Claude 요약 반복 / accept-reject 권고 없음 / 요청 artifact 미참조 / adjudication 불가.

### 2.5 Forced-dissent 예산 (R2-A6 ACCEPT)

anti-collusion forced-dissent(§4.3)도 Codex budget 을 쓴다. Codex 100 중 **고정 비율(예: 15u)을 dissent 예비분으로 reserve**, risk-triggered 시에만 소진. primary Codex 작업을 잠식하지 않도록.

---

## §3. 라우팅 (G1 + 거버넌스)

### 3.1 레인 (task-type → owner)

| 레인 | owner | 비율 기여 |
|---|---|---|
| `claude_lead` — 계획·분해·통합·최종결정·harness-coupled·파일 edit | Claude | Claude ~60% |
| `claude_adjudication` — Codex finding accept/reject·packaging | Claude | Claude ~15% |
| `codex_attack` — plan/design adversarial 공격 | Codex | Codex |
| `codex_rescue` — root-cause 진단 | Codex | Codex |
| `codex_review` — 구조화 코드리뷰·audit | Codex | Codex |
| `codex_draft` — 격리 코드/테스트 *초안* (Claude 가 검증) | Codex | Codex ~25% |

→ ledger unit 기준 자연 ~2:1.

### 3.2 거버넌스: Governor + Gates 둘 다 (R2-D1 수렴)

- **Gates (reactive guard)** — unit 비율 drift 가 임계 초과 시 warn/block/근거요구. 예: Claude unit 이 목표선 초과 + Codex unit 이 1/3 목표 미달 → gate 발동.
- **Governor (proactive rebalance)** — gate 위 계층. Codex spend 가 목표 lagging 시 *중간에* Codex 에 적합한 non-runtime 작업(추가 audit/리뷰 패스)을 능동 배정. Claude 가 runtime-verification 권한을 유지한 채. governor 는 **unit 기준**으로 동작.

### 3.3 Decision tree

```
모호/전략적?      → Claude draft + Codex /codex:pair plan-review 공격
격리·구현중심?    → Codex /codex:task 초안 → Claude 검증·통합
버그/root-cause?  → Codex /codex:rescue root-cause → Claude 검증
리뷰 가능?        → Codex /codex:review + risk별 toolkit agent (§7)
Codex 산출 actionable? → Claude 항목별 accept/reject  /  아니면 waste flag + 프롬프트 강화
```

---

## §4. 경쟁 라운드 프로토콜 (G2)

### 4.1 라운드

| R | 목적 | Claude | Codex | 플러그인 기능 |
|---|---|---|---|---|
| R0 intake | 과제·제약 정의 | capsule 작성 | — | `--capsule` |
| R1 blind | 독립 draft | 무간섭 작성 | blind 독립 시각 | `/codex:pair --task-key` |
| R2 attack | 가정 공격 | 방어/수정 | 공격·모순 적출 | `--output-profile plan-review` |
| R3 counter | 대안 | 대안 비교 | concrete counter-proposal | `--output-profile decision-triage` |
| R2.5 verify | **runtime 검증** | **실제 실행·테스트** | (불가 — sandbox) | — |
| R4 adjudicate | 결정 | 항목별 accept/reject/defer/escalate | — | task-session |
| R5 implement | PR 슬라이스 | 통합·검증 | 격리 슬라이스/테스트 *초안* | `/codex:task` |
| R6 review | defect 적출 | toolkit-aware 리뷰 | adversarial 리뷰 | `/codex:review` |
| R7 rescue | 실패 복구 | 증상·제약 제공 | root-cause 가설 | `/codex:rescue` |
| R8 verdict | 종료 | 최종 결정·metric | optional 최종 dissent | `/codex:continue` |

### 4.2 R2.5 — Claude 단독 runtime 검증 (R2-A5 ACCEPT)

Codex sandbox 는 `node`/테스트/CLI 실행 불가. 따라서 **모든 경험적 검증(테스트 실행, CLI 동작, 빌드)은 항상 Claude 로 라우팅**. Codex 의 코드/테스트 산출은 *초안*이며, Claude R2.5 가 ground truth.

### 4.3 Anti-collusion

합의 ≠ 검증. high-risk 결정에서 Claude·Codex 가 합의하면 **forced-dissent 1패스 의무**: `/codex:pair --task-key <slug>:dissent` + "현 합의가 틀렸다고 가정하고 가장 강한 reject 근거를 찾아라". 의무 대상: shell 실행·세션 영속 상태·budget 회계 로직·telemetry 스키마·cost 과소집계/실패 은폐 가능 기능. 예산은 §2.5 reserve 에서.

### 4.4 종료 규칙 (goal mode)

artifact 당 adversarial 루프는 다음 중 1 충족 시 종료: (a) 동일 artifact 2 연속 attack 라운드 0 new defect (b) accepted patch 1 + clean review 1 (c) 미해결 disagreement 를 명시적 tradeoff 로 기록(accepted/rejected path + watch metric + rollback trigger). 추가 hard cap: budget 90% 도달.

---

## §5. Defect-attribution 스코어보드 (R2-D2 수렴)

"who-found-what" 스코어보드를 **weighted closed-loop 라우터 입력**으로 사용 (단독 override 아님).

- 신호: Codex 가 N 라운드 연속 0 defect → Codex 리뷰 레인 과소사용/저수율 → governor rebalance.
- **가중치**: raw defect 수가 아니라 risk·severity·false-positive·R2.5 검증결과로 weight. noisy 리뷰가 보상받지 않도록.
- 출력: governor 의 rebalance 결정 + efficiency report 의 lane 수율.

---

## §6. codex-plugin-cc 기능 매핑 (G3)

| 워크플로 니즈 | 플러그인 기능 |
|---|---|
| 대형 컨텍스트 프롬프트 | `--capsule` (`.claude/cache/codex-capsules/`) |
| 멀티라운드 세션 연속성 | `--task-key` + task-session 영속 + `/codex:continue` |
| 구조화 산출(adjudication 가능) | `--output-profile` (plan-review/root-cause/decision-triage/implementation/pair-programming) |
| foreground 읽기전용 페어 피드백 | `/codex:pair` |
| 위임 진단/구현 | `/codex:rescue` `/codex:task` |
| adversarial 코드리뷰 | `/codex:review` |
| 예산·낭비 측정 | `codex-efficiency-report.mjs` + cost-tracker `cost-*.json` + telemetry |

---

## §7. Dormant 툴킷 자산 편입 (G4)

risk-class → review agent 결정적 매핑 (non-trivial PR 마다 최소 1 활성화):

| risk | toolkit agent |
|---|---|
| command parsing 변경 | `lint-review`, `type-review` |
| process 실행 변경 | `security-review`, `silent-failure-hunter` |
| 세션 영속 변경 | `architecture-review`, `test-coverage-gap` |
| cost/telemetry 변경 | `performance`, `silent-failure-hunter` |
| prompt profile 변경 | `architecture-review`, `test-coverage-gap` |
| 동작(behavior) 변경 | `test-coverage-gap` |

node/tooling ecosystem skill(~40종)은 해당 변경 유형 발생 시 contextual 로드.

---

## §8. Phasing (R2-A3/A4 ACCEPT — 7 PR, 병렬화, bootstrap)

### 8.1 Bootstrap 모드 (cold-start 해소)

PR-0~PR-2 는 ledger/router/budget 자동화를 *건설*하므로 그 자체를 자동 라우팅할 수 없다 → **수동 bootstrap 프로토콜**: 고정 ledger 템플릿 + 사람이 declare 한 unit 추정 + Claude-lead 라우팅 + 자동화 완성 후 post-hoc 재조정. 완전 경쟁 프로토콜은 PR-3 부터 발효.

### 8.2 PR 증분

| PR | 크기 | 이름 | 의존 | 목표 |
|---|---|---|---|---|
| PR-0 | XS | Feature/asset 인벤토리 | — | 실존 플러그인 기능·profile·적용가능 toolkit 자산 확정 (날조 0) |
| PR-1 | S | Routing taxonomy | PR-0 | §3.1 레인 + decision tree 문서화·룰 인코딩 |
| PR-2 | M | Budget ledger | PR-1 | §2.4 ledger 이벤트 + unit 집계 + 이중 waste 판정 |
| PR-3 | M | Round protocol skill | PR-1, PR-2 | §4 라운드 프로토콜 → toolkit skill (`codex-multi-round-substrate-pair` 확장 또는 신규) + profile 와이어링 |
| PR-4 | M | Toolkit review-lane map | PR-1 | §7 risk→agent 결정적 매핑 활성화 *(PR-3 와 병렬 가능)* |
| PR-5 | S | Efficiency report 확장 | PR-2 | `codex-efficiency-report.mjs` 에 unit 비율·idle waste·lane 수율·task-key 재사용 burn-down 추가 |
| PR-6 | M | Governor + Gates + Scoreboard | PR-2, PR-4, PR-5 | §3.2 거버넌스 + §5 weighted 스코어보드 closed loop |
| PR-7 | L | E2E 경쟁 루프 dry-run | PR-0~PR-6 | 격리된 플러그인 개선 1건에 전체 프로토콜 적용 — 비율·waste·defect 흐름 실측 검증 |

### 8.3 의존성 그래프

```
PR-0 → PR-1 → PR-2 → PR-3 ┐
              │     PR-4 ┤(PR-3 ∥ PR-4)
              └─→ PR-5 ──┴→ PR-6 → PR-7
```

PR-3 와 PR-4 는 병렬. PR-5 는 PR-2 후 즉시 가능.

---

## §9. 리스크

| 리스크 | 실패 양상 | 완화 | metric |
|---|---|---|---|
| Budget starvation | Claude 200 소진 후 통합분 부족 | governor 가 Claude 통합 buffer ~15% reserve | `claude_units ≤ 170` 작업분 |
| Idle Codex | Codex 30/100 방치 (G1 핵심 실패) | governor proactive rebalance + scoreboard 신호 | `codex_units ≥ 90` period 말 |
| Model collusion | 양측 오합의 | blind R1 + forced-dissent + R2.5 runtime 검증 | high-risk 당 `forced_dissent ≥ 1` |
| 무한 adversarial 루프 | 구현 없는 비평 사이클 | §4.4 종료규칙 (2라운드 0-defect / 90% cap) | `attack_rounds ≤ 2` |
| Codex sandbox 한계 | 코드 작성하나 검증 불가 | R2.5 Claude 단독 검증 권한 | runtime 검증 100% Claude |
| Codex unavailable | `cli_unavailable` | Claude-solo graceful degrade + skip 사유 로그 | — |
| Scoreboard gaming | noisy 리뷰가 defect 수로 보상 | risk/severity/FP/검증결과 weight | weighted score만 router 입력 |
| Bootstrap 순환 | PR-0~2 라우팅 불가 | §8.1 수동 bootstrap | — |
| 2:1 hardcode | 예산 변경 시 경직 | 비율을 config param 화 | — |

---

## §10. 성공 metric (event/count 기반 — 시간 라벨 없음)

| 축 | metric | 목표 |
|---|---|---|
| G1 | `claude_units/200`, `codex_units/100` (period 말) | 둘 다 ≥ 0.9 |
| G1 | idle-waste = 미사용 unit 합 | → 0 수렴 |
| G1 | low-quality-waste packet 수 | 감소 추세 |
| G2 | R2 adversarial 적출 defect / 전체 defect | 상승 (후속 escape 대비) |
| G2 | `forced_dissent` (high-risk 당) | ≥ 1 |
| G2 | `unadjudicated_codex_packets` | ≤ 2 상시 |
| G3 | `--task-key` 재사용 / `--capsule` / `--output-profile` 사용수 | 멀티라운드·대형컨텍스트·구조화 호출과 일치 |
| G4 | non-trivial PR 당 활성 toolkit agent | ≥ 1 |
| outcome | merge 전 적출 버그 수 / 사후 fix PR (17385e4 류) | 적출↑ / 사후fix↓ |

Pass = 비율 ~2:1 + 양측 budget ≥0.9 소진 + Codex actionable finding 1+ 가 최종 artifact 에 반영 + 모든 Codex finding adjudicate + risk별 toolkit agent 활성 + artifact 당 attack ≤2.
Fail = Codex 가 결정 확정 후에만 호출됨 / finding 미adjudicate / Claude 가 challenge 없이 budget 대부분 소진 / high-risk 합의에 dissent 누락 / idle waste 잔존.

---

## §11. Goal-mode 종료 ("미탐색 없음")

본 UltraPlan 자체가 goal-mode 산출물(R1 blind 양측 → R2 attack → R3 defense, 7/7 ACCEPT). 후속 실행에서 "미탐색 없음" 선언 조건: §4.4 종료규칙을 PR 단위로 적용 + 2 연속 라운드 0 new defect + budget 90% — 셋 중 충족 시 해당 PR 탐색 종료.

---

## 부록 — Round 진행 기록

- **R1 (blind)**: Claude·Codex 독립 draft. Codex 의 라우팅 테이블·라운드 R0-R8·risk 표가 우수, Claude 의 governor·idle-waste 정의·scoreboard-as-control 이 우수.
- **R2 (Claude attack)**: Claude 가 Codex draft 에 7 attack — A1 waste 오정의 / A2 packet vs unit / A3 phasing graph 모순 / A4 cold-start 누락 / A5 Codex runtime 불가 / A6 dissent 예산 / A7 work-period 미정의.
- **R3 (Codex defense)**: Codex 7/7 ACCEPT, D1(governor+gates 둘 다)·D2(scoreboard = weighted 입력) 수렴.
- 미해결 disagreement: 없음.
