# ULTRAPLAN - Claude harness 안에서 Codex token efficiency 극대화

**작성일**: 2026-05-18
**대상**: `opnd-io/codex-plugin-cc` + `C:\Users\tgkim\.claude` Codex Pair substrate
**목표**: Claude Code 가 Codex 를 subagent / pair programmer / independent reviewer 로 사용할 때, 같은 결과를 더 적은 Claude 토큰과 더 적은 재읽기 비용으로 얻고, 긴 작업은 더 안정적으로 이어가게 한다.

---

## Implementation Status (2026-05-18)

| Track | Status | Implemented surface |
|---|---|---|
| PR-A command taxonomy | implemented | `/codex:pair` direct command, pair foreground read-only defaults, README/command docs/tests |
| PR-B session continuity | implemented | `--task-key`, execution/prompt fingerprint, task-session registry, reusable resume path |
| PR-C prompt capsule | implemented | `--capsule` reader restricted to `.claude/cache/codex-capsules`, secret-pattern refusal, queued prompt elision |
| PR-D result digest | implemented | stored `resultDigest`, `/codex:result --digest`, compact continue handoff |
| PR-E output profiles | implemented | task output schema, profile docs, `--output-profile` schema forwarding |
| PR-F failure taxonomy | implemented | `failureClass`, empty final-output classification, digest + telemetry extras |
| PR-G telemetry | implemented | efficiency report script + profile/failure extras in lifecycle events |
| PR-H Claude harness metadata | implemented | classifier hook schema v3 with recommended command, task-key seed, fan-out id, session fingerprint |
| PR-I docs/tests | implemented | runtime/command tests, README, runtime skill/result handling, `.claude` router/plan updates |

Verification run: `npm run build`, `node --test --test-concurrency=1 tests/runtime.test.mjs`, `node --test tests/ultraplan-runtime.test.mjs`, and all non-runtime test files passed. Full `npm test` parallel run exceeded the 15-minute command timeout on this Windows harness, so runtime was verified serially.

---

## 0. Defining Constraint

Codex plugin 은 Claude native subagent 가 아니다.

- native subagent: Claude harness 내부 `Agent(...)` lifecycle
- codex-plugin-cc: slash command 또는 Agent wrapper -> Bash -> `codex-companion.mjs` -> broker -> Codex app-server -> Codex CLI subprocess

따라서 최적화 방향은 "Codex 에 Claude hidden transcript 를 그대로 상속시킨다"가 아니라, 아래 네 지점을 명시적으로 줄이는 것이다.

1. Claude wrapper token: Codex 호출 전후에 Claude 가 쓰는 불필요한 forwarding / summary token
2. Codex prompt token: 매 호출마다 같은 파일, 같은 정책, 같은 분석 배경을 다시 보내는 비용
3. Lost-result token: background drift, status/result mismatch, timeout 으로 재호출하는 비용
4. Verification token: Codex finding 을 다시 검증하느라 Claude 가 반복 grep/read 하는 비용

---

## 1. Current Evidence

