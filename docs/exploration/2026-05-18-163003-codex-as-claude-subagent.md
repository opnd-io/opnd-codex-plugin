# codex-plugin-cc 가 Claude native subagent 처럼 사용 가능한가? — Goal-directed 다축 탐색

> 생성일: 2026-05-18 16:30 / Round 2 / 협력: Claude main (Opus 4.7) + Codex 5th-reviewer (gpt-5.4)
>
> **Goal**: 본 plugin 을 Claude Code 안에서 사용 시, Claude 가 native subagent (Task tool / `Agent({ subagent_type })`) 쓰는 것처럼 매끄럽게 사용 가능한가. 어디가 동등 / 부분 동등 / 다름 / 본질적으로 불가능한가. **두 모델 모두 새 axis 못 찾을 때까지** iterate.

## Round 진행 상태

- **Round 1 ✅**: Codex 5th-reviewer 가 14 axis baseline + 4 extra axis 도출 (A-R, total 18). Claude main 은 같은 시간에 evidence grep.
- **Round 2 (진행 중)**: Codex finding 검증 (R: `result --wait` doc/impl drift CONFIRMED) + Claude 가 12 new axes 추가 (S-AD)
- **Round 3 (대기)**: Codex 가 S-AD 검증 + 새 axis 추가
- **종료 조건**: 두 모델 모두 "더 이상 새 axis 없음" 일치

## 1. 18 Axes (Round 1 Codex 도출, Claude evidence 보강)

### A. Invocation Interface

| 항목 | 값 |
|---|---|
| Claude native | `Agent({ subagent_type: "X", prompt, run_in_background })` — 단일 RPC 호출, harness 내부 |
| Plugin | `/codex:rescue` slash command → Agent → Bash → `node codex-companion.mjs task ...` → broker → app-server → Codex CLI subprocess |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/commands/rescue.md:7](plugins/codex/commands/rescue.md), [plugins/codex/agents/codex-rescue.md:20-23](plugins/codex/agents/codex-rescue.md), [plugins/codex/scripts/codex-companion.mjs:1048](plugins/codex/scripts/codex-companion.mjs) detached task-worker spawn |
| Gap | Native = 1-step inference. Plugin = Agent → Bash → Node → broker → app-server → Codex CLI 4-step subprocess chain |
| Sub-axis 미탐색 | Claude harness 내부 background notification 정확한 shape (외부 가시 불가) |

### B. Context Propagation

| 항목 | 값 |
|---|---|
| Claude native | prompt + (limited) inherited conversation/tool context (CLAUDE.md, summary) |
| Plugin | routing flag strip → optional `--context <text>` XML 블록 prepend → `input: buildTurnInput(prompt)` + cwd + threadId 만 Codex 전달 |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/agents/codex-rescue.md:37-46](plugins/codex/agents/codex-rescue.md), [plugins/codex/scripts/codex-companion.mjs:1268-1277](plugins/codex/scripts/codex-companion.mjs), [plugins/codex/scripts/lib/codex.mjs:1287-1303](plugins/codex/scripts/lib/codex.mjs) |
| Gap | Codex 는 main 의 transcript / tool state / CLAUDE.md 자동 inherit 불가 — 사용자가 prompt 에 명시해야 함 |
| Sub-axis 미탐색 | Claude Agent 가 hidden parent transcript 일부를 prompt 에 자동 주입하는지 (Anthropic harness internals) |

### C. Result Integration

| 항목 | 값 |
|---|---|
| Claude native | subagent return value = single message back to main (run_in_background 시 notification 후 result available) |
| Plugin | foreground: lib/render.mjs:326-333 verbatim 출력 / background: tracked-jobs 저장 + `/codex:result` pull |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/lib/render.mjs:326-333](plugins/codex/scripts/lib/render.mjs), [plugins/codex/scripts/codex-companion.mjs:1947-1962](plugins/codex/scripts/codex-companion.mjs) |
| Gap | Background result 는 pull-based (main 이 `/codex:result` 호출해야 봄), native subagent 는 push notification |
| Sub-axis 미탐색 | Claude UI 가 background Agent complete 시 자동 fetch 하는지 (외부 가시 불가) |

### D. Cost / Latency / Model

| 항목 | 값 |
|---|---|
| Claude native | subagent config 의 model 그대로 호출 (haiku/sonnet/opus), Anthropic token billing |
| Plugin | default model unset → user codex config 사용, `spark → gpt-5.3-codex-spark`, app-server timeout 30 min, `--fast` 1.5×/2× |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/lib/app-server.mjs:211-213](plugins/codex/scripts/lib/app-server.mjs), [plugins/codex/scripts/codex-companion.mjs:1230-1233](plugins/codex/scripts/codex-companion.mjs) |
| Gap | Plugin = broker startup overhead + Codex inference latency 누적. 비용은 OpenAI 별도 청구 |
| Sub-axis 미탐색 | actual billing attribution (Claude Pro / API vs OpenAI ChatGPT/API) |

### E. Isolation / Sandbox

