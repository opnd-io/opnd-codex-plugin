# Upstream openai/codex-plugin-cc — open issue 분류 — 2026-05-28

> Daily-evolve digest (2026-05-28) 의 NOT-FIXED upstream-issue 29건 + PARTIAL upstream-issue 1건 분류. 본 fork (opnd-io) 의 main 기준 cover 상태 + upstream gh issue 답글 후보 + 다음 sprint port 후보 식별.

## 본 fork 가 이미 cover 한 upstream issue (5건) — gh issue 답글 후보

| upstream # | 우리 fix 위치 | 답글 내용 |
|---|---|---|
| **#281** app-server fails with "access token could not be refreshed" after logout/login while `codex exec` works | PR #4 (commit 3d72d6e) — `lib/codex.mjs` BROKER_BUSY_RPC_CODE + timeout regex 분기 + cross-platform recovery | "본 fork 의 PR #4 가 transient broker contention 을 actual logged-out 으로 분류 안 하도록 fix. Recovery 절차: cp + broker kill + WAL cleanup" |
| **#282** Companion/review jobs should not share the user's main Codex Desktop history feed by default | v2.0+ sprint — plugin home 격리 (`$HOME/.codex/claude-code/`) | "v2.0.0 BREAKING change 로 sessions 가 별도 home 격리. legacy 복원은 `CODEX_PLUGIN_USE_DEFAULT_HOME=1`" |
| **#288** `sendBrokerShutdown` has no timeout — SessionEnd hook can hang indefinitely | v2.0+ — `broker-lifecycle.mjs` L46-48 (`BROKER_SHUTDOWN_TIMEOUT_MS = 5000`) + L65 setTimeout | "함수가 reject 안 함 — call site await 안전. 이미 5000ms timeout 처리됨" |
| **#337** `app-server.mjs:188` spawn("codex") fails on Windows without shell:true | v2.0+ — `process.mjs` L62-82 `buildCommandInvocation()` 이 `cmd.exe /d /s /c call` 래핑 + `shell: false` + `quoteWindowsCmdArg()` | "command injection 안전한 cmd.exe 래핑으로 해결. shell:true 위험 회피" |
| **#342** [BUG] `/codex:setup` reports `loggedIn:false` when shared broker is busy; getCodexAuthStatus missing direct-fallback | PR #4 (commit 3d72d6e) — broker busy 분기 + `loggedIn: null + transient: true` | "본 fork 의 PR #4 가 broker busy 시 별 status 반환 — false-negative 회피. caller 가 transient vs actual 구분 가능" |

→ 5건 upstream answer 가치. 사용자가 각 upstream issue 에 comment 등록 시 reference: PR #4 commit `3d72d6e` + commits/PRs 명시.

## 본 fork 가 부분 cover (improve 여지) — 3건

| upstream # | 우리 상태 | 다음 작업 |
|---|---|---|
| **#310** Windows zh-TW: codex app-server JSONL parser crashes on Big5-encoded taskkill stdout leak | locale mitigation 처리 (LANG=en_US.UTF-8 강제 spawn) 있지만 zh-TW Big5 specific 미검증 | upstream 코멘트 + 본 fork 검증 |
| **#286** Same-cwd parallel /codex:* races on jobs.json + broker.json: data loss + orphan brokers | broker lock 으로 일부 처리 (PR-5.2 #281) | 동시성 stress test 추가 가치 |
| **#308** Large prompt to codex:codex-rescue silently rejected as 'user denied' | 본 PR #5 의 telemetry UX 강화에 일부 cover, full handling 없음 | nextSteps 강화 + 사용자 안내 |

## NOT-FIXED upstream-issue HIGH 후보 (port 가치, 8건)

