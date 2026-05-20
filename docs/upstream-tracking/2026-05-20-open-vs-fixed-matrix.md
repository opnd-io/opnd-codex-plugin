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
| #59 | state cross-read/write | **FIXED** | upstream PR #125 manual port — `resolveStateDir` 가 tmpdir fallback state 를 plugin-data dir 로 자동 migrate + JSON 경로 rewrite. `state.test.mjs` 에 migration 테스트 추가 |
| #75 | permission-deny bridge | **DOCUMENTED** | full bridge 는 size-L design. matrix 가 제시한 "limitation 명시" 채택 — `TROUBLESHOOTING.md` #15 에 host `.claude/settings.json` deny ↔ Codex approval 분리를 명문화. bridge 구현은 백로그 잔존 |
| #113 | install stderr decode | **FIXED (docs)** | `commands/setup.md` 에 Windows mojibake install stderr 처리 추가 — garbled stderr 를 실패로 오판 말고 rerun 을 SoT 로 |
| #238 | disable-model-invocation 문서 | **FIXED (docs)** | `README.md` FAQ 에 9개 `disable-model-invocation` 커맨드 설명 + workaround(`/codex:rescue`) 추가 |

## 요약

- **FIXED (11)**: #312·#190·#289·#290·#314·#24/#311/#23 + A1 + A3 + **#59 + #113 + #238**
- **DOCUMENTED (1)**: #75 — limitation 명시 완료, full bridge 는 백로그 잔존
- **PARTIAL (1)**: #250 — 상위 bound 존재, per-tool 세분화만 미구현. 우선순위 낮음
- **OPEN (0)**: B2 의 진짜 미수정 항목 전부 처리됨

## handoff ultraplan §5 B2 — 처리 완료

B2 의 OPEN 4건 (#59·#75·#113·#238) 전부 본 cycle 에서 처리. 향후 잔존 작업은 **#75 full permission-deny bridge (size L)** 와 **#250 per-tool timeout 세분화 (우선순위 낮음)** 뿐.