| 항목 | 값 |
|---|---|
| Claude native | inherits Claude harness sandbox / tool policy (frontmatter `tools:` 가 도구 제한) |
| Plugin | `read-only/workspace-write/danger-full-access` 명시. v2 BREAKING #1: omit 시 `~/.codex/config.toml` 상속 |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/codex-companion.mjs:92-94](plugins/codex/scripts/codex-companion.mjs), [plugins/codex/scripts/lib/codex.mjs:70-80](plugins/codex/scripts/lib/codex.mjs) |
| Gap | Codex sandbox 는 Claude permission 시스템과 완전 분리. 사용자가 `danger-full-access` 설정 시 Claude 의 read-only 의도 무시 가능 |
| Sub-axis 미탐색 | OS 별 sandbox 실제 enforcement (Linux bwrap / macOS Seatbelt / Windows none) |

### F. Session Persistence

| 항목 | 값 |
|---|---|
| Claude native | one Agent turn = isolated context, background state harness 관리 |
| Plugin | `CLAUDE_PLUGIN_DATA/state/<workspace-hash>` 영속, `ephemeral: false` 시 thread 유지 → `/codex:continue` 가능 |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/lib/state.mjs:37-51](plugins/codex/scripts/lib/state.mjs), [plugins/codex/scripts/lib/codex.mjs:1273-1279](plugins/codex/scripts/lib/codex.mjs) |
| Gap | Codex thread 가 Claude subagent memory 와 별도 — main 이 본 thread 의 history 직접 못 봄 |
| Sub-axis 미탐색 | Codex upstream thread 보존 정책 (몇 turn / 며칠 후 evict) |

### G. Async vs Sync

| 항목 | 값 |
|---|---|
| Claude native | `run_in_background: true` → harness handle/notification |
| Plugin | foreground = `runTrackedJob` / background = queued + detached worker / `/codex:status --watch` 1.5s polling |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/codex-companion.mjs:1033-1123](plugins/codex/scripts/codex-companion.mjs), [plugins/codex/scripts/codex-companion.mjs:1780-1862](plugins/codex/scripts/codex-companion.mjs) |
| Gap | Plugin async = job-queue + polling. Native = harness-level completion callback |
| Sub-axis 미탐색 | Claude background Agent 의 normalized completion event 와 plugin job 의 status transition mapping |

### H. Message Flow / RPC

| 항목 | 값 |
|---|---|
| Claude native | opaque Claude harness internal RPC |
| Plugin | JSONL `{id, method, params}` over stdin/socket, broker routes notifications + server requests (bidirectional) |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/lib/app-server.mjs:299-327](plugins/codex/scripts/lib/app-server.mjs), [plugins/codex/scripts/app-server-broker.mjs:135-203,321-348](plugins/codex/scripts/app-server-broker.mjs) |
| Gap | Plugin 이 자체 JSON-RPC bridge + broker busy semantics 구현 — 내부 구조 노출됨 |
| Sub-axis 미탐색 | upstream Codex app-server 프로토콜 버전 drift (compatibility window) |

### I. Error Paths

| 항목 | 값 |
|---|---|
| Claude native | harness 가 tool/subagent error 를 main 으로 propagate |
| Plugin | layer 별 error: missing Codex / RPC timeout 30 min / approval timeout 5 min / stale-auth annotation / model-version fallback |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/lib/codex.mjs:1131-1160,1251-1255](plugins/codex/scripts/lib/codex.mjs), [plugins/codex/scripts/lib/app-server.mjs:258-279](plugins/codex/scripts/lib/app-server.mjs), [plugins/codex/scripts/app-server-broker.mjs:18-24,90-113](plugins/codex/scripts/app-server-broker.mjs) |
| Gap | Plugin 은 operational error 가 더 명시적이지만 failure layer 가 더 많음 (broker / app-server / Codex CLI / network) |
| Sub-axis 미탐색 | Claude harness 가 Bash tool 600s timeout 시 Agent 어떻게 종료 보고하는지 |

### J. User-Facing Interface

| 항목 | 값 |
|---|---|
| Claude native | mostly invisible — Agent result 또는 background notification 만 |
| Plugin | 11 slash command, `/codex:status` 가 active jobs / log / approvals 모두 렌더 |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/lib/render.mjs:336-398](plugins/codex/scripts/lib/render.mjs) |
| Gap | Plugin 은 CLI/control-plane heavy — UX burden 큼. native 는 trans parent |
| Sub-axis 미탐색 | 비인터랙티브 (`claude --print` / CI) 환경에서 slash command 의 fallback 일관성 |

### K. Tool & Permission Scope

| 항목 | 값 |
|---|---|
| Claude native | subagent frontmatter `tools:` 가 도구 명시. main 권한 inherit |
| Plugin | codex-rescue.md 의 `tools: Bash` 단일. Codex 자체는 approvals 로 command/file/permission/MCP/tool-call/token-refresh 8 종류 제어 |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/agents/codex-rescue.md:4-5](plugins/codex/agents/codex-rescue.md), [plugins/codex/scripts/lib/approvals.mjs:10-12,141-168,286-299](plugins/codex/scripts/lib/approvals.mjs) |
| Gap | 2 gate 가 별도: Claude tool gate (frontmatter) + Codex approval gate. permission 모델 분리 |
| Sub-axis 미탐색 | Codex MCP tool 호출과 Claude tool 호출의 isomorphic 매핑 |

