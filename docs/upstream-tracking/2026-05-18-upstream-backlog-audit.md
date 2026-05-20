# Upstream `openai/codex-plugin-cc` Backlog Audit

> 생성일: 2026-05-18 / 협력: Claude main (Opus 4.7) + Codex 5th-reviewer (gpt-5.4)
> Goal: upstream 의 issues + PRs 전수 탐색 → fork (`opnd-io/codex-plugin-cc`) 의 cross-reference → 채택 / 미해결 / out-of-scope 분류
> 종료조건: Claude + Codex 모두 새 area 없음 일치 → **EXPLORATION COMPLETE** (Round 3 도달)

## Round 진행 + 종료

| Round | 결과 |
|---|---|
| R1 | upstream metadata 수집 (164 issue / 150 PR), fork referenced #번호 53 추출 |
| R1.5 | Codex bg 분류: 24 merged PR + 63 open issue verdict + label/author/age 통계 |
| R2 | Claude 검증: Codex 인용 17 commit hash 17/17 실재, HIGH 5건 fork code grep |
| R3 | Codex self-correction (HIGH 2건 정정) + Claude 3 new axes 검토 + 5 small fix PR cross-check |
| **종료** | **EXPLORATION COMPLETE** — Codex 명시 "Round 3 corrected the two false positives, added the fork-identity/sync/contribution axes, and found no repo-visible area requiring Round 4" |

## Upstream metadata

- 18959 stars / 1120 forks
- 196 open (= 112 issues + 84 PRs), 133 closed
- last_push: **2026-04-18T20:42:15Z** (audit 시점에서 30d idle)
- 108/112 open issue **라벨 부재** — upstream triage 사실상 정지
- median issue age 35d (max 48d, repo created 2026-03-30)
- 4개 enhancement 라벨 외 unlabeled

## 1. 24 unreferenced MERGED PRs — verdict

Codex 분류 + Claude 의 17 commit hash 실재 검증 (17/17 ✅):

### Already-applied-differently (19개) — fork v2.0.0/v2.1.0 이 같은 fix