| # | title | port effort | 우선 |
|---|---|---|---|
| 350 | codex-rescue subagent returns empty output on any companion error | M (codex-rescue retry path) | HIGH |
| 349 | Windows: /codex:review and /codex:rescue silently return empty results because plugin forces broken sandbox modes | M | HIGH |
| 345 | Codex --background killed by SessionEnd hook when wrapped in Agent subagent | M | HIGH |
| 336 | Codex sandbox shell commands fail with CreateProcessAsUserW 1312 (Windows Store pwsh.exe) | L (Windows specific) | MEDIUM |
| 333 | Focus text in adversarial-review is re-tokenized; --FLAG VALUE substrings leak into CLI args | S (argv parsing) | HIGH |
| 331 | codex-companion cancel taskkill fallback breaks under Git Bash | S (MSYS path) | MEDIUM |
| 330 | codex-companion IPC pipe deadlocks mid-review (PowerShell stdout-heavy) | L (Windows pipe handling) | HIGH |
| 295 | Windows: shell tool-calls inside Codex turn fail with 'CreateProcessAsUserW failed: 1920' | L (Windows sandbox) | MEDIUM |

→ HIGH 5건 + MEDIUM 3건 = 8건 port 가치. 각 별 PR 또는 묶음 chore. 본 fork 의 Windows / sandbox 영역 보강 sprint 가치.

## NOT-FIXED upstream-issue MEDIUM/LOW (port 가치 낮음, 19건)

- #354 feature request (codex:reviewer subagent — review-mode counterpart to codex-rescue): feature, MEDIUM
- #329 Codex review no response all the time in VS Code plugin: VS Code 영역, scope 외
- #324 codex:codex-rescue subagent returns stub instead of actual task output: rescue 관련, MEDIUM
- #321 Delegated sessions show unresolved placeholder in Codex Desktop: Desktop 영역
- #320 Not working with chatGPT subscriptions: 우리 fork 정상 작동, upstream 별 issue
- #309 [BUG] adversarial-review / review fail HTTP 400 ('gpt-5.5 requires newer Codex') on CLI 0.130.0: PARTIAL fix 후보, MEDIUM
- #306 Reaching codex rate limit causes infinite review cycle: PR #5 의 usage limit helper 가 일부 cover, MEDIUM
- #304 codex-companion.mjs hardcodes workspace-write sandbox for write tasks: v2.0+ sandbox 정책 변경으로 일부 cover
- #298 /codex:review caps findings at ~3 — add configurable max: 우리 `--max-findings` flag 존재 — cover
- #287 spawn("codex") in app-server.mjs throws ENOENT (Node PATHEXT for .cmd shims): #337 와 유사 — cover 추정
- #285 Stop/Session hooks fail on Windows when CWD different drive: solution doc `windows-cross-drive-hook-cd-first-pattern` 있음
- #284 Add --context flag to /codex command: feature request
- #283 Delegated sessions renamed with representative identifier in Codex Desktop: Desktop 영역
- (10건 더 — analyzed.json 의 daily-evolve raw 참조)

## NOT-FIXED upstream-pr 92건 — cherry-pick 평가

92건 너무 큼. 본 doc scope 외. 별도 분석 sprint:
- daily-evolve digest 의 list 사용
- 각 PR 의 fork-relevance 평가 (Windows / sandbox / auth 영역 우선)
- 가치 평가 후 cherry-pick PR 별도

## 다음 sprint plan (사용자 결정 영역)

| 우선 | 작업 | 추정 scope |
|---|---|---|
| HIGH | 본 fork cover 5건 upstream gh issue 답글 등록 | 0.5d |
| HIGH | upstream HIGH 8건 port 평가 + 가장 trivial 2건 fix (예: #333 argv parsing, #331 MSYS path) | 1주 |
| MEDIUM | suminerProxy NDJSON event stream 묶음 cherry-pick | 1주+ |
| MEDIUM | suminerProxy raw payload strip + token usage cherry-pick | 3-4일 |
| LOW | upstream-pr 92건 분류 sprint | 1주+ |

본 fork 가 이미 cover 한 5건 upstream answer 가 가장 quick win.