### L. Observability

| 항목 | 값 |
|---|---|
| Claude native | harness-level task status / final output 만 |
| Plugin | per-job log append + JSONL telemetry (traceId, schemaVersion=1, append-only) + `/codex:status --tail/--watch` |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/lib/tracked-jobs.mjs:95-118](plugins/codex/scripts/lib/tracked-jobs.mjs), [plugins/codex/scripts/codex-companion.mjs:1063-1120,1751-1862](plugins/codex/scripts/codex-companion.mjs) |
| Gap | Plugin 의 observability 가 훨씬 풍부 (log + trace + status UI) 하지만 Claude native 의 background notification UI 와 별도 system |
| Sub-axis 미탐색 | 로그 long-term retention 정책 + 개인정보 scrubbing 가이드 |

### M. Locale / Encoding

| 항목 | 값 |
|---|---|
| Claude native | Claude harness 가 encoding 관리 |
| Plugin | non-UTF-8 host 시 `C.UTF-8` (POSIX) / `en_US.UTF-8` (Windows) override (PR-4.5 #310), status watch 의 streaming TextDecoder (CDX-002, 2026-05-18 fix) |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/lib/app-server.mjs:26-50,157-175](plugins/codex/scripts/lib/app-server.mjs), [plugins/codex/scripts/codex-companion.mjs:1787-1792](plugins/codex/scripts/codex-companion.mjs) |
| Gap | Plugin 이 host locale 결함을 적극 방어 — Claude native subagent 는 무관 |
| Sub-axis 미탐색 | `en_US.UTF-8` override 시 Codex output 의 비영어 localization 정확성 |

### N. Fundamental Limits

| 항목 | 값 |
|---|---|
| Plugin | rescue 는 thin Bash forwarder — Claude harness 의 native subagent API 가 될 수 없음 (외부 process 가 inference 위탁) |
| Verdict | **impossible-to-mimic** |
| Evidence | [plugins/codex/agents/codex-rescue.md:11-14,29-32](plugins/codex/agents/codex-rescue.md) |
| Gap | Claude in-process inference ↔ Codex out-of-process subprocess: lifecycle 모델 자체가 다름 |
| Sub-axis 미탐색 | Claude harness 미래 API (richer plugin hook) — 외부 변수 |

### O. Auth / CODEX_HOME Isolation [Codex-extra]

| 항목 | 값 |
|---|---|
| Plugin | `CODEX_HOME=$HOME/.codex/claude-code/` 격리 (v2.0.0 BREAKING #2) — plugin auth 와 normal `~/.codex` 분리 |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/lib/app-server.mjs:115-145](plugins/codex/scripts/lib/app-server.mjs), [docs/MIGRATION_v2.0.md:48-80](docs/MIGRATION_v2.0.md) |
| Gap | 별도 auth.json 관리 부담 — 사용자가 `codex login` 후 plugin 호출 위해 추가 `cp` 필요 (실제로 본 cycle 의 init 단계에서 발화) |
| Sub-axis 미탐색 | token rotation 운영 burden, multi-account 시 confused-deputy 가능성 |

### P. Stop-Review Gate [Codex-extra]

| 항목 | 값 |
|---|---|
| Plugin | Stop hook (`hooks.json:26-33`, 900s timeout) 이 turn 종료 시 `codex-companion task --json` 호출 → review failure 시 BLOCK (PR-3.1 fix 적용으로 infrastructure failure 는 ALLOW) |
| Verdict | **different** |
| Evidence | [plugins/codex/hooks/hooks.json:4-33](plugins/codex/hooks/hooks.json), [plugins/codex/scripts/stop-review-gate-hook.mjs:153-165,219-231](plugins/codex/scripts/stop-review-gate-hook.mjs) |
| Gap | 본 plugin 이 main session lifecycle 자체에 영향 — native subagent 는 main 흐름에 hook fire 불가 |
| Sub-axis 미탐색 | stop-review-gate 가 user 의 Claude Pro session token budget 에 미치는 cost (PR-3.1 가 burn 차단 fix) |

### Q. Broker Lifecycle / Shared Runtime [Codex-extra]

| 항목 | 값 |
|---|---|
| Plugin | detached broker, idle watchdog (10 min grace) 후 self-exit, `.broker.lock` mkdirlock 직렬화 |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/lib/broker-lifecycle.mjs:143-219](plugins/codex/scripts/lib/broker-lifecycle.mjs), [plugins/codex/scripts/app-server-broker.mjs:388-428](plugins/codex/scripts/app-server-broker.mjs) |
| Gap | Long-running process state 보유 — native subagent 는 stateless 마다 fresh. broker 가 stale auth/cache 시 새 호출 fail |
| Sub-axis 미탐색 | broker process kill 시 in-flight job 복구 시나리오 |

### R. Documentation / Implementation Drift [Codex-extra, CONFIRMED bug]

| 항목 | 값 |
|---|---|
| 증상 | README:326 + agents/codex-rescue.md:26 모두 `/codex:result --wait <jobId>` 권장 — 그러나 `handleResult` (companion.mjs:1947-1963) 는 `booleanOptions: ["json"]` 만 받음 → `--wait` 는 unknown flag |
| 실제 동작 | 사용자가 `/codex:result --wait task-xxx` 실행 시 `--wait` 가 positional[0] 으로 consume → "No job found for \"--wait\"" silent error, exit=0 |
| Verdict | **different — real bug** |
| Evidence | grep `result --wait` README.md:326 / codex-rescue.md:26 + runtime test 확인 (exit=0 + 잘못된 jobId reference) |
| Severity | HIGH — 사용자가 docs 그대로 따라하면 100% 발화. workaround = `/codex:status --wait <jobId>` 먼저 후 `/codex:result <jobId>` |
| Action | (a) `handleResult` 에 `--wait` 지원 추가 (job terminal state 까지 polling) **또는** (b) README + agent docs 의 `--wait` 표기 제거 |

## 2. Claude main 추가 12 axes (Round 2 보강)

### S. Recursion / Depth Control

| 항목 | 값 |
|---|---|
| Claude native | subagent 가 또 다른 Agent({}) 호출 가능 (depth 제한 없음) |
| Plugin | **명시적 금지** — codex-rescue.md:32 + codex-cli-runtime.md:17 `Do not call review/status/result/cancel` |
| Verdict | **different (intentional restriction)** |
| Evidence | [plugins/codex/agents/codex-rescue.md:32](plugins/codex/agents/codex-rescue.md), [plugins/codex/skills/codex-cli-runtime/skill.md:17](plugins/codex/skills/codex-cli-runtime/skill.md) |
| Gap | 의도된 제약 — recursion 차단으로 broker resource exhaustion / 무한 loop 방지. native 는 free-form |
| Sub-axis 미탐색 | Claude main 이 `Agent({ subagent_type: "codex:codex-rescue" })` 를 N번 sequential 호출 시 broker 의 concurrent capacity |

### T. Cancellation Propagation

| 항목 | 값 |
|---|---|
| Claude native | main 이 Agent 호출 cancel 시 subagent 즉시 종료 (in-process) |
| Plugin | main → Bash 600s timeout OR /codex:cancel → SIGTERM/SIGINT/SIGHUP handler (tracked-jobs.mjs:193-200, PR-1.2 #228) → process tree terminate → job phase: terminated |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/lib/tracked-jobs.mjs:193-200](plugins/codex/scripts/lib/tracked-jobs.mjs), tests/sigterm-handler.test.mjs |
| Gap | Claude Bash kill → SIGTERM → graceful → process tree cleanup. 단, Codex 자체 (broker 너머) 의 turn 은 별도 `turn/interrupt` RPC 필요 — interrupt 가 broker 까지만 가고 in-flight Codex CLI turn 은 완료될 가능성 |
| Sub-axis 미탐색 | Claude harness 가 Agent tool 강제 종료 시 SIGTERM vs SIGKILL 선택 정책 |

### U. Resource Accounting / Cost Pooling

| 항목 | 값 |
|---|---|
| Claude native | main 의 token budget 안에서 subagent token 차감 (단일 account, 단일 max_turns 적용) |
| Plugin | Claude main token + OpenAI/ChatGPT 별도 청구 (Codex usage limits) — 두 시스템 독립 |
| Verdict | **different** |
| Evidence | (외부 — billing 시스템 noprov), README 의 "Usage will contribute to your Codex usage limits" |
| Gap | main 이 본 codex-rescue 의 expected cost 모름, max_turns 와 무관. 두 별도 quota 동시 소진 |
| Sub-axis 미탐색 | Codex rate limit hit 시 main 에 의미 있는 error signal 전달 (현재는 stale-auth 등 일반 error) |

### V. Conversation Logging / Privacy

| 항목 | 값 |
|---|---|
| Claude native | main conversation 은 Claude harness transcript 에 기록 (Anthropic 정책) |
| Plugin | Codex history 는 `$CODEX_HOME/.codex/claude-code/` 격리 (v2 BREAKING #2 의 의도). OpenAI 측 history 별도 |
| Verdict | **different (better isolation)** |
| Evidence | [plugins/codex/scripts/lib/app-server.mjs:115-145](plugins/codex/scripts/lib/app-server.mjs) |
| Gap | data residency 가 2 vendor 로 분리. 사용자가 본 plugin 사용 시 codex prompt + 결과가 OpenAI 측 (별도 정책) 에 노출됨을 인지해야 |
| Sub-axis 미탐색 | telemetry events.jsonl 의 PII scrubbing 보장 — 현재 traceId 위주이지만 cwd / error message 에 path leak 가능 |

### W. Replayability / Determinism

| 항목 | 값 |
|---|---|
| Claude native | Claude harness 가 token streaming 기록, replay 가능 (단 LLM 비결정성) |
| Plugin | traceId + JSONL telemetry 로 plugin 측 동작 trace 가능. Codex 측은 gpt-5.x 비결정 — 동일 prompt → 다른 output |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/lib/telemetry.mjs](plugins/codex/scripts/lib/telemetry.mjs) — schemaVersion=1, traceId |
| Gap | Plugin trace 는 envelope (envelope timing, error path) 까지만. Codex 내부 reasoning 은 비결정 + 미공개 |
| Sub-axis 미탐색 | `--profile` + `--fast` 조합 시 결정성 변화 (다른 service tier 라 응답 분포 다를 수 있음) |

### X. MCP Server Scope

| 항목 | 값 |
|---|---|
| Claude native | subagent 는 main 의 MCP server 일부 (frontmatter `tools:` 에 명시된 mcp__*) inherit |
| Plugin | Codex CLI 측의 MCP server 만 사용 가능 — Claude main 의 MCP servers (Figma/Playwright/Gitea/...) 비가시. `mcpToolCall` / `mcpServer/elicitation/request` 는 Codex's own MCP context 이지 Claude's MCP 아님 |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/lib/approvals.mjs:8,161,288](plugins/codex/scripts/lib/approvals.mjs), [plugins/codex/scripts/lib/codex.mjs:299,330](plugins/codex/scripts/lib/codex.mjs) |
| Gap | Tool surface 비대칭 — Claude main 의 Figma MCP 도구를 codex-rescue 가 직접 못 부름. 사용자가 양쪽에 같은 MCP 설정해야 함 |
| Sub-axis 미탐색 | Codex CLI 의 MCP config 위치 + Claude Code MCP config 와 sync 가이드 |

### Y. Mid-call User Input

| 항목 | 값 |
|---|---|
| Claude native | subagent 가 `AskUserQuestion` 호출 → main 의 UI 가 사용자에 prompt → 응답 그대로 subagent 로 전달 |
| Plugin | Codex 가 mid-run 에 input 필요 시 `/codex:approve --response-json` 사용 (별도 slash command) → main 이 사용자에게 confirm 요청 하려면 자체 AskUserQuestion 호출 필요 |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/codex-companion.mjs:372-447,1592-1617](plugins/codex/scripts/codex-companion.mjs) |
| Gap | Codex 의 user-input 요청이 직접 Claude 의 AskUserQuestion 으로 변환 안 됨 — `/codex:status` 에서 pending approval 보고 → main 이 AskUserQuestion 호출 → `/codex:approve` 호출 (3-hop indirection) |
| Sub-axis 미탐색 | 비인터랙티브 모드 (`claude --print`) 에서 mid-run approval 의 default 정책 |

