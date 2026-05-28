# suminerProxy cherry-pick plan — 2026-05-28

> Sprint 3 진행 중 발견: 본 fork 에 `appendJobEvent` / `resolveJobEventsFile` / `events.ndjson` foundation 없음 (grep 결과 0). suminerProxy 의 가장 작은 HIGH cherry-pick 후보 (6871973 CODEX_EVENTS_RAW=0) 도 foundation 의존 → 단독 port 불가능.
>
> 본 doc = NDJSON event stream foundation port plan + 각 후속 cherry-pick 의 dependency 순서 명시.

## suminerProxy HIGH 6건 dependency 그래프

```
c30b664 feat(state): per-job NDJSON event stream API
   └── lib/state.mjs  appendJobEvent / resolveJobEventsFile / readJobEvents
   └── tests/state.test.mjs  10 unit tests

a3f4181 feat(codex): notification stream hook + normalize + surface usage
   └── (의존: c30b664)
   └── lib/codex.mjs  normalizeNotification, on-notification hook

9332c29 feat(companion): per-job event stream + stall watchdog + events cmd
   └── (의존: c30b664 + a3f4181)
   └── codex-companion.mjs  events 서브커맨드, stall watchdog
   └── lib/tracked-jobs.mjs

4baaf19 feat(events): accumulate token usage from notifications + surface in /codex:status
   └── (의존: c30b664 + a3f4181 + 9332c29)
   └── codex-companion.mjs status 표시
   └── lib/render.mjs  token usage line

6871973 feat(events): CODEX_EVENTS_RAW=0 env var to strip raw payloads
   └── (의존: c30b664)
   └── lib/state.mjs  appendJobEvent 의 env-gated raw strip

30f3a26 feat(stream): task-stream push mode + /codex:stream slash command (1.2.0)
   └── (의존: c30b664 + a3f4181 + 9332c29)
   └── codex-companion.mjs stream 서브커맨드
   └── commands/stream.md  (신규)
   └── lib/tracked-jobs.mjs push notifier
```

→ **foundation 의존 sequence**: c30b664 → a3f4181 → 9332c29 → (4baaf19 / 6871973 / 30f3a26 병렬)

본 fork 의 state.mjs / codex.mjs / companion.mjs 와 base 다름 (suminerProxy 는 upstream 1.0.4 fork 기반, 본 fork 는 v2.0+ + Phase 0~6 daily-evolve 추가) — direct cherry-pick conflict 큼. **manual port + adaptation** 필요.

## Port plan (다음 sprint, 1주+ 추정)

### Phase 1 — Foundation port (3-4일)

| 단계 | scope | 추정 |
|---|---|---|
| 1a | c30b664 — `lib/state.mjs` 의 `resolveJobEventsFile` + `appendJobEvent` + `readJobEvents` port | 1d |
| 1b | (1a) test port (10 unit tests, makeTempDir 패턴 본 fork 와 정합) | 0.5d |
| 1c | a3f4181 — `lib/codex.mjs` 의 `normalizeNotification` + on-notification hook port (본 fork 의 turn watchdog / TurnWatchdogError 와 정합 검토) | 1d |
| 1d | 9332c29 — `codex-companion.mjs` 의 `events` 서브커맨드 + stall watchdog + `lib/tracked-jobs.mjs` 통합 | 1.5d |

### Phase 2 — Application port (1-3일, foundation 완료 후)

| Phase | commit | scope | 추정 |
|---|---|---|---|
| 2a | 6871973 | `lib/state.mjs` 의 `appendJobEvent` 에 `CODEX_EVENTS_RAW=0` env-gated raw strip + 2 test | 0.5d (foundation 후 trivial) |
| 2b | 4baaf19 | token usage 누적 + `/opnd-codex:status` 표시 (본 fork 의 `pluginHomeAdvisory` 같은 advisory 패턴과 정합) | 1d |
| 2c | 30f3a26 | task-stream push mode + `/opnd-codex:stream` slash command (UX 결정 큼 — `task --background --await` 같은 본 fork 패턴과 비교) | 2-3d |

## Apache 2.0 attribution

cherry-pick 시 다음 모두 처리:

- **NOTICE**: `Cherry-picked from suminerProxy/codex-plugin-cc commits c30b664, a3f4181, 9332c29, 6871973, 4baaf19, 30f3a26 (Apache 2.0)` 추가
- **각 commit message**: `Cherry-picked from suminerProxy/codex-plugin-cc#{sha}` 명시
- **`plugins/opnd-codex/.claude-plugin/plugin.json`** `contributors[]`: suminerProxy 추가 (이미 OpenAI + opnd-io 있음)

**HARD PRECONDITION (cherry-pick 시작 전 BLOCKING)**:

- [ ] suminerProxy fork license **실측 확인** (`gh api repos/suminerProxy/codex-plugin-cc --jq .license` 또는 LICENSE file 직접 확인). Apache 2.0 정합 시만 cherry-pick 진행. **MIT / GPL / 등 다른 license 면 cherry-pick 불가** (license 호환성 위반).
- [ ] 각 commit 의 sign-off / DCO 확인 (있다면 보존)
- [ ] suminerProxy 작성자 (madanapallikalyan 또는 다른 contributor) GitHub identity 명시

## Sprint 3 boundary 정합

본 doc = plan 만. actual cherry-pick 은 다음 sprint:

- **Phase 1 (foundation)**: 1주+ — 별 sprint 가치
- **Phase 2 (application)**: foundation 완료 후 — 별 sprint 또는 같은 sprint 묶음
- **30f3a26 (UX 결정)**: 가장 별 sprint (push mode 사용자 결정 큼)

## 다음 actor (사용자 결정)

1. **suminerProxy fork license 확인** (gh api 로 직접) — Apache 2.0 정합 시 cherry-pick 진행 가능
2. **NOTICE + plugin.json attribution 사전 commit** — cherry-pick 전 명시
3. **Phase 1 1d (c30b664 port) 시작** — 가장 작은 단위 + foundation 확보

## 관련 문서

- 본 fork 의 suminerProxy 평가: [`docs/exploration/2026-05-28-suminerProxy-fork-evaluation.md`](2026-05-28-suminerProxy-fork-evaluation.md)
- 본 fork 의 upstream issue 분류: [`docs/exploration/2026-05-28-upstream-issue-classification.md`](2026-05-28-upstream-issue-classification.md)
- 본 fork 의 upstream HIGH port plan: [`docs/exploration/2026-05-28-upstream-high-port-plan.md`](2026-05-28-upstream-high-port-plan.md)
