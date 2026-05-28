---
description: Run daily-evolve pipeline (Phase 0–6 — upstream PR/Issue + telemetry → Codex L3 triage → active fork research → daily digest → autonomous PR draft → scheduled-tasks MCP → self-evolve meta loop)
argument-hint: '[YYYY-MM-DD] [--skip-gh-api] [--phase 0|1|2|3|4|5] [--probe] [--self-evolve [--type weekly_normal] [--force]]'
allowed-tools: Bash(node:*)
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" daily-evolve "$ARGUMENTS"`

Daily-evolve pipeline 의 manual trigger. Phase 5 의 자동 routine (`scheduled-tasks` MCP, morning 9 KST + jitter) 와 동일 코드 경로 — 본 명령으로 즉시 검증 / 재실행 / debug 가능.

## Pipeline phases

| Phase | 동작 | 신규 산출물 |
|---|---|---|
| **0** (default) | source-aggregator → diff-analyzer → digest-writer. upstream `openai/codex-plugin-cc` open PR + Issue + recently closed (30d) + 우리 `events.jsonl` telemetry 수집 후 (verdict, signal_type) 분류, FIXED 3-evidence 룰 적용 | `docs/upstream-tracking/{date}/raw.json` + `docs/daily-evolve/{date}.md` |
| **1** | Phase 0 + Codex L3 triage (decision-triage profile, heuristic stub — actual Codex 호출은 Phase 1.5+) + decision_count metric + cost cap (baseline median × 3, last 7 FIFO) | digest header `Codex L3 Triage Summary` 박스 |
| **1.5a** (auto, Phase 1+ pre-flight) | Codex auth health check (`setup --json` parse). refresh token expired/revoked 시 routine 자체는 heuristic fallback 으로 degrade — 실패 X. 사용자가 digest `failures` 섹션 첫 줄 `⚠ Codex auth health: ...` 에서 인지 → `codex logout && codex login` 후 다음 routine 부터 자동 복구 | ledger `auth_health: {status, details}` 필드 (raw 제거 — PII 차단) |
| **2** | Phase 1 + active fork research (`gh api .../forks` + license filter + L7 weight adjustment + Top N=10 baseline → Top N=5 final, austerity mode N=3) + budget guard (default unlimited, env override `CODEX_PLUGIN_DAILY_EVOLVE_FORK_API_BUDGET`) | digest `Phase 2 Active Fork Research Summary` 박스 |
| **3** | Phase 2 + 7-source 완전 통합 (upstream PR/Issue/comments + fork research + telemetry + plugin marketplace + Codex CHANGELOG/release) + PII redact (email/token/path 누적 카운트) | digest `PII redacted: {n} hits` notice |
| **4** | Phase 3 + Action Executor + L5 협의 + dedupe + PR draft 후보 emit (autonomous-safe 만 자동 draft, needs-user 는 decision queue) | digest `Action Summary` 블록 + draft 후보 목록 |
| **5** | Phase 4 + env probe (`scheduled-tasks` MCP 등록 상태 + CRON_TZ + DST handling) | `state/daily-evolve-env-probe.json` |
| **6** (별도 mode: `--self-evolve`) | weekly meta-review — 누적 ledger 분석 + KPI 평가 + Phase 별 회귀 detection + 자동 rollback PR draft 후보. `--type` 으로 review 종류 명시 (`weekly_normal` default), `--force` 로 cool-down 우회 | `state/daily-evolve-self-evolve-log.json` |

## Flags

- `[YYYY-MM-DD]` — 명시 일자 (default = today UTC)
- `--skip-gh-api` — linked PR merge check 비활성 (offline / network 차단 환경)
- `--phase <N>` — 진입 phase (0-5, default 0). Phase 6 은 `--self-evolve` 별도 mode
- `--probe` — probe only (실제 routine 실행 안 함, env / state / lock 검사만)
- `--self-evolve` — Phase 6 meta-review mode 진입
  - `--type <weekly_normal|...>` — review type (default `weekly_normal`)
  - `--force` — cool-down 우회 (강제 실행)

## Output 위치

- raw: `docs/upstream-tracking/{date}/raw.json` (FULL git tracked, 사용자 결정 #1)
- digest: `docs/daily-evolve/{date}.md` (사용자 review 대상)
- run ledger: `state/daily-evolve-runs-{YYYY}.json` (append-only, atomic write)
- cost baseline: `state/daily-evolve-cost-baseline.json` (last 7 FIFO median)
- env probe: `state/daily-evolve-env-probe.json` (Phase 5+)
- self-evolve log: `state/daily-evolve-self-evolve-log.json` (Phase 6)

## 검증 출력

- 정상: `[daily-evolve] {date} done: {N} records, actionable={M}, digest=docs/daily-evolve/{date}.md`
- 부분 실패: stderr 에 `[daily-evolve] auth health: {status} — degrade={action}` + source error + exit 2
- 실패: stderr 에 `[daily-evolve] failure: {reason}` + exit 1

## 자동 routine

`scheduled-tasks` MCP 가 매일 morning 9 KST (`0 9 * * *` local TZ, jitter ~9분) Phase 5 모드로 자동 실행. opt-out: `CODEX_PLUGIN_DAILY_EVOLVE_DISABLED=1`.

Result 는 항상 사용자에게 verbatim 표시 (요약 금지 — digest 자체가 사용자 review 대상).