### Z. Hooks Interaction

| 항목 | 값 |
|---|---|
| Claude native | subagent 는 main lifecycle hook 발화 안 함 |
| Plugin | SessionStart / SessionEnd (5s) / Stop (900s) hooks (hooks.json) — Stop 은 codex-companion task review 호출, 결과로 main 의 stop block 가능 |
| Verdict | **different** |
| Evidence | [plugins/codex/hooks/hooks.json:4-33](plugins/codex/hooks/hooks.json), [plugins/codex/scripts/session-lifecycle-hook.mjs](plugins/codex/scripts/session-lifecycle-hook.mjs), [plugins/codex/scripts/stop-review-gate-hook.mjs](plugins/codex/scripts/stop-review-gate-hook.mjs) |
| Gap | 본 plugin 이 main 의 lifecycle 자체에 hook 등록 — feedback loop 가능 (codex 결과가 main 종료 차단). native subagent 와 의미적 차이 큼 |
| Sub-axis 미탐색 | Stop hook 의 review 가 main 의 다른 plugin (e.g. 다른 Code review skill) 과 충돌 시 결정 우선순위 |

### AA. Effort / Determinism Exposure

| 항목 | 값 |
|---|---|
| Claude native | model 별 thinking budget (xhigh 등). temperature 외부 미노출 (Claude API) |
| Plugin | `--effort none/minimal/low/medium/high/xhigh` 노출, temperature 비명시 |
| Verdict | **partial-isomorphic** |
| Evidence | [plugins/codex/scripts/codex-companion.mjs:92](plugins/codex/scripts/codex-companion.mjs) (VALID_REASONING_EFFORTS) |
| Gap | Codex effort tier 가 Claude xhigh 와 직접 매핑 안 됨 (다른 모델 scale). 동일 effort 라도 모델 별 의미 다름 |
| Sub-axis 미탐색 | `--effort` 와 latency / cost / quality 의 정량적 mapping 표 |