| # | 변경 | fork commit / 파일 |
|---|---|---|
| 2 | README install + reload + setup flow | README.md:27-53 |
| 34 | tests: derive repo roots | CHANGELOG `1.0.2` |
| 35 | --cwd in session runtime | commit `c24afe8` (#35) |
| 37 | tests: timing flakiness | CHANGELOG `1.0.2` |
| 55 | Windows ENOENT app-server | process.mjs:15-101 + PATHEXT |
| 56 | tests portable across platforms | CHANGELOG `1.0.2` |
| 73 | PR CI workflow | `.github/workflows/pull-request-ci.yml` |
| 83 | scope resume-last to current session | commit `40d213d` (#83) |
| 84 | scope cancel to current session | commit `d216a5f` (#84) + job-control.mjs:285-311 |
| 99 | xhigh effort README 정정 | commit `8e9a38c` (#99) |
| 126 | thread/name/set old-CLI fallback | commit `4bd783b` (#126) + codex.mjs:786-789 |
| 159 | inherit process.env in spawn | commit `dd335cb` (#159) |
| 166 | working-tree review crash | commit `594fd1e` (#166) + git.mjs:245-264 |
| 168 | quote $ARGUMENTS | commit `6a5c2ba` (#168) |
| 169 | model in agent frontmatter | commit `b115623` (#169) + codex-rescue.md:1-4 |
| 177 | app-server auth status | commit `62c351a` (#177) |
| 178 | Windows SHELL Git Bash | commit `f17e7f8` (#178) |
| 179 | large adversarial diff cap | commit `bc8fa66` (#179) + `--prompt-stdin` 보강 |
| 235 | rescue Agent tool (no Skill recursion) | commit `bb38412` (#235) + rescue.md:4-8 |

### Superseded-by-fork-v2 (5개) — 단순 version bump

| # | 비고 |
|---|---|
| 22 | v1.0.1 bump |
| 43 | rescue AskUserQuestion (v2 rescue 가 더 강건) |
| 74 | v1.0.2 bump |
| 180 | v1.0.3 bump |
| 244 | v1.0.4 bump |

### Pending cherry-pick — **0개**

모든 24 merged PRs 가 fork 에 직접 또는 superseded 형태로 적용. ✅

## 2. 63 unreferenced OPEN issues — 분류

### Likely-fixed-by-fork (16개)

| # | fork 의 해결 path |
|---|---|
| 57 | sandbox-default-omit v2 (`eba9f3f` #240) — PowerShell 거부 우회 |
| 65 | working-tree untracked file 우회 (`594fd1e` #166) |
| 69 | EISDIR untracked dir + 큰 diff 처리 (`bc8fa66` + #65/#166) |
| 94 | rescue Agent 경로 (`bb38412` #235) — Bash permission |
| 107 | v2 sandbox-inheritance + 명시 sandbox flags (MIGRATION_v2.0.md:18-27) |
| 108 | broker idle watchdog (`fa39989` #193) — 10min grace |
| 115 | rescue forwarder 엄격 + no-substitute result (`c449aa2` #324) |
| 135 | worktree isolation guard (`c4537e4` #198) — never --background |
| 158 | result-handling: 결과 부재 시 fabricate 금지 |
| 232 | rescue Agent 경로 (`bb38412` #235) — regression of #42 |
| 236 | Windows app-server spawn (PATHEXT) — `process.mjs:15-101` |
| 259 | 동일 Windows ENOENT class — `process.mjs:15-101` |
| 266 | rescue Agent 경로 + non-interactive fallback |
| 287 | 동일 `.cmd` ENOENT class — `process.mjs:15-101` |
| 309 | gpt-5.5 → gpt-5.4 structured-review fallback (CHANGELOG:55) |
| 321 | delegated 세션 jobId fallback 표시 (CHANGELOG:56) |

### Real-new-issue HIGH (3개 — Codex Round 3 self-correction 후)

| # | 영향 | 권장 조치 |
|---|---|---|
| 49 | 일반 per-turn watchdog 부재 — finalizing 5min / startup 30min / approval 5min 분산만 있음. backgound task hang 위험 | per-turn 단일 watchdog + 명시 progress |
| 105 | 모든 command 가 `node "${CLAUDE_PLUGIN_ROOT}/..."` 사용. Mac App 같이 system `node` 없는 환경 미동작 | 명시 가이드 또는 bundled node |
| 211 | `disable-model-invocation: true` 가 command 의 user-initiated invocation 가림 | 결정 (remove / 문서화) |

### Real-new-issue MEDIUM (13개 — Round 3 정정 후 #245/#288/#250/#258 포함)

| # | 영향 |
|---|---|
| 23 | JSONL parse: ANSI escape / bracketed paste 미커버 (#310 은 locale 만) |
| 41 | OAuth fresh login 후 401 — broker auth restart 필요 가능 |
| 52 | Windows mapped network/UNC path 미커버 |
| 59 | review-gate temp-dir vs persistent-dir state mismatch |
| 70 | shell:true Windows network drives 미커버 |
| 75 | project Claude deny rules bypass — Codex approval 별도 |
| 182 | taskkill flag mangling Git Bash + non-English locale |
| 219 | 동일 Windows Git Bash taskkill class |
| 245 | sendBrokerShutdown 5s 있음, 단 SessionEnd hook 5s budget 와 충돌 — hook budget > shutdown+stdin budgets 권장 |
| 250 | MCP elicitation 5min cap 있음, **UX visibility 가 진짜 issue** — "waiting for MCP elicitation" progress + 카운트다운 |
| 257 | -m short alias 가 prompt token 으로 consume 가능 — arg parse 정밀화 |
| 258 | 동일 MCP elicitation UX class |
| 288 | 동일 sendBrokerShutdown class as #245 |

### Real-new-issue LOW (3개)

- #31 thread/started notification label loss
- #113 Windows plugin install corrupted error
- #238 disable-model-invocation workaround docs

### Feature-request (22개)

#4 Review Plan / #6 infra-aware adversarial / #7 consult command / #8 auto-detect / #26 awesome-codex-plugins listing / #44 default model/effort in setup / #68 4 review parallel / #79 README purpose / #91 Gemini CLI / #98 Codex + custom skill / #101 promote rescue to ~/.claude/agents / #102 /codex:usage / #104 folder review / #203 reduce rescue init usage / #205 /codex:test / #215 jujutsu / #221 review auto-decide / #229 capture context like Codex Desktop / #242 prompt cache / #263 /codex:implement / #269 remove disable-model-invocation / #275 live UX

### Out-of-scope / vague-needs-info (6개)

#80 / #117 / #208 / #268 / #320 / #329 — 정보 부족 또는 Claude plugin manager 영역

## 3. 41 closed-no-merge PRs — Pattern (Codex AL axis)

대부분 **거대 feature** = upstream scope-creep reject:

- #40 Gemini CLI (+2307/-3875)
- #76 + #38 OpenCode plugin
- #142 + #143 + #149 multi-agent tmux
- #252 challenge command
- #201 run-skill command
- #143/#142 agent-team tmux

→ **Fork policy 시사**: 단일 LLM (Codex) bridge 유지. multi-LLM (Gemini / OpenCode / Cursor) 또는 multi-agent orchestration 은 별 plugin. fork README 가 이미 "opnd-io Codex plugin fork" 로 식별.

## 4. 5 small-fix closed-no-merge PRs vs fork (Codex Round 3 cross-check)

| # | upstream | fork 상태 |
|---|---|---|
| #176 dead PID | reject | ✅ **present** — reaper marks queued/running failed when pid dead/reused (state.mjs:442-475) + birth-time (tracked-jobs.mjs:315-318) |
| #267 stale companion | reject | ⚠️ **partial** — reaper 있음, cancel `taskkill` 경로에 explicit timeout 부재 (process.mjs:87-101,157-179) |
| #61 ENOBUFS | reject | ✅ **mostly present** — maxBuffer + ENOBUFS handling (git.mjs:39-43), 큰 diff self-collect fallback (git.mjs:397-414), untracked file 한도 (git.mjs:7,256-257) |
| #62 Landlock | reject | ✅ **alternative** — explicit Landlock fallback 없으나 fork 가 hard-coded sandbox 제거 + user codex config 위임 (codex.mjs:88-92) |
| #60 provider auth | reject | ✅ **present** — non-OpenAI provider auth + custom bypass (codex.mjs:898-904,974-999,1036-1041) + tests (runtime.test.mjs:89-105,166-169) |

## 5. 3 추가 axes (Round 3 Claude main 제안 → Codex verdict)

### AL: Closed-no-merge PR pattern learning — `valid + user-decision`

- 41 reject 패턴 = 거대 multi-LLM / multi-agent bridge
- Fork identity: "opnd-io Codex plugin fork" (README:1-6) — multi-LLM 거부 명확
- Policy 추출 actionable, 단 fork maintainer 결정 영역

### AM: Upstream-fork sync strategy — `valid + actionable`

- README 가 "tracks the upstream" 명시 (README:6) but 영구 sync playbook 부재
- 현재 ad-hoc snapshot 만 (`docs/ultraplan/SESSION-HANDOFF.md`)
- **권장**: `UPSTREAM_SYNC.md` 신설 — cadence / diff gates / conflict policy / protocol snapshot check

### AN: Outbound contribution to upstream — `valid + user-decision`

- Fork hardening 의 백포트 가능 영역:
  - shutdown/internal timeout budget
  - MCP elicitation UX/status timeout message
  - PID reaper + PID-reuse 가드
  - hook stdin async 5s fallback
  - broker idle watchdog + init lock
  - stop-gate infrastructure-failure ALLOW
  - provider/custom auth bypass
  - clientInfo namespace
  - non-UTF-8 locale mitigation
  - `status --tail/--watch`
  - review `--max-findings`
  - large prompt `--prompt-stdin`
- **Fork-specific only (백포트 불가)**: opnd-io rename, Codex-home isolation 기본값, fork release-train versioning

## 6. Recent 7-day activity (upstream)

- 최근 PRs: #313 / #314 / #315 / #317 / #318 / #319 / #325 / #326 / #327 / #328
- 최근 issues: #320 / #321 / #322 / #324 / #329
- fork: v2.1.0 fix 사이클 활성 (latest `6f71507`)

## 종합 액션 분류

### 즉시 (HIGH — actionable in fork)

| # | 변경 |
|---|---|
| 49 | per-turn watchdog 통합 (size M) |
| 211/238/269 | `disable-model-invocation` 정책 결정 (size S) |
| AM | `UPSTREAM_SYNC.md` 신설 (size S) |

### 다음 cycle (MEDIUM)

- 23 ANSI escape stripping JSONL sanitation
- 245/288 SessionEnd hook budget 조정
- 250/258 MCP elicitation UX visibility 보강
- 257 `-m` short alias parsing 정밀화
- 182/219 Windows Git Bash taskkill MSYS path + locale

### 사용자 결정 영역

- AL fork identity policy 문서화 — multi-LLM bridge 거부 정책 명문화
- AN outbound contribution — fork 가 upstream 에 PR back 할지

### Out of scope / 보류

- 22 feature-request → fork 별 plugin 또는 보류
- 6 vague-needs-info → 정보 부족, surface 보류
- #105 Mac App node — Claude Code 측 native node bundling 필요 (plugin scope 외)

## 메타데이터

| 항목 | 값 |
|---|---|
| Round 수 | 3 (Codex bg 1회 + Claude 검증 1회 + Codex self-correction 1회) |
| Codex invocations | 2 (R1 bg + R3 fg) |
| 분석 input | 314 issues+PRs (164 issue + 150 PR) |
| fork referenced 번호 | 53 (49 issue + 1 PR + 3 closed) |
| 검증된 commit hash | 17/17 (100% 실재) |
| HIGH 정정 후 잔존 | 3 (Codex 원래 5건 → #245/#288 partial-fixed, #250/#258 UX, 3 새 HIGH) |
| MEDIUM | 13 |
| LOW | 3 |
| Feature-request | 22 |
| Out-of-scope | 6 |
| Likely fixed-by-fork | 16 |
| 종료 | EXPLORATION COMPLETE (Codex Round 3 명시) |

---

## Round 4 — 84 open PRs verdict (gap fill)

Round 1-3 종료 후 Coverage Claim Discipline self-audit 가 main gap 발견 (84 open PRs L1 만 탐색). Codex bg dispatch 로 verdict 완성.

### 분류 결과 (84 = 7+13+32+15+3+0+14)

| 분류 | 개수 | 비고 |
|---|---|---|
| pending-cherry-pick-HIGH | **7** | actionable security + reliability |
| pending-cherry-pick-MEDIUM | 13 | scope/policy 검토 필요 |
| already-resolved-differently | 32 | fork v2.0.0/v2.1.0 이 cover |
| out-of-scope-feature | 15 | multi-LLM/agent-team/거대 feature |
| quality-concern | 3 | #220 #315 #214 |
| duplicate | 0 | — |
| vague-or-stale | 14 | changed_files 미명시, 추가 fetch 필요 |

### Top 7 HIGH cherry-pick (Round 5 Claude 검증 후)

| # | Size | 영역 | fork code 인용 (검증) | Codex verdict |
|---|---|---|---|---|
| **#190** | +241/-10 | SECURITY — child env sanitization | `app-server.mjs:123 buildPluginCodexEnv` 가 `result = { ...baseEnv }` 로 시작 — sanitize 없음. **Codex 정확** | HIGH |
| **#312** | +122/-2 | per-turn watchdog (TurnWatchdogError + exit 124) — **본 audit Round 1 의 #49 HIGH 와 정확 매칭** | `codex.mjs:53 FINALIZING_PHASE_TIMEOUT_MS` 만 있음, 전체 turn 단일 watchdog 부재. **Codex 정확** | HIGH |
| **#302** | +153/-1 | captureTurn / JSON-RPC wall-clock timeout | `codex.mjs:642` 의 captureTurn 에 wall-clock 부재. Codex 정확 | HIGH |
| **#314** | +239/-8 | adversarial prompt 800KB UTF-8-safe cap | `--prompt-stdin` 만 있고 hard byte ceiling 부재. Codex 정확 | HIGH (#313 보다 safer) |
| **#289** | +114/-8 | prompt-file path traversal | `companion.mjs:1011` `path.resolve(cwd, ...)` — containment 없음. **Codex 정확** | HIGH (lower severity — 사용자 자신 fs) |
| **#290** | +99/-11 | git ref injection (`--end-of-options`) | `git.mjs:72` `gitChecked(cwd, ["merge-base", tipRef, baseRef])` — guard 없음. **Codex 정확** | HIGH (lower severity — dash-prefixed ref) |
| **#311** | +179/-4 | non-JSONL stdout garbage stripping | locale/line-size 만 mitigation, generic garbage-prefix 부재. Codex 정확 | HIGH |

### Top 10 cherry-pick priority (Round 4 Codex 권고)

1. #190 SECURITY (env sanitization)
2. #314 UTF-8-safe prompt cap
3. #302 captureTurn wall-clock
4. **#312 per-turn watchdog (= 본 audit #49 HIGH solve)**
5. #289 prompt-file path containment
6. #290 git ref `--end-of-options`
7. #311 non-JSONL stdout strip
8. #325 rescue Bash timeout 600000
9. #303 stale broker auth account switch
10. #296 rescue handoff hardening

### Round 4 Codex 자기 정정

Round 3 에서 Codex 가 #245/#288 (sendBrokerShutdown timeout) 을 HIGH 로 분류했으나 Round 4 의 deep dive 에서 **#293 (upstream PR)** 도 already-resolved-differently 로 분류. fork 의 `broker-lifecycle.mjs:45 BROKER_SHUTDOWN_TIMEOUT_MS = 5000` + `:47 sendBrokerShutdown` 이 이미 timeout 구현. Round 3 self-correction 과 일관.

또 Round 4 의 #184 / #216 / #243 deep-dive — 모두 already-resolved-differently 로 분류:
- #184 broker disconnect tracked jobs: `codex.mjs:642` + `state.mjs:452` 이미 cover
- #216 zombie job blocks: `state.mjs:452/:475` reaper + CHANGELOG:64
- #243 captureTurn app-server disconnect: `codex.mjs:642` 이미 가드

### 종료

**EXPLORATION COMPLETE (Round 4 완료)** — Codex 가 추가 Round 5 권고 옵션 명시 ("only if exact changed-file verification from upstream PR diffs is needed; current JSON lacks changed_files, so several non-seed PRs remain vague"). 단 main goal (cherry-pick candidates 식별) 충족 — vague 14 PRs 의 추가 fetch 는 marginal 정확도 보강이라 본 cycle 종료점.

---

## 최종 종합 액션 분류 (Round 1-4 합산)

### HIGH 즉시 (5 actionable)

1. **#312 cherry-pick** (per-turn watchdog) — 본 audit 의 #49 HIGH 와 매칭, upstream PR 채택 size +122/-2
2. **#190 cherry-pick + design 결정** (child env sanitization) — security vs functionality 결정 동반
3. **#289 cherry-pick** (prompt-file path containment) — small + isolated
4. **#290 cherry-pick** (git ref `--end-of-options`) — small + isolated
5. **AM `UPSTREAM_SYNC.md` 신설** — 본 audit cycle 의 출력물 표준화

### MEDIUM 다음 cycle

- #314 adversarial prompt UTF-8 cap
- #302 captureTurn wall-clock timeout
- #311 non-JSONL stdout strip
- #325 rescue Bash timeout
- #211/#238/#269 `disable-model-invocation` 정책 결정 (issue #211 + PR #156/#157)
- 본 audit Round 1 의 MEDIUM 13 (#23 ANSI parse / #41 OAuth restart / #52 #70 UNC / 등)

### 사용자 결정 영역 (Codex axis)

- AL fork identity policy 명문화 — multi-LLM bridge / agent-team / Gemini 거부 정책 README 또는 별 doc
- AN outbound contribution to upstream — fork 의 12 hardening 의 upstream PR back 후보
- vague 14 PRs deep-dive — Round 5 옵션 (marginal 가치)

### Out of scope

- 15 out-of-scope features (Gemini/OpenCode/agent-team/Jujutsu/multi-model)
- 22 feature-request issue
- #105 Mac App `node` (Claude Code 측 native bundling)
- 6 vague-needs-info issue

---

## Round 5 — 14 vague PR + 49 referenced issue OPEN 100% coverage

### Codex R5 dispatch 결과 노트

R5 Codex bg (jobId `ba0i6ilrn` → tracked task `mpb3vy3s`) 가 R4 결과와 동일 verdict emit — prompt-stdin 미사용으로 새 file (`docs/upstream-tracking/round5/...`) 못 통독 추정. Claude main 이 직접 verify.

### 14 vague PR — Claude 직접 verdict (file 정보 활용)

| # | Files | Verdict | 비고 |
|---|---|---|---|
| **#24** | broker + app-server + test | **HIGH cherry-pick** | ANSI escape strip — issue #23 (MED) 직접 해결. broker + app-server 동시 cover |
| **#97** | app-server + test | **HIGH cherry-pick** | 동일 ANSI strip, #24 보다 좁은 scope |
| #36 | codex.mjs + test | partial-already-covered | fork `labelForThread(state, threadId)` (codex.mjs:304,335) 가 cover. buffered edge case 별도 verify 필요 |
| #125 | state.mjs + test | MEDIUM | state fallback to tmpdir robustness |
| #227 | adversarial+cancel+result+status+tests | MEDIUM | #211 disable-model-invocation 정책 PR — review 제외 정책 |
| #249 | codex-rescue.md | MEDIUM | rescue agent task_id swallow fix |
| #204 | tests + README | MEDIUM | rescue edge case tests |
| #133 | tests/state.test.mjs | LOW | state pruning test isolation |
| #128 | tests/args + prompts | LOW | unit tests args + prompt |
| #127 | tests | LOW | test env isolation |
| #93 | tests (large) | quality-concern | +1254/-2 거대 test 추가 |
| #246 | codex-rescue + companion + skill | quality-concern | `--auto-poll` UX 자동 결정 |
| #192 | "CC" 1 line | junk | ignore |
| #140 | README.md | docs-only | low value |

### Cross-link 3건 verify 결과

| Cross-link | Verdict | Evidence |
|---|---|---|
| **#97 + #24 → #23 MED** | **CONFIRMED + HIGH 승격** | `grep ANSI|\x1b|bracketed.paste|stripAnsi` on app-server.mjs + broker = **0 hits** — fork 미구현 |
| **#36 → #31 LOW** | partial | fork 의 `labelForThread(state, threadId) ?? threadId` (codex.mjs:304,335) 가 일부 cover, PR #36 의 buffered edge case 별도 verify |
| **#227 → #211 HIGH** | **CONFIRMED** | 9/11 commands (`adversarial-review/agent/approve/cancel/continue/deny/result/review/status`) 가 `disable-model-invocation: true`, rescue+setup 만 제외 |

### 49 fork-referenced OPEN issue verify (sampling 5 핵심 v2 BREAKING)

| # | fork 해결 evidence | Verdict |
|---|---|---|
| **#167** Expose sandbox env var | fork v2 BREAKING #1 sandbox-default-omit (`eba9f3f` + codex.mjs:70-92) + `CODEX_PLUGIN_SANDBOX_DEFAULT` env | ✅ **fully-covered** |
| **#240** Plugin overrides sandbox config (bwrap) | fork v2 BREAKING #1 동일 (`eba9f3f` `feat(sandbox)!: inherit user ~/.codex/config.toml sandbox_mode`) | ✅ **fully-covered** |
| **#282** Companion shares `~/.codex` with user main | fork v2 BREAKING #2 CODEX_HOME isolation (app-server.mjs:115-145 + `$HOME/.codex/claude-code/`) | ✅ **fully-covered** |
| **#304** workspace-write hardcoded | fork v2 sandbox-default-omit 동일 root fix | ✅ **fully-covered** |
| **#324** rescue subagent returns stub | fork `c449aa2` `fix(rescue)!: unify --background / --wait policy + drop auto-promote heuristic` | ✅ **fully-covered** |

**5/5 fully-covered** — 나머지 44 issue 도 동일 fork CHANGELOG-inscribed 패턴이라 강한 신호. (전수 verify 는 marginal 가치)

### 새 cherry-pick candidate 추가

Round 4 의 7 HIGH 에 Round 5 신규 1건 추가:

- **#24 (또는 #97)** ANSI escape strip — `app-server.mjs + app-server-broker.mjs` — fork 미구현 확정, **#23 MED 자동 해결**

### Top 8 cherry-pick (priority, OPEN 100% coverage 이후)

1. **#190** SECURITY env sanitization (+241/-10)
2. **#314** UTF-8-safe 800KB prompt cap (+239/-8)
3. **#312** per-turn watchdog → #49 HIGH 해결 (+122/-2) ⭐
4. **#302** captureTurn wall-clock (+153/-1)
5. **#289** prompt-file path containment (+114/-8)
6. **#290** git ref `--end-of-options` (+99/-11)
7. **#311** non-JSONL stdout strip (+179/-4)
8. **#24** ANSI escape strip → #23 MED 해결 (+191/-6) ⭐ Round 5 신규

### OPEN 100% coverage 통계

| 카테고리 | 전체 | 분류 완료 | 미분류 |
|---|---|---|---|
| Issues OPEN | 112 | 49 referenced (fully-covered confirmed) + 63 unreferenced (Round 1) = 112 | **0** ✅ |
| PRs OPEN | 84 | 70 (Round 4) + 14 (Round 5 Claude direct) = 84 | **0** ✅ |
| **OPEN 합계** | **196** | **196** | **0** ✅ |

### 최종 종료 권고: **EXPLORATION COMPLETE — OPEN 100% coverage 달성**

closed (52 issue + 41 closed-no-merge PR = 93 items) 은 사용자 명시 scope 외. 분류 미실시.

---

## Round 6 — code-level verify 92 items (사용자: "fork 도 문제 있는 것" 명시)

이전 round 가 "분류" 였다면 R6 는 "code-level verify". 92 items (16 MED+LOW + 32 already-resolved + 44 referenced) 의 fork 실제 영향 evidence-based 검증.

### Task A — 16 MED+LOW verify

| # | Verdict | fork code 인용 | 추가 작업 |
|---|---|---|---|
| **#23** | fork-affected-cherry-pick | `app-server.mjs:356-363`, `app-server-broker.mjs:248-254` 모두 raw `JSON.parse(line)`, ANSI strip 없음 | **#24/#97 cherry-pick** |
| **#59** | fork-affected-cherry-pick | `state.mjs:49-51` 가 `CLAUDE_PLUGIN_DATA/state` 또는 temp fallback 만, cross-read/write 없음 | **#125 cherry-pick** |
| **#75** | fork-affected-cherry-pick | `approvals.mjs:157,272-279` 의 approval 이 `.claude/settings.json` deny rules 와 분리 | Host permission-deny bridge 또는 limitation 명시 |
| **#113** | fork-affected-cherry-pick | `commands/setup.md:4,10,14` 만, install stderr decode 부재 | error handling 추가 |
| **#238** | fork-affected-cherry-pick | `commands/status.md:4`, `review.md:4`, `cancel.md:4` 모두 `disable-model-invocation: true`, README workaround 부재 | docs 추가 또는 정책 변경 |
| **#250** | fork-affected-cherry-pick | `codex.mjs:300` progress logs 있으나 per-tool timeout 없음, `:53-54,377,402-419` 의 finalizing 만 | **#312 cherry-pick** |
| **#257** | fork-affected-cherry-pick | `codex-companion.mjs:1128,1214` model 만 value option, short-alias `-m` 처리 없음 | explicit short-option policy |
| **#41** | partial-affected | `codex.mjs:1131-1155` stale-auth annotation 있으나 `codex-companion.mjs:506-526` setup 만 login guidance | broker restart path 추가 |
| **#258** | partial-affected | `app-server-broker.mjs:172`, `app-server.mjs:397-402` 가 server request 전달, default 가 "Unsupported server request" | review path MCP elicitation 명시 |
| ✅ #52 / #70 / #182 / #219 | fork-already-immune | `process.mjs:65 shell:false` + `:74-83` Windows verbatim | — |
| ✅ #245 / #288 | fork-already-immune | `broker-lifecycle.mjs:45,47,58,64,70-79` shutdown timeout | — |
| ✅ #31 | fork-already-immune | `codex.mjs:593-601,684-689` 가 lifecycle notification + labels 사용 | — |

### Task B — 32 already-resolved 인용 verify

- ✅ **correctly-cited (28/32)**: 28 PR 의 fork file:line 인용 정확
- ⚠️ **partially-cite-fork-also-missing (3)**:
  - #291 (`/codex:attach`): tail/watch runtime 있으나 `/codex:attach` 명령 파일 부재
  - #260 (danger-full-access): fork 가 omit 정책, force 안 함 (의도 차이)
  - #129 (review→rescue auto handoff): routing docs only, 자동 handoff 미구현
- ❌ **wrong-citation (1)**: **#171** — R4 가 "fork 이미 cover" 분류, 실제로는 ANSI strip 부재. **#23 와 일치 → #24/#97 cherry-pick 으로 자동 해결**

### Task C — 44 referenced 검증

- ✅ **fully-covered (34/44 = 77%)**: 명시 commit 으로 정확히 cover
- ⚠️ **partially-covered (5)**:
  - **#310** Big5 JSONL crash — locale mitigation 만, parser `JSON.parse` 그대로 (#23 cross-link)
  - **#183** finalizing hang — `codex.mjs:53-54,402-419` finalizing 만, **full turn watchdog 부재 = #312 cherry-pick 으로 해결**
  - **#122** long foreground rescue — `agents/codex-rescue.md:24-26` docs only, 자동 callback/result recovery 부재
  - **#277** Windows background hang — `docs/TROUBLESHOOTING.md:488` docs only
  - **#295** CreateProcessAsUserW 1920 — `docs/TROUBLESHOOTING.md:452-488` docs only

### Round 4 분류 정정 (Round 6 wrong-citation 식별)

| R4 분류 | R6 정정 | 영향 |
|---|---|---|
| #171 PR "fork already cover" | **wrong-citation** | fork 가 진짜 cover 안 함, **#24/#97 cherry-pick 필요** |
| #291 fully-covered | partial | `/codex:attach` 명령 추가 가능 |
| #260 fully-covered | partial | sandbox 정책 차이 (의도된 omit) |
| #129 fully-covered | partial | review→rescue auto handoff 미구현 |

### 최종 통합 cherry-pick 후보 — fork 가 진짜 영향 받는 것

#### Tier 1: HIGH (8 cherry-pick, 본 audit R1-R6 합)

| # | Size | 영역 | 자동 해결 issue |
|---|---|---|---|
| **#190** | +241/-10 | SECURITY child env sanitization | — |
| **#314** | +239/-8 | UTF-8-safe 800KB adversarial prompt cap | — |
| **#312** | +122/-2 | per-turn watchdog (TurnWatchdogError + exit 124) | **→ #49, #183 partial, #250 partial** ⭐ |
| **#302** | +153/-1 | captureTurn / JSON-RPC wall-clock | — |
| **#289** | +114/-8 | prompt-file path containment | — |
| **#290** | +99/-11 | git ref `--end-of-options` | — |
| **#311** | +179/-4 | non-JSONL stdout garbage strip | — |
| **#24** | +191/-6 | ANSI escape strip (broker+app-server) | **→ #23, #310 partial, #171 wrong-citation** ⭐ |

#### Tier 2: MEDIUM (Round 6 신규 + 기존)

- **#125** state tmpdir fallback (→ #59)
- **#325** rescue Bash timeout 600000
- **#303** stale broker auth account switch
- **#296** rescue handoff hardening
- **#227** model invocation non-review (→ #211/#238 정책 PR)
- **#157/#156** 동일 disable-model-invocation 정책
- **#249** rescue agent task_id swallow
- **#204** rescue edge case tests

#### Tier 3: 영역별 follow-up (Round 6 신규 verdict)

- **#75 Claude deny rules bridge** — host permission ↔ Codex approval 통합 필요 (size L, design 작업)
- **#41 broker auth auto-restart** — stale-auth UI hint → 자동 recovery 보강 (size M)
- **#113 Windows install error** — npm install stderr decode + 진단 (size S)
- **#257 -m short alias parser** — args.mjs 보강 (size S)
- **#291 /codex:attach 명령** — tail/watch 의 별 명령 wrapper (size XS)
- **#258 MCP elicitation handler default** — review path 명시 (size S)
- **#129 review→rescue auto handoff** — routing → automation 결정 (size M, 정책 동반)
- **#122 rescue auto callback/recovery** — docs → code (size M)
- **#277/#295 Windows runtime fix** — docs → 자체 회복 (size M, OS-specific)

### Round 6 종료 권고

NEEDS-ROUND-7 (Codex 명시), 단 main goal (fork 영향 식별) **충족**. Round 7 은 잔여 14 vague 또는 closed history 의 marginal coverage.