Public source checked: [opnd-io/codex-plugin-cc](https://github.com/opnd-io/codex-plugin-cc) README / CHANGELOG on 2026-05-18. Local checkout evidence below is the implementation reference.

### 1.1 codex-plugin-cc 쪽

| 상태 | 근거 |
|---|---|
| implemented | README 는 `/codex:agent`, `/codex:continue`, approval/status/result/cancel 로 long-running Codex work 를 제어한다고 문서화한다. [README.md:21](../../README.md#L21), [README.md:191](../../README.md#L191) |
| implemented | `--context`, `--prompt-file`, `--prompt-stdin` 이 있으며, inline prompt 가 약 3KB 를 넘으면 prompt-file/stdin 을 권장한다. [README.md:158](../../README.md#L158), [README.md:159](../../README.md#L159), [codex-companion.mjs:992](../../plugins/codex/scripts/codex-companion.mjs#L992) |
| implemented | `/codex:agent` 는 companion direct command 이며 `--background`, `--approval on-request`, `--write` 기본값을 붙인다. [commands/agent.md](../../plugins/codex/commands/agent.md), [codex-companion.mjs:1436](../../plugins/codex/scripts/codex-companion.mjs#L1436) |
| implemented | `/codex:continue` 는 running turn 은 `turn/steer`, completed job 은 기존 thread 에 새 turn 을 만든다. [commands/continue.md](../../plugins/codex/commands/continue.md), [codex-companion.mjs:1498](../../plugins/codex/scripts/codex-companion.mjs#L1498) |
| implemented | task prompt 는 현재 text-only `buildTurnInput(prompt)` 로 app-server 에 들어간다. [codex.mjs:127](../../plugins/codex/scripts/lib/codex.mjs#L127), [codex.mjs:1296](../../plugins/codex/scripts/lib/codex.mjs#L1296) |
| implemented | profile / fast 는 broker 공유를 끊고 direct app-server spawn 을 강제한다. [codex.mjs:735](../../plugins/codex/scripts/lib/codex.mjs#L735), [codex.mjs:747](../../plugins/codex/scripts/lib/codex.mjs#L747) |
| implemented | JSONL telemetry + trace id, `/codex:status --tail/--watch` 가 있다. [CHANGELOG.md:14](../../plugins/codex/CHANGELOG.md#L14), [CHANGELOG.md:15](../../plugins/codex/CHANGELOG.md#L15), [telemetry.mjs:131](../../plugins/codex/scripts/lib/telemetry.mjs#L131) |
| implemented | plugin-launched Codex sessions 는 `CODEX_HOME=$HOME/.codex/claude-code` 로 Desktop history 와 분리된다. [README.md:355](../../README.md#L355), [app-server.mjs:116](../../plugins/codex/scripts/lib/app-server.mjs#L116) |
| partial | `codex-rescue` agent 는 thin wrapper 지향이나, Claude Agent wrapper 를 한 번 거친다. 명시 `--background/--wait` 는 존중하고 자동 background 승격은 금지한다. [codex-rescue.md:23](../../plugins/codex/agents/codex-rescue.md#L23) |
| partial | worktree cleanup race 를 피하려고 transient worktree 안에서는 background 를 drop 한다. [codex-rescue.md:28](../../plugins/codex/agents/codex-rescue.md#L28) |

### 1.2 `.claude` 하네스 쪽

| 상태 | 근거 |
|---|---|
| implemented | `codexTaskRouting` 는 현재 true 이다. `C:\Users\tgkim\.claude\feature-flags.json` |
| implemented | 7축 fingerprint 기반 Codex session registry 가 있다. `C:\Users\tgkim\.claude\docs\solutions\codex-session-continuity.md:27`, `C:\Users\tgkim\.claude\scripts\codex-session-registry.js:100` |
| implemented | router 는 `reuse -> validate -> spawn -> skip` 상태 전이를 문서화한다. `C:\Users\tgkim\.claude\agents\_router.md:579` |
| implemented | cost cap 는 `baseline_p95 * 2`, `baseline_avg * 3`, `tokenBudget 90%` gate 로 정리되어 있다. `C:\Users\tgkim\.claude\docs\solutions\codex-default-pair-cost-cap.md:23`, `C:\Users\tgkim\.claude\skills\universal\dev\codex-cross-verification\skill.md:147` |
| partial | UserPrompt hook metadata 에 `fan_out_group_id` 와 `session_fingerprint` 필드가 있지만 현재 null placeholder 이다. `C:\Users\tgkim\.claude\scripts\codex-task-classifier-hook.js:143` |
| partial | `.claude` skill 은 background shared session drift 를 별도 anti-pattern 으로 기록한다. `C:\Users\tgkim\.claude\skills\universal\dev\codex-cross-verification\skill.md:286` |

### 1.3 External Harness Design Evidence

| 상태 | 근거 |
|---|---|
| implemented | OpenAI App Server 설계 글은 Codex harness 를 thread lifecycle/persistence, config/auth, sandboxed tool execution, skills/MCP integration 으로 구성하고, client integration 은 bidirectional JSON-RPC event stream 으로 thread/turn/item lifecycle 을 표현한다고 설명한다. [OpenAI - Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) |
| implemented | Codex app-server README 는 `turn/start` approval flow, output schema, plugin/skill/config list, thread pagination 같은 client-facing protocol surface 를 문서화한다. [openai/codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| implemented | Claude Code subagents 는 main conversation 과 별도 context window 를 쓰며, 비용/컨텍스트 관리를 위해 task-specific prompt/tool 권한을 분리한다. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) |
| implemented | Claude Code hooks 는 SessionStart/UserPromptSubmit/SubagentStart/SubagentStop/PreCompact 등 lifecycle point 에서 context injection, block/allow, telemetry 를 수행할 수 있다. [Claude Code hooks](https://code.claude.com/docs/en/hooks) |
| implemented | Claude memory 문서는 `CLAUDE.md` 가 context 로 주입되며 enforced configuration 이 아니고, concise/specific instruction 과 path-scoped rules/skills 가 adherence 와 token 효율에 중요하다고 설명한다. [Claude Code memory](https://code.claude.com/docs/en/memory) |
| implemented | SWE-agent ACI 논문은 agent 성능이 model 자체만이 아니라 repository navigation, file edit, test execution 을 위한 agent-computer interface 설계에 크게 의존한다고 보고한다. [SWE-agent ACI paper](https://arxiv.org/abs/2405.15793) |

Design implication:

- Codex 를 Claude subagent 처럼 가장하려고 하지 말고, App Server 의 thread/turn/item/approval/event model 을 plugin contract 로 드러낸다.
- Claude hooks 는 detector/advisor 로 유지하고, 자동 spawn 은 별도 explicit opt-in 없이는 금지한다.
- token 절감은 hidden transcript 공유가 아니라 capsule, task-key registry, digest, structured output, telemetry 로 만든다.
- quality 절감선은 "더 짧은 prompt"가 아니라 stale resume 방지, approval boundary 보존, verifier-friendly output 이다.

---

## 2. Target Architecture

```text
Claude main
  |
  | 1. classify task + choose mode
  v
Codex Pair Router
  |
  | 2. create bounded task capsule
  v
Prompt Capsule Store
  |
  | 3. registry lookup with 7-axis + execution fingerprint
  v
Session Registry
  |
  | 4. direct companion call when possible
  v
codex-companion.mjs
  |
  | 5. app-server turn / steer / resume
  v
Codex
  |
  | 6. structured result + digest + trace
  v
Claude fan-in
```

핵심 결정:

- command taxonomy 를 고정한다:
  - `pair`: explicit direct foreground pair/review path. 기본은 foreground + read-only safe posture.
  - `agent`: long-running approval-aware background implementation/debug path.
  - `rescue`: Claude Agent wrapper/proactive natural-language fallback path.
- explicit slash command / command file 경로는 `disable-model-invocation` direct companion call 을 우선한다.
- proactive second-opinion 또는 Claude Agent wrapper 가 실제로 필요한 경우에만 `codex:codex-rescue` 를 쓴다.
- 모든 큰 task 는 inline prompt 대신 capsule file 을 만들고 `--prompt-file`/`--capsule` 로 전달한다.
- session reuse 는 "latest job" 휴리스틱이 아니라 `task_key + execution_fingerprint + effective_prompt_hash` 로 결정한다.
- Codex 결과는 raw long output 그대로 재주입하지 않고 `result digest` 를 먼저 fan-in 한다. raw output 은 파일/로그에 남긴다.
- Claude hooks 는 advisory detector 이다. destructive/sensitive work, credential/env changes, broad deletion, business/product decision 은 Codex 가 classify/verify/propose 까지만 하고 Claude/user 가 결정한다.

### 2.1 10-Lens Review Verdict

| Lens | 판정 | Plan change |
|---|---|---|
| 1. Direct invocation / wrapper token | partial | `/codex:agent` 는 이미 direct 이므로 `pair` 효과는 rescue/Agent wrapper 경로를 explicit pair 로 옮길 때만 발생한다고 명시한다. |
| 2. Context capsule / prompt source | missing | `capsule_hash` 대신 `effective_prompt_hash` 를 도입하고, capsule 을 prompt-file alias 로만 구현하지 않는다. |
| 3. Session continuity | partial | 7축 fingerprint 에 execution contract, repoRoot, CODEX_HOME mode/hash 를 추가한다. |
| 4. Background reliability | partial | taskKey/capsuleHash/promptHash 를 status index 에 남기고 empty output 을 completed 가 아닌 failure class 로 분류한다. |
| 5. Cost / telemetry | partial | 새 dashboard 보다 `.claude/scripts/codex-telemetry.js` 와 cost-tracker substrate 를 확장한다. |
| 6. Structured output / verifier | partial | JSON-only v1 profile, existing review schema adapter, verifier block compatibility 를 요구한다. |
| 7. Safety / autonomy | partial | `pair` default 를 read-only foreground 로 바꾸고 hooks auto-spawn 은 별도 opt-in 전까지 금지한다. |
| 8. Cross-OS runtime | partial | Windows Git Bash cross-drive, PowerShell, POSIX socket/signal, CODEX_HOME isolation 을 validation matrix 에 넣는다. |
| 9. Testability / rollout | partial | feature flag/default-off table, backward compatibility tests, docs migration gate 를 추가한다. |
| 10. Claude UX / product fit | partial | `pair/agent/rescue` taxonomy 와 `.claude` router/plan/hook 문서 업데이트를 PR-A/PR-E acceptance 로 승격한다. |

Overall verdict:

- High-quality Claude 결과는 가능하다.
- 단, PR-A 단독으로는 충분하지 않다. 품질 향상은 PR-A + PR-B + PR-C + PR-D + PR-E/F gate 가 같이 들어갈 때 나온다.
- 현재 계획에서 가장 위험한 축은 token saving 을 이유로 user decision boundary 를 흐리는 것, stale resume 을 허용하는 것, digest/capsule 이 raw evidence 를 숨기는 것이다.

---

## 3. Plan By PR

### PR-A. Direct Pair Command

**상태**: missing
**Size**: M
**목표**: 명시적 Codex pair/review 호출에서 Claude Agent wrapper 를 제거하되, 기존 `/codex:agent` 와 `/codex:rescue` 역할을 흐리지 않는다.

변경:

- `plugins/codex/commands/pair.md` 신규.
- `disable-model-invocation: true`, `allowed-tools: Bash(node:*)`.
- Windows Git Bash cross-drive 안전을 위해 command body 는 `node "${CLAUDE_PLUGIN_ROOT}/scripts/..."` 직접 경로가 아니라 `cd "${CLAUDE_PLUGIN_ROOT}" && node scripts/codex-companion.mjs pair "$ARGUMENTS"` 형태를 사용한다.
- `/codex:pair` 기본값은 foreground + read-only safe posture:
  - default: `--wait --sandbox read-only`
  - write-capable 또는 long-running implementation 은 router 가 `/codex:agent` 를 추천한다.
  - `--background` 는 명시 opt-in 일 때만 허용한다.
- `--read-only` 는 companion 에서 `--sandbox read-only` 로 normalize 한다. unknown flag 가 positional prompt 로 흘러가지 않도록 parser/test 를 추가한다.
- `--task-key` 는 PR-A 에서 구현하지 않고 PR-C 의 registry option 으로 이동한다.
- `/codex:rescue` 는 유지하되 문서상 "Claude Agent wrapper/proactive fallback path" 로 한정한다.
- `.claude/commands/plan.md`, `.claude/agents/_router.md`, `.claude/scripts/codex-task-classifier-hook.js`, `codex-task-router-agent.md` 에 command taxonomy 를 반영한다:
  - `pair`: direct foreground pair/review
  - `agent`: approval-aware background implementation/debug
  - `rescue`: Agent-wrapper fallback/proactive delegation

Acceptance:

- explicit `/codex:pair ...` 실행 시 Claude Agent wrapper 가 호출되지 않는다.
- stdout 은 companion output 그대로.
- `/codex:pair` default 는 foreground/read-only 이고, `/codex:pair --background` 만 tracked background job 을 만든다.
- existing `/codex:agent` 는 direct/background/write-capable contract 를 유지한다.
- existing `/codex:rescue` 는 Agent-wrapper/foreground-by-default contract 를 유지한다.
- `tests/commands.test.mjs` 에 `pair.md` direct command, `agent.md` unchanged, `rescue.md` wrapper 유지, `continue.md`/`result.md` deterministic entrypoint assertion 을 추가한다.
- Windows cross-drive fixture 는 generated command file 에 `node "${CLAUDE_PLUGIN_ROOT}/...` absolute mixed path 가 없는지 검증한다.

Token effect:

- `/codex:agent` 대비 token delta 는 없다. 이미 direct command 이기 때문이다.
- `/codex:rescue` 또는 `Agent({ subagent_type: "codex:codex-rescue" })` 에서 explicit `/codex:pair` 로 옮긴 호출만 Claude subagent inference 1회를 제거한다.
- Codex 결과 fan-in 전 Claude commentary 금지로 wrapper token 감소.

### PR-B. Task Capsule Protocol

**상태**: missing
**Size**: L
**목표**: Codex 에 "최대 컨텍스트"를 주되, raw transcript dump 대신 재사용 가능한 bounded prompt artifact 로 전달한다.

신규 capsule schema:

```markdown
# Codex Task Capsule

---
schema_version:
task_key:
workspace_root_hash:
repo_root:
cwd:
command:
mode:
profile_id:
profile_version:
profile_hash:
sandbox:
approval:
context_hash:
resume_delta_hash:
capsule_body_hash:
effective_prompt_hash:
---

## Goal
## Success Contract
## Current Facts
## Scope
## Evidence Index
## Files To Read First
## Constraints
## Existing Attempts
## Expected Output
## Budget Hints
## Resume Delta
```

변경:

- `.claude/scripts/codex-task-capsule.js` 신규 또는 plugin-neutral package 로 분리.
- 출력 위치: `.claude/cache/codex-capsules/<repo>/<task-key>.md`.
- `repoSlug` 와 `taskKeySlug` 는 `[A-Za-z0-9._-]` 로 sanitize 한다. drive letter, colon, backslash, traversal, symlink escape 는 reject 한다.
- capsule 은 UTF-8 로 저장하고 path 는 capsule root 아래 containment 를 강제한다.
- capsule 생성 시 raw file 내용은 기본 포함하지 않고 path + why + first-read order 를 넣는다.
- 긴 source excerpt 는 `source-command-brief` 산출물 또는 별도 `evidence/*.md` 로 분리하고 capsule 은 index 만 가진다.
- companion 에 `--capsule <path>` 를 추가하되 순수 `--prompt-file` alias 로 구현하지 않는다.
  - job request 에는 `{ promptSource: "capsule", capsulePath, capsuleHash, effectivePromptHash }` 를 저장한다.
  - background job file 에 full capsule text/request.prompt 를 그대로 저장하지 않는다.
  - task worker 가 실행 직전에 capsule 을 load/verify 한다.
- `--capsule` 은 `--prompt-file`, `--prompt-stdin`, positional prompt 와 mutually exclusive 이다. 추가 지시는 별도 `--append-instruction` 로 받고 `effective_prompt_hash` 에 포함한다.
- inline prompt 가 threshold 를 넘으면 agent wrapper 가 temp file 을 직접 쓰는 대신 capsule 생성 경로를 권장한다.
- `.claude` adapter 는 `Codex Pair Metadata` 를 파싱해 `task_key`, `fan_out_group_id`, `capsule_path`, `capsule_hash`, `effective_prompt_hash` 를 companion 옵션으로 넘긴다.
- Markdown scrubber 는 JSON key scrubber 와 별도로 둔다.
  - deny: `.env*`, `auth.json`, cookies, bearer headers, API keys, session/thread IDs, SSH/private keys, SOPS/age material
  - unnecessary absolute home path 는 redact
  - secret detection 시 `capsule_failed_secret_detected` 로 fail closed
- capsule TTL/cleanup 정책을 둔다. 기본은 repo-local cache 에 보관하되 만료/수동 prune 가능해야 한다.

Acceptance:

- capsule 파일은 같은 task 에서 deterministic `capsule_body_hash` 와 `effective_prompt_hash` 를 가진다.
- registry reuse 는 file hash 가 아니라 `effective_prompt_hash` 를 사용한다.
- capsule path 로 호출하면 argv-size rejection 경로를 타지 않는다.
- capsule 내부에 session id, auth token, raw secret 이 들어가지 않는다.
- capsule 생성 실패 시 기존 prompt path 로 fail-open 하지 말고 명시 `capsule_failed` 로 stop 한다. silent fallback 은 비용과 안전 둘 다 나쁘다.
- tests cover spaces, Korean characters, `D:\...` workspaces, POSIX `/tmp`, long path boundaries, embedded secret values, traversal, symlink escape.
- `task`, `agent`, `continue`, `pair` 의 prompt source option parity 를 테스트한다.

Token effect:

- 반복 호출에서 같은 orientation 을 재작성하지 않는다.
- Codex 가 읽어야 할 파일 순서를 받으므로 exploratory grep/read 반복을 줄인다.

### PR-C. Task-Key Session Registry Bridge

**상태**: partial
**Size**: L
**목표**: `.claude` 의 7축 registry 를 plugin tracked-job/thread model 과 연결한다.

변경:

- companion `task`, `agent`, `continue` 에 옵션 추가:
  - `--task-key <key>`
  - `--task-fingerprint <hash-or-json>`
  - `--reuse-policy <auto|fresh|resume-only>`
  - `--capsule-hash <hash>`
- plugin 쪽 registry 는 `CLAUDE_PLUGIN_DATA/state/<workspace-hash>/task-sessions/*.json` 에 둔다.
- task-session JSON schema:
  - `schemaVersion`
  - `taskKey`, `taskKeySource`
  - `workspaceRootHash`, `repoRootHash`, `branch`
  - `threadIdLocalOnly` 또는 `threadIdHash`
  - `fingerprint`, `executionContractHash`
  - `capsuleHash`, `effectivePromptHash`
  - `codexHomeMode`, `codexHomeHash`
  - `jobIds`
  - `createdAt`, `lastUsedAt`
  - `invalidatedReason`
- `.claude` adapter 는 target `repoRoot/cwd` 를 명시해 기존 7축 fingerprint 를 계산한 뒤 plugin 옵션으로 넘긴다. `git` probe 는 process cwd 가 아니라 `git -C <repoRoot>` 기준이어야 한다.
- dirty fingerprint 는 `git status --porcelain=v1 -z --untracked-files=all` + real diff hash 를 사용한다. git probing 실패 시 resume 하지 않고 invalidate 한다.
- fingerprint = `.claude` 7축 + `execution_contract_hash`.
- `execution_contract_hash = hash(model, effort, profile, sandbox, approvalPolicy, write, pluginVersion, codexHomeMode, appServerRuntimeMode)`.
- `CODEX_PLUGIN_USE_DEFAULT_HOME` 또는 explicit `CODEX_HOME` 변경은 `resume_rejected_reason=codex_home_changed` 로 cache miss 한다.
- plugin 은 task-key match + fingerprint match + effective_prompt_hash match 시 `threadId` 로 resume 한다.
- mismatch 시 기존 entry 를 삭제하지 않고 invalidated archive 로 보존한다.
- resolver precedence:
  1. explicit `--job`
  2. `--task-key` + fingerprint + effectivePromptHash registry hit
  3. explicit `--resume-id`
  4. interactive latest-job candidate display only
- non-interactive continue 는 ambiguous/no-key resume 에서 latest job 을 자동 선택하지 않는다.

Acceptance:

- 같은 repo/branch/task/scope/capsule 에서 두 번째 호출은 `thread/resume` 를 탄다.
- git dirty/untracked, command args, core harness files, codex version, model/effort/sandbox/approval/write/CODEX_HOME 중 하나라도 바뀌면 fresh spawn 이거나 explicit resume confirmation 이다.
- status/result 에는 raw session id 대신 job id 중심으로 안내한다. session id 는 local command hint 에만 제한한다.
- `--fresh` 는 registry 를 우회하고 새 entry 를 등록한다.
- `/codex:continue --task-key` 는 digest + fingerprint delta 만 prepend 하고 raw previous output 은 넣지 않는다.
- `.claude` cwd 와 target repoRoot 가 다른 fixture 를 테스트한다.

Token effect:

- 반복 plan/review/research 에서 raw repo rediscovery 를 줄인다.
- "continue" 자연어가 latest-job heuristic 에 묶이지 않고 task identity 로 이어진다.

### PR-D. Resume Delta + Result Digest

**상태**: missing
**Size**: M
**목표**: 이어가기 prompt 를 작게 만들고, Claude main 에 들어오는 결과도 작게 만든다.

변경:

- `runTrackedJob` 완료 시 `resultDigest` 저장:
  - schemaVersion
  - verdict
  - confidence
  - owner_next (`claude|codex|user`)
  - next_command
  - changed files / touched files
  - evidence anchors
  - verification_state
  - blockers
  - open questions
  - next action
  - raw_output_path
- digest 는 job file 에 저장하고 raw rendered output 은 기존 log/result path 에 유지한다.
- `--digest` 는 opt-in 으로 시작한다. raw result contract 는 hard default 로 유지한다.
- `CODEX_PLUGIN_RESULT_DIGEST_DEFAULT=1` 은 low/medium-risk completed jobs 에만 허용한다. failed, approval-blocked, destructive, security, write-capable job 은 raw_output_path + mandatory evidence anchors 를 반드시 포함한다.
- `--resume` 시 capsule 앞단에 아래 1-block 을 추가:

```text
[Session Resume]
previous_status: completed|failed|cancelled
previous_digest: <short digest>
fingerprint_delta: none|git_dirty|core_files_content|...
capsule_delta: unchanged|changed
```

Acceptance:

- `/codex:result` 기본은 현재처럼 raw compatible.
- `/codex:result --digest` 는 40 lines 이하의 high-signal "Claude Action Digest" 를 반환한다.
- `/codex:result --raw` 는 raw output 을 명시 반환한다.
- `/codex:continue` 는 selected job digest 를 다음 turn prompt 에 선택적으로 prepend 할 수 있다.
- completed, failed, cancelled, timeout, empty-output job 모두 digest 를 남긴다.
- failed job 은 failure class 와 recoverability 를 남긴다.
- result command docs 의 "do not summarize" contract 는 raw default 에만 적용하고 digest mode docs 를 별도로 추가한다.

Token effect:

- Claude main context 에 long Codex output 전체가 매번 들어오는 것을 줄인다.
- 후속 turn 에 필요한 state 만 delta 로 주입한다.

### PR-E. Router Policy: Model/Effort/Mode Ladder

**상태**: partial
**Size**: M
**목표**: 모든 Codex 호출을 xhigh/default 로 밀지 않고, task value 에 맞춰 모델/effort/background 를 정한다.

정책:

| Task | Mode | Model/Effort hint | Result policy |
|---|---|---|---|
| quick second opinion | `pair --wait` | default or mini/medium | digest |
| deep root-cause | `agent --background` 또는 explicit `pair --background` | high/xhigh | digest + raw log |
| implementation with approvals | `agent` | default + approval on-request | digest + status watch |
| large review | `review --background --max-findings N` | default/high | structured |
| repeated plan/research | `pair --wait --task-key --reuse-policy auto` | default/high | resume delta |
| destructive negative claim | `pair --wait` | high/xhigh | evidence-required |

변경:

- `.claude/scripts/codex-task-classifier-hook.js` metadata 에 `recommended_mode`, `recommended_effort`, `result_policy`, `task_key_seed` 추가.
- `recommended_model` / `recommended_effort` 는 advisory metadata 이다. `/codex:agent` 와 `codex-cli-runtime` 의 "leave model/effort unset unless user asks" contract 는 유지한다.
- `/codex:pair` 만 policy-owned model/effort exception 을 가질 수 있고, 이 경우 pair-specific tests 로 입증한다.
- `fan_out_group_id` 를 실제 hash 로 채운다.
- `codex_session_drift` 를 skip taxonomy 에 공식 추가한다.
- cost cap gate 는 `baseline` 이 insufficient 일 때도 conservative default 를 쓰되, skip 이유를 telemetry 에 남긴다.
- `codexTaskRouting: true` 는 advisory only 이다. hook 이 Codex 를 직접 spawn 하지 않는다.
- auto-spawn 은 별도 explicit flag 가 생기기 전까지 금지한다.
- destructive/sensitive triggers 는 recommend 만 하고 spawn 하지 않는다.
- `decision-triage` 는 options + confidence 를 반환하고 execute/choose 하지 않는다.

Acceptance:

- hook output 은 기존 `additionalContext: string` contract 를 깨지 않는다.
- metadata schema version 을 올리고 compatibility parser 를 테스트한다. old fields 는 유지하고 new fields 는 flag-on 이전 optional 이다.
- `codexTaskRouting: false` 면 0 output, 기존 동작 유지.
- `fan_out_group_id` 는 routing fire 시 deterministic/non-null 이고, non-routing 시 null/absent 여도 된다.
- `codex_session_drift` 는 classifier/action-audit/stop-review/version-check hooks 의 skip reasons 에 추가하거나 non-classifier hook continuity 를 `deferred-by-design` 으로 명시한다.
- `tokenBudget=0` 은 disabled behavior 이고, synthetic 90% tokenBudget 초과는 `cost_cap_exceeded` 로 skip/telemetry 를 남긴다.
- PR-C registry 와 PR-F drift guard fixture 가 통과하기 전까지 router 는 `pair --background` 또는 auto reuse 를 추천하지 않는다.

Token effect:

- 낮은 가치 작업의 xhigh 과호출을 줄인다.
- 같은 turn 에 여러 trigger 가 걸려도 Codex 1회 cap 을 강제한다.

### PR-F. Background Drift Guard + Queue Discipline

**상태**: partial
**Size**: M
**목표**: long-running background 의 장점은 유지하되, shared session drift 와 result loss 를 줄인다.

변경:

- `.claude` 자동 routing 은 동일 repo + 동일 fan_out_group 에서 Codex background spawn 을 1개로 제한한다.
- plugin tracked job state index 에 non-secret `taskKey`, `capsuleHash`, `effectivePromptHash`, `promptHash`, `parentClaudeSessionId`, `fanOutGroupId` 를 저장한다. status/watch 가 per-job file 을 join 하지 않아도 drift warning 에 필요한 최소 metadata 를 볼 수 있어야 한다.
- `/codex:status --watch` 는 taskKey/capsuleHash mismatch warning 을 출력한다.
- background job 시작 직후 first progress event 의 prompt/capsule hash 를 검증하는 sentinel 을 추가한다.
- worktree guard 는 rescue prompt 가 아니라 companion `task/agent/pair/continue --background` 경로에서 enforce 한다.
  - transient worktree background 는 drop/foreground 전환하고 `warningCode: "worktree_background_dropped"` 를 남긴다.
- empty `rawOutput.trim()` classification 은 render 단계가 아니라 runner completion persistence 전에 수행한다.
  - `codex_session_drift`
  - `no_final_output`
  - `rate_limited`
  - `auth_failed`
  - `approval_blocked`
- retry 는 job-id-specific cancel/interrupt 또는 terminal drift classification 뒤에만 허용한다. 이전 active job 을 drain 할 수 없으면 retry 하지 않는다.
- SessionEnd cleanup, broker idle watchdog, dead-job reap 을 PR-F acceptance 로 잠근다.

Acceptance:

- 동일 fan-out group N개 trigger 에서 Codex call count 는 1이다.
- background job 의 result 가 empty 이면 `codex_session_drift` 또는 `no_final_output` 으로 분류된다.
- retry 는 자동 1회까지만, 그 뒤는 Claude 단독 fall-back 또는 사용자 결정으로 보낸다.
- `fan_out_group_id` 가 null 이면 background auto-route 는 skip 하거나 foreground-only 로 강등한다.
- SessionEnd 는 current-session queued/running jobs 를 정리한다.
- missed SessionEnd 는 broker idle watchdog/dead-job reap 이 보완한다.
- Windows 는 wrapper child tree 를 kill 하고, POSIX 는 process-group termination 을 검증한다.

Token effect:

- 결과 누락 후 재호출하는 비용을 줄인다.
- background 를 무조건 금지하지 않고 검증 가능한 tracked background 만 허용한다.

### PR-G. Structured Output Profiles

**상태**: partial
**Size**: L
**목표**: Codex output 을 Claude 가 다시 정리하지 않아도 되는 shape 로 받는다.

변경:

- companion option:
  - `--output-profile review|plan|bughunt|implementation|decision-triage`
- v1 은 JSON schema only 로 제한한다. Markdown profile 은 parser/validator/renderer 가 생길 때까지 deferred-by-design.
- `runAppServerTurn` 의 기존 `outputSchema` slot 을 활용한다. [codex.mjs:1302](../../plugins/codex/scripts/lib/codex.mjs#L1302)
- profile 별 required fields:
  - verdict
  - evidence
  - confidence
  - changed_files or impacted_files
  - unresolved
  - next_command
- current review schema 와 `.claude` code-review synthesis schema 사이 adapter 를 둔다.
  - `title/body -> description`
  - `line_start -> line`
  - `confidence` 는 numeric 유지 또는 label mapping
  - `id: CDX-###` 생성
  - `autoFixable` default/derivation
- Codex finding verifier 와 연결 가능한 per-finding `verification` object 를 둔다.
  - `claim`
  - `verification_command`
  - `verification_result`
  - `verdict`
  - `confidence`
  - `destructive_follow_up`
  - `target`
- `task/agent/continue/pair` 도 profile option 을 parse 하고 `outputSchema` 를 전달한다.
- storage 는 `{ result, rawOutput, parseError, profileId, profileVersion }` 를 보존한다.

Acceptance:

- schema parse 실패 시 raw output 은 보존하고 `parseError` 를 명시한다.
- destructive recommendation 은 verifier-compatible `verification` 없으면 `needs-verification` 으로 강등한다.
- rendered Markdown 과 stored JSON 모두 `confidence`, verifier verdict, uncertainty label 을 보존한다.
- review output 은 `scripts/codex-finding-verifier.js` 로 바로 검증 가능한 fixture 를 가진다.
- plan profile 은 existing `source-command-plan` Sprint Contract 와 충돌하지 않는다.

Token effect:

- Claude 가 Codex raw prose 를 다시 요약/정규화하는 후처리 token 을 줄인다.
- verifier 가 바로 grep/read target 을 받는다.

### PR-H. Metrics: Token Efficiency Proxy Dashboard

**상태**: missing
**Size**: M
**목표**: 실제 token usage 가 항상 노출되지 않아도, 비용 낭비를 감지할 proxy 를 만든다.

신규 metrics:

| Metric | Source | Purpose |
|---|---|---|
| `prompt_bytes` | capsule / prompt-file stat | prompt bloat 감지 |
| `capsule_reuse_count` | task capsule store | same-task 재사용 확인 |
| `session_reuse_rate` | registry | repeated task 효율 |
| `fresh_due_to_fingerprint_axis` | registry invalidation | stale 원인 분류 |
| `raw_result_bytes` | job rendered/log | fan-in bloat 감지 |
| `digest_bytes` | result digest | compression ratio |
| `elapsed_ms` | telemetry | latency trend |
| `background_result_empty` | tracked job | drift/loss sentinel |
| `wrapper_path` | direct command vs Agent wrapper | Claude token overhead proxy |
| `cost_per_success` | `.claude` cost-tracker | quality/cost proxy |
| `pass_rate` | `.claude` cost-tracker/verifier | outcome proxy |
| `p95_elapsed_ms` | `.claude` cost-tracker/telemetry | latency trend |
| `resume_success_rate` | registry | session continuity quality |
| `verifier_invalid_or_overcall_rate` | verifier + telemetry | quality loss proxy |

변경:

- v1 rollout 은 plugin telemetry `schemaVersion: 1` 을 유지하고 PR-H fields 는 `extras.efficiency` 아래에 둔다. schema v2 는 별도 migration PR 전까지 금지한다.
- `.claude/scripts/codex-telemetry.js`, `cost-tracker.js`, `subagent-tracker.js` 의 existing substrate 를 확장한다.
- plugin-side `scripts/codex-efficiency-report.mjs` 는 새 source of truth 가 아니라 thin exporter/wrapper 로 둔다.
- metrics 는 `task_type`, `model`, `effort`, `profile`, `sample_count`, `confidence` 로 segment 한다.
- `tokenBudget=0` disabled, insufficient baseline conservative default, exceeded cap skip reason 을 report 에 노출한다.

Acceptance:

- telemetry write 는 현재처럼 never-throw.
- session id 는 hash/truncated 처리한다.
- report 는 "call count, reuse rate, digest compression, empty result count, direct-wrapper ratio, cost_per_success, pass_rate, p95_elapsed_ms, resume_success_rate" 를 출력한다.
- old event names 는 계속 parse 되고 unknown fields 는 ignore 된다.
- efficiency report 는 telemetry extras 가 없어도 fail 하지 않는다.

Token effect:

- 과호출과 재읽기 비용을 추정 가능하게 만든다.
- cost cap 조정이 감이 아니라 기록 기반이 된다.

### PR-I. Prompt Library For Harness Roles

**상태**: missing
**Size**: S
**목표**: pair programming prompt 가 매번 길어지는 것을 막는다.

변경:

- `plugins/codex/prompts/profiles/` 추가:
  - `pair-programming.md`
  - `root-cause.md`
  - `implementation.md`
  - `plan-review.md`
  - `decision-triage.md`
- capsule 은 profile id 만 참조하고 full instruction 은 plugin side 에서 조립한다.
- `.claude` router 는 profile id 만 넘긴다.
- 최소 `profile_id`, `profile_version`, `profile_hash` capsule fields 는 PR-B 에서 필수이다. PR-I 는 profile content/library 를 추가하는 PR 이며, hash/version contract 자체는 optional 이 아니다.
- profile changes invalidate `effective_prompt_hash`.

Acceptance:

- prompt profiles 는 짧고 testable 하다.
- profile 변경 시 profile hash 와 effective prompt hash 는 profile version 을 포함해 invalidate 된다.
- unknown profile id 는 silent fallback 하지 않고 `profile_not_found` 로 stop 한다.

Token effect:

- 같은 역할 지시문을 매번 user prompt 에 붙이지 않는다.

---

## 4. Non-goals / Deferred

| 항목 | 처리 |
|---|---|
| Claude hidden transcript 자동 상속 | deferred-by-design. plugin 은 out-of-process 이므로 capsule 로 명시 전달 |
| Claude MCP tools 를 Codex 에 그대로 노출 | deferred-by-design. Codex CLI MCP config 와 Claude MCP config 는 별도 |
| image / attachment bridge | deferred. 현재 `buildTurnInput` 은 text-only 이며 Codex app-server attachment contract 확인 후 별도 PR |
| Codex raw reasoning 노출 | out of scope |
| review gate default ON | rejected for this plan. stop-review-gate 는 token burn 위험이 있어 명시 opt-in 유지 |
| all background 금지 | rejected. tracked background + sentinel + digest 로 운영 |
| hook auto-spawn by default | rejected. `codexTaskRouting` 는 advisory only, auto-spawn 은 별도 explicit opt-in 필요 |
| digest hiding raw evidence | rejected. digest 는 fan-in 최적화이고 raw output/log 는 항상 보존 |
| exact model/context-size assumptions | deferred unless verified against current official docs/runtime |

---

## 5. Validation Matrix

### Plugin tests

- `tests/pair-command.test.mjs`: direct command contract, no Agent wrapper text
- `tests/task-capsule.test.mjs`: capsule path, hash, prompt-file alias, secret scrub
- `tests/task-key-registry.test.mjs`: reuse/fresh/fingerprint mismatch
- `tests/result-digest.test.mjs`: digest generation, raw compatibility
- `tests/output-profile.test.mjs`: schema parse success/failure
- `tests/efficiency-telemetry.test.mjs`: proxy fields, never-throw write
- `tests/background-drift-guard.test.mjs`: empty output classification, fan-out cap
- `tests/runtime.test.mjs`: `/codex:result` raw default remains compatible, `/codex:result --digest` opt-in, `/codex:continue --job` and active-turn steering unchanged, registry/taskKey metadata does not change default latest-finished-job behavior unless explicit task-key/reuse option is supplied.
- telemetry compatibility: schemaVersion 1 + `extras.efficiency` parses, unknown fields ignored.

### `.claude` tests

- `scripts/test-codex-pair-hooks.js`: metadata schema version and compatibility
- `scripts/test-codex-pair-metrics.js`: reuse rate, cache miss reason, `codex_session_drift`
- `scripts/test-routing.js`: direct pair route vs rescue route
- `node scripts/validate-toolkit.js --quiet`: hook/settings/index regressions
- hook fixtures must preserve old `additionalContext` shape and prove `codexTaskRouting:false` emits zero output.

### Cross-OS Runtime Matrix

| OS / shell | Required checks |
|---|---|
| Windows PowerShell 5.1 | command quoting, Korean/space paths, prompt-file/stdin, CODEX_HOME isolation |
| Windows PowerShell 7 | command quoting, background process cleanup, child tree kill |
| Windows Git Bash cross-drive `C:\plugin` + `D:\repo` | cd-first command body, no mixed `D:\c\Users...` path, capsule path sanitize |
| Linux bash | POSIX socket endpoint, process-group termination, prompt-file/stdin |
| macOS zsh/bash | Unix socket endpoint, signal cleanup, prompt-file/stdin |

### Docs Migration Required Per PR

| PR | Required docs |
|---|---|
| PR-A | README/commands for `/codex:pair`, taxonomy `pair/agent/rescue`, `.claude` router/plan/hook guidance |
| PR-B | capsule path/hash/prompt-source, prompt-file migration, secret scrub rules |
| PR-C | task-key/reuse policy, resolver precedence, fingerprint axes |
| PR-D | digest/raw result behavior, failure digest, resume delta |
| PR-E | `.claude` metadata schema, advisory routing, autonomy boundaries |
| PR-F | background drift warnings, fan-out cap, cleanup lifecycle |
| PR-G | output profile schemas, review adapter, verifier block |
| PR-H | efficiency report fields and telemetry extras |
| PR-I | profile id/version/hash and prompt profile location |

### Dogfood scenarios

1. Same plan task called twice: second call resumes by task key and uses resume delta.
2. Dirty diff changed: fingerprint invalidates and spawns fresh.
3. Large prompt: capsule file path is used, inline prompt warning does not trigger.
4. Background implementation: job returns digest, raw log remains available.
5. Parallel review fan-out: one Codex call per fan-out group.
6. Worktree task: background is blocked or foregrounded with explicit warning.
7. Failed Codex auth/rate-limit: no infinite Stop loop, failure digest is produced.
8. `.claude` cwd differs from target repoRoot: fingerprint still uses target repo.
9. `CODEX_HOME` mode changes: registry cache miss with explicit reason.
10. Destructive finding: structured output includes verifier-compatible block or is downgraded to `needs-verification`.

---

## 6. Rollout Order

1. PR-A direct pair command
2. PR-B task capsule protocol
3. PR-C task-key registry bridge
4. PR-D resume delta + result digest
5. PR-E router policy metadata
6. PR-F background drift guard
7. PR-G structured output profiles
8. PR-H efficiency metrics
9. PR-I prompt library

Dependency rule:

- PR-A can land alone.
- PR-B must land before PR-C because registry should key against effective prompt hash.
- PR-D can land after PR-C.
- PR-E/F depend on PR-C/D because they need task identity and digest.
- PR-H can start earlier but should not be considered complete until PR-D/F emit the fields.
- PR-I is optional but low-risk once output profiles exist.

Rollout gates:

| PR | Gate |
|---|---|
| PR-A | command addition only; no default behavior change for `/codex:agent`, `/codex:rescue`, `/codex:continue`, `/codex:result` |
| PR-B | `--capsule` explicit/default off; no fallback to raw prompt after capsule failure |
| PR-C | registry reuse requires explicit `--task-key` + `--reuse-policy` or feature flag |
| PR-D | digest opt-in; raw result remains default |
| PR-E | gated by `.claude` `codexTaskRouting`; advisory only |
| PR-F | drift guard starts `warn`, then `enforce` after dogfood fixtures pass |
| PR-G | `--output-profile` opt-in |
| PR-H | telemetry/report read-only and never-throw |
| PR-I | profile selected by explicit id/version |

Stop-the-line gates:

- Any secret leakage in capsule/job state stops PR-B rollout.
- Any stale resume after git dirty/untracked, CODEX_HOME, sandbox/approval, model/effort change stops PR-C rollout.
- Any digest mode that hides failure/destructive/security evidence stops PR-D rollout.
- Any hook that spawns Codex without explicit auto-spawn opt-in stops PR-E/F rollout.

---

## 7. Success Criteria

Minimum acceptance:

- Explicit Codex pair call has a direct command path that avoids Claude subagent wrapper.
- `/codex:pair` default is foreground/read-only; background/write-capable work is explicit or routed to `/codex:agent`.
- `pair/agent/rescue` taxonomy is reflected in README, command docs, and `.claude` router/plan/hook guidance.
- Large tasks use `--prompt-file` or capsule, never inline argv.
- Repeat task can resume by task key + execution fingerprint + effective prompt hash rather than latest-job guess.
- Every terminal Codex task has digest + raw result/log path.
- Empty background result is classified, not silently accepted.
- `.claude` hook metadata contains real `fan_out_group_id` and session fingerprint.
- Efficiency report can show reuse rate, digest compression, empty-result count, direct-wrapper ratio, cost_per_success, pass_rate, p95 elapsed, resume_success_rate.

Stretch acceptance:

- Repeated plan/research tasks show high capsule reuse and session reuse.
- Destructive Codex findings arrive with verifier targets, reducing parent re-verification search.
- Router can choose lower effort/model for low-risk checks without touching user config.
- Cross-OS runtime matrix passes on Windows PowerShell, Windows Git Bash cross-drive, Linux bash, macOS zsh/bash.

---

## 8. Immediate Next Prompt

Use this as the next implementation prompt:

```text
Implement PR-A from docs/ultraplan/2026-05-18-codex-harness-token-efficiency-ultraplan.md.

Scope:
- Add a direct /codex:pair command that bypasses the codex-rescue Agent wrapper.
- Preserve existing /codex:agent and /codex:rescue behavior.
- Default /codex:pair to foreground/read-only safe posture (`--wait --sandbox read-only`).
- Support explicit --background, but route write-capable long-running work to existing /codex:agent in docs/router guidance.
- Use cd-first command body for Windows Git Bash cross-drive safety.
- Add contract tests for command file content and companion argv behavior.
- Do not implement capsules or registry yet.
- Update README and .claude routing/plan/hook guidance only enough to document pair/agent/rescue taxonomy.

Validation:
- npm test targeted command/runtime tests.
- rg evidence that /codex:pair uses disable-model-invocation and cd-first node companion directly.
- rg evidence that /codex:agent and /codex:rescue contracts are unchanged.
```