### AB. Worktree Circular Interaction

| 항목 | 값 |
|---|---|
| Claude native | Agent 호출 시 `isolation: "worktree"` 명시 — 자동 worktree 생성/cleanup |
| Plugin | worktree 내부에서 codex-rescue 호출 감지 시 `--background` 강제 drop → foreground 강제 (#198 worktree isolation guard) |
| Verdict | **partial-isomorphic (with guard)** |
| Evidence | [plugins/codex/agents/codex-rescue.md:28](plugins/codex/agents/codex-rescue.md), [plugins/codex/skills/codex-cli-runtime/skill.md:53](plugins/codex/skills/codex-cli-runtime/skill.md), tests/worktree-detection.test.mjs |
| Gap | worktree 자동 cleanup vs broker outlive 충돌 회피 패턴. 단, `--background` 를 명시한 사용자 의도가 silently overridden — 의도된 안전 측면이지만 surprise 가능 |
| Sub-axis 미탐색 | worktree 안에서 `/codex:status --watch` 실행 시 worktree cleanup 과 watch loop 의 lifecycle 충돌 |

### AC. Hot-reload / State Drift

| 항목 | 값 |
|---|---|
| Claude native | subagent 호출 매번 fresh load (frontmatter / prompt re-read) |
| Plugin | broker 가 long-running — plugin 코드 변경 시 stale broker 가 새 호출 받음. broker idle watchdog (10 min) 후 재기동까지 stale |
| Verdict | **different** |
| Evidence | [plugins/codex/scripts/app-server-broker.mjs](plugins/codex/scripts/app-server-broker.mjs) (idle watchdog) |
| Gap | 사용자가 plugin scripts 수정 시 broker 종료 필요 (`/codex:cancel` + broker idle 대기 또는 process kill). native 는 무관 |
| Sub-axis 미탐색 | broker hot-reload 명시 명령 (broker-restart slash command 가 없는 것이 의도된 trade-off 인지) |

### AD. Cost Cap / Budget Pooling

| 항목 | 값 |
|---|---|
| Claude native | main `max_turns` / token budget 안에서 subagent token 누적 차감 |
| Plugin | Claude max_turns 와 무관하게 Codex 별도 quota 소진. main 이 본 codex-rescue 호출의 expected cost 알 수 없음 |
| Verdict | **different** |
| Evidence | (negative — cost-tracker / budget API 부재) |
| Gap | main 의 cost-aware 결정 불가능 — codex-rescue 호출 전에 "이 호출이 OpenAI 측 N token 쓸 것" 추정 surface 없음 |
| Sub-axis 미탐색 | `/codex:status` 가 누적 OpenAI token usage 표시할 수 있는지 (현재는 plugin 측 trace 만) |

## 3. Action Items (검증된 bug + 개선 후보)

### HIGH (즉시)

1. **R 검증 결과 `result --wait` doc/impl drift bug**:
   - 옵션 A: `handleResult` 에 `--wait` 지원 추가 (terminal state polling)
   - 옵션 B: README:326 + agents/codex-rescue.md:26 의 `--wait` 표기 제거 + workaround 명시 (`/codex:status --wait <jobId>` 먼저, 그 후 `/codex:result <jobId>`)
   - 본 PR (codex-plugin-cc 본 cycle) 와 별도 PR 로 처리 권장

### MEDIUM (다음 cycle)

2. **U + AD (cost visibility)**: `/codex:status` 에 누적 OpenAI usage 추가 (Codex CLI 측 API 가 노출하면)
3. **X (MCP scope)**: README 에 "Codex 측 MCP config 위치 + Claude main MCP 와 sync 가이드" 단락 추가
4. **Y (mid-input)**: 비인터랙티브 모드의 approval default 정책 명문화 (PR-7.8 #223 패턴 확장)
5. **AC (hot-reload)**: `/codex:broker --restart` 또는 docs 의 "plugin script 수정 후 broker 재기동 방법" 단락 추가

### LOW (defer)

6. **Z (hooks 충돌)**: stop-review-gate 가 다른 plugin Stop hook 과 충돌 시 우선순위 docs
7. **AA (effort mapping)**: `--effort` 별 latency/cost/quality 정량 표 docs

## 4. 종료 조건 평가 (Round 2 시점)

- **Codex Round 1 finding**: 18 axes (A-R), "No further repo-visible unexplored axes found" 자가 선언. 외부 3 unknown 인정 (Claude harness internals, background notification shape, upstream Codex proto drift)
- **Claude Round 2 finding**: 12 new axes (S-AD). 이 중 일부 (S/T/X/Z/AC) 는 Codex Round 1 의 "K. Tool & Permission Scope" / "I. Error Paths" / "Q. Broker Lifecycle" 등에서 partial 언급되나 별도 axis 로 enumerate 가치 있음
- **Round 3 필요**: Codex 가 Claude 의 S-AD 를 재검토하고 missed sub-axis 발견 여부 — 특히 S(recursion 의 concurrent capacity), T(SIGTERM vs SIGKILL 정책), W(profile+fast 결정성), AC(broker hot-reload)

## 5. 다음 Round 트리거

Round 3 — Codex 5th-reviewer 에 본 30-axis map (Codex 18 + Claude 12) 제시 + 다음 질문:
1. Claude 의 S-AD 중 너가 missed 한 것의 deeper sub-axis 발견 여부
2. Codex 자신의 18 axes 중 Round 1 에서 surface 안 한 sub-axis 추가 여부
3. 두 모델 통합 30 axes 중 "axis 자체가 잘못 나뉜" / "두 axis 가 사실 하나" merging 후보

종료 조건: Codex Round 3 가 "추가 axis 없음, merge 후보 없음" 보고 시 exploration complete.

---

## Round 3 (Codex 5th-reviewer 결과)

### S-AD 검토

| Axis | Verdict | 비고 |
|---|---|---|
| S Recursion | **valid + needs-deeper**: concurrent rescue capacity / broker busy 동작 | AF 와 연관 |
| T Cancellation | **valid + needs-deeper**: Bash kill / worker death 후 orphan semantics | AE 와 연관 |
| U Cost-Pooling | **subsumed by D** | |
| V Privacy | **subsumed by O** | |
| W Replayability | **valid + needs-deeper**: profile/fast 결합 시 결정성 boundary, upstream proto drift | |
| X MCP | **subsumed by K** | |
| Y Mid-input | **valid + needs-deeper**: 비인터랙티브 approval default / AskUserQuestion bridge | |
| Z Hooks | **subsumed by P** | |
| AA Effort/Determinism | **valid + complete** | |
| AB Worktree-Circular | **valid + needs-deeper**: status/watch lifecycle inside disposable worktree | |
| AC Hot-reload | **subsumed by Q** | |
| AD Cost-Cap | **subsumed by D** | |

### Codex Round 1 자기 비판 (sub-axis 누락 보강)

- **B Context Propagation**: large prompt 전송 경로 (`--prompt-file`/`--prompt-stdin`) sub-axis 누락. Round 1 에서는 context=transcript vs prompt 로만 프레임
- **H RPC**: upstream Codex 프로토콜 버전 contract pin 부재 — `app-server-protocol.d.ts` 스냅샷은 있으나 upstream version 명시 없음
- **Q Broker Lifecycle**: crash recovery / orphan turn semantics 미검증 — broker/worker crash 후 in-flight turn 의 fate 불명

### Merge 후보 + 24 canonical axis

| 합치는 axis | 새 레이블 |
|---|---|
| O + V | Auth, Data Residency & Local Persistence |
| Q + AC | Broker Lifecycle, Restart & State Drift |
| K + X | Tool Surface & Permission Boundary |
| U + AD | Cost Accounting, Quotas & Budget Caps |
| P + Z | Claude Hooks & Stop-Gate Interaction |
| B + Y | **유지** (운영 단계 다름 — 초기 컨텍스트 vs 실행 중 input) |

**24 unique = 30 axes (Codex 18 + Claude 12) − 6 subsumed**

### Codex 신규 axis 후보 (AE-AK)

| | 레이블 | 근거 (Codex evidence) |
|---|---|---|
| AE | Broker/Worker Crash Recovery | pid reaping, signal handlers, in-flight turn orphan |
| AF | Workspace Concurrency / Broker Busy Contention | `withBrokerLockAsync()` serialization + busy rejection |
| AG | Cross-OS Runtime Divergence | named pipe vs Unix socket, Windows `taskkill`, locale override |
| AH | Release/Update Drift & Version Metadata | docs v2.1.0 vs manifest 2.0.0 mismatch |
| AI | Setup/Onboarding First-Failure Modes | `/codex:setup` readiness, v2 CODEX_HOME auth-copy 누락 |
| AJ | Backward Compatibility Beyond BREAKING #1/#2 | idle timing, config cache, locale, telemetry drift |
| AK | Multimodal / File Attachment Parity | text-only `buildTurnInput()`, image/attachment bridge 부재 |

### Codex 종료 권고: **NEEDS-ROUND-4** (canonical merge pass + crash/concurrency/multimodal/upgrade validation)

---

## Round 4 (Claude main 의 AE-AK evidence 검증)

| Axis | Claude evidence | 일치 |
|---|---|---|
| AE | `state.mjs:475` `failureReason: "reaper:<reason>"` (reaper:process_died / reaper:pid_reused) — birth-time 검증 (PR-1.1 #222). 단, in-flight turn (mid-RPC worker death) 의 orphan recovery sub-axis 는 별도 검증 필요 | ✅ + sub-gap 동의 |
| AF | `app-server-broker.mjs:80` `activeRequestSocket` 단일 caller serialize, line 306 `isActiveTurnControlRequest` 분기 — 별도 socket 대기 정책 명시. concurrent 2 client 시 second client block 가능 | ✅ |
| AG | `process.mjs:157-182` `terminateProcessTree` Windows `taskkill /PID /T /F` vs POSIX 분기, `state.mjs:126` `if (process.platform === "win32")` PID birth-time wmic 분기. Windows 가 가장 풍부, Linux/macOS 검증 부족 | ✅ |
| AH | `package.json: "version": "2.0.0"` vs `README:4` v2.1.0 marketing vs `CHANGELOG.md` 의 `## 2.1.0` 헤더 부재 — **3 sources drift** | ✅ **real doc/version drift bug** |
| AI | `TROUBLESHOOTING.md:308-365` "loggedIn: false (v2.0.0 home isolation)" 전체 섹션 — 알려진 first-failure | ✅ + 이미 documented |
| AJ | `codex-companion.mjs:135-143` `maybeEmitV2FirstRunWarning` + 2 restore env vars (`CODEX_PLUGIN_SANDBOX_DEFAULT` / `CODEX_PLUGIN_USE_DEFAULT_HOME`). 추가 silent drift 후보: telemetry schema, locale override, idle timing — 미문서화 | ✅ |
| AK | grep `image/attachment/multimodal/file_input` = 0건. `buildTurnInput` 은 text-only — Claude image 지원 대비 본질적 gap | ✅ + gap confirmed |

**Claude main 의 추가 axis 후보 (Round 4 시도)**: 후보 검토 — AL Test harness integration / AM Background notification queue / AN Plugin update mechanism — 모두 기존 axis 의 sub-axis 로 흡수 가능. **새 unique axis 발견 0**.

### Canonical 31 axis (24 merged + 7 new)

1. A Invocation Interface
2. B Context Propagation (sub: large prompt transport via `--prompt-file`/`--prompt-stdin`)
3. C Result Integration
4. D + U + AD **Cost Accounting, Quotas & Budget Caps**
5. E Isolation / Sandbox
6. F Session Persistence
7. G Async vs Sync
8. H RPC Internals (sub: upstream proto drift)
9. I Error Paths
10. J User-Facing Interface
11. K + X **Tool Surface & Permission Boundary**
12. L Observability
13. M Locale / Encoding
14. N Fundamental Limits
15. O + V **Auth, Data Residency & Local Persistence**
16. P + Z **Claude Hooks & Stop-Gate Interaction**
17. Q + AC **Broker Lifecycle, Restart & State Drift** (sub: crash/orphan recovery)
18. R Documentation/Implementation Drift (**bug confirmed: `/codex:result --wait`**)
19. S Recursion / Depth Control (sub: concurrent rescue capacity)
20. T Cancellation Propagation (sub: SIGTERM vs SIGKILL policy)
21. W Replayability / Determinism (sub: profile + fast tier 결정성)
22. Y Mid-call User Input (sub: non-interactive approval default)
23. AA Effort / Determinism Exposure
24. AB Worktree Circular Interaction (sub: status/watch lifecycle in disposable worktree)
25. AE Broker/Worker Crash Recovery
26. AF Workspace Concurrency / Broker Busy Contention
27. AG Cross-OS Runtime Divergence
28. AH **Release/Update Drift & Version Metadata (bug confirmed)**
29. AI Setup/Onboarding First-Failure Modes
30. AJ Backward Compatibility Beyond BREAKING #1/#2
31. AK Multimodal / File Attachment Parity (gap — text-only)

### Round 4 종료 후보: Round 5 (Codex 에 final EXPLORATION COMPLETE 여부 확인)

Claude main 은 새 axis 발견 0. Codex 의 Round 3 권고 NEEDS-ROUND-4 가 본 Round 에서 충족 (canonical merge + AE-AK evidence). 최종 종료 판정은 Codex 에 한 번 더 호출.

---

## Confirmed Bugs (action items)

### HIGH

1. **R: `/codex:result --wait <jobId>` doc/impl drift** — README:326 + agents/codex-rescue.md:26 권장 syntax 가 `handleResult` (companion.mjs:1947-1963) 에 미구현. `--wait` 가 jobId positional 로 consume → silent error
2. **AH: Version manifest drift** — `package.json: 2.0.0` vs `README:4` "v2.1.0 features" vs `CHANGELOG.md` `## 2.1.0` 헤더 부재. 사용자가 README 보고 v2.1.0 expect 하나 manifest 는 2.0.0

### MEDIUM

3. **AE sub: in-flight turn orphan recovery** — broker/worker crash 후 mid-RPC turn 의 recovery 정책 미명시
4. **AK: multimodal gap** — Codex CLI 가 image/attachment 받는다면 plugin 도 bridge 필요 (현재 text-only)
5. **AJ silent drift**: telemetry schema / locale override / idle timing 의 v1→v2 변화 not documented

### LOW

6. **AG cross-OS coverage**: Linux/macOS specific test sparse 대비 Windows 풍부
7. **AF**: concurrent 2-client broker busy 동작 명시 docs 부재

---

## Round 5 — EXPLORATION COMPLETE

Codex final verdict (session 새 thread, 49s foreground):

- **Missing axes**: none
- **Merge regrets**: none
- **Verdict**: **EXPLORATION COMPLETE** — "31 axes cover invocation, context, result, lifecycle, permissions, cost, observability, runtime drift, concurrency/crash, setup/update, and multimodal parity; another round would likely only add sub-axes"

**종료 조건 충족** — Claude main 추가 axis 발견 0 + Codex 추가 axis 발견 0 + merge 후보 없음 일치.

### 메타데이터

| 항목 | 값 |
|---|---|
| Round 수 | 5 |
| Codex 호출 횟수 | 4 (Round 1 background / Round 3 background-then-resume / Round 5 foreground) |
| Codex partial-failure | 1 회 (Round 3 background terminated 후 thread resume 으로 회수) |
| 최종 canonical axis | 31 (24 merged from 30 + 7 new AE-AK) |
| Confirmed bugs | 2 (R: `/codex:result --wait` doc/impl drift, AH: version manifest 3-source drift) |
| Documented gaps | 4 (AE in-flight orphan, AJ silent drift, AK multimodal text-only, AG cross-OS coverage) |
| Exploration 시작 → 종료 | 2026-05-18 16:30 → 17:30 (approx) |
