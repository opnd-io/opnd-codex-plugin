# upstream 항목 open-vs-fixed-vs-by-design 매트릭스

> 작성: 2026-05-20 / 근거: `2026-05-18-upstream-backlog-audit.md` 후 PR #3·#4 + 본 세션 A1~A4 fix 반영한 재검증
> 목적: `docs/code-review/2026-05-20-pair-readiness-adversarial.md` TOP3-#3 — stale audit 항목과 진짜 미수정을 분리. handoff ultraplan §5 B2 의 deferred 목록이 일부 이미 해결됐음을 명확히 함.

## 매트릭스

| upstream | 항목 | 현재 상태 | 근거 |
|---|---|---|---|
| #312 | per-turn inactivity watchdog | **FIXED+** | PR #3 manual port (`TurnWatchdogError`, `lib/codex.mjs`) + 본 세션 A2 로 기본 on (`DEFAULT_TURN_WATCHDOG_MS` 10 min) |
| #190 | child env injection sanitization | **FIXED** | PR #3 + PR #4 SEC-001 (`ENV_INJECTION_VECTORS` + `GIT_CONFIG_*` prefix), `app-server.mjs` |
| #289 | prompt-file path containment | **FIXED+** | PR #3 manual port + 본 세션 A4 로 `realpathSync` symlink 우회 차단 |
| #290 | git ref `--end-of-options` 주입 가드 | **FIXED** | PR #3 (5 sink) + PR #4 ARCH-002 (`collectReviewContext` 2 sink), `git.mjs` 7 sink 전체 |
| #314 | UTF-8-safe prompt truncation | **FIXED** | PR #3 (`truncateToUtf8Bytes`, `codex-companion.mjs`) |
| #24 / #311 / #23 | JSONL ANSI escape strip + non-JSONL guard | **FIXED** | PR #3 `lib/jsonl.mjs` (`cleanProtocolLine`) 신설 — broker + app-server 양쪽 |
| (A1) | approval-loop unbounded hang | **FIXED** | 본 세션 — `waitForApprovalDecision` timeout (`CODEX_PLUGIN_APPROVAL_WAIT_MS`, 기본 30 min) |
| (A3) | broker teardown zombie | **FIXED** | 본 세션 — `teardownBrokerSession` 기본 `terminateProcessTree` killer |
| #250 | per-tool timeout | **PARTIAL** | 전용 per-tool timeout 없음 (`codex.mjs` grep 0). 단 #312 per-turn watchdog(A2 기본 on) + finalizing-phase 5 min bound 이 silent-tool hang 을 상위에서 bound — per-tool 세분화는 미구현 |
| #59 | state cross-read/write | **OPEN** | `state.mjs` 는 `CLAUDE_PLUGIN_DATA`/temp fallback 만, 워크스페이스 간 cross-read/write 없음 |
| #75 | permission-deny bridge | **OPEN** | `approvals.mjs` 의 approval 이 host `.claude/settings.json` deny rule 과 분리 — 별도 권한 시스템. bridge 또는 limitation 명시 필요 |
| #113 | install stderr decode | **OPEN** | `commands/setup.md` 에 install stderr decode 처리 부재 |
| #238 | disable-model-invocation 문서 | **OPEN (docs)** | feature 자체는 9개 커맨드에 적용됨. 미흡한 것은 README 의 workaround 설명 — 코드 아닌 docs 갭 |

## 요약

- **FIXED (8)**: #312·#190·#289·#290·#314·#24/#311/#23 + A1 + A3 — handoff §5 B2 가 deferred 로 나열한 `#23 ANSI`·env sanitization·git `--end-of-options`·UTF-8 truncation 은 **이미 해결됨**. B2 목록에서 제거 대상.
- **PARTIAL (1)**: #250 — 상위 bound 존재, per-tool 세분화만 미구현. 우선순위 낮음.
- **OPEN (4)**: #59 state cross-rw / #75 permission-deny bridge / #113 install stderr decode / #238 docs — 진짜 미수정. 이것만 B2 후속 작업 대상.

## handoff ultraplan §5 B2 보정 권고

B2 의 deferred 후보 목록 `(#23 ANSI, #59, #75, #113, #238, #250)` →
**`#23` 제거(FIXED), `#250` PARTIAL 표기, 실제 OPEN 은 `#59·#75·#113·#238` 4건.**
