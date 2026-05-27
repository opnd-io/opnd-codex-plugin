---
description: Run daily-evolve pipeline (Phase 0 PoC — upstream PR/Issue + telemetry aggregation → diff analysis → daily digest md)
argument-hint: '[YYYY-MM-DD] [--skip-gh-api] [--phase 0]'
allowed-tools: Bash(node:*)
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" daily-evolve "$ARGUMENTS"`

Daily-evolve pipeline 의 manual trigger. Phase 5 자동 (`scheduled-tasks` MCP, morning 9 KST) 진입 전엔 본 명령으로 PoC 동작 검증.

**Phase 0 동작 (현재)**:

1. `scripts/daily-evolve/source-aggregator.mjs` — upstream `openai/codex-plugin-cc` 의 open PR + Issue + recently closed (30d) + 우리 `events.jsonl` telemetry 수집. `docs/upstream-tracking/{YYYY-MM-DD}/raw.json` 에 저장 (FULL tracked).
2. `scripts/daily-evolve/diff-analyzer.mjs` — (verdict, signal_type) 2-축 분류. `FIXED` 는 **CHANGELOG 매칭 (필수) + 3 추가 evidence (touched path / test assertion / linked PR merge) 중 1+** 동시 충족 룰 (R3-M2).
3. `scripts/daily-evolve/digest-writer.mjs` — `docs/daily-evolve/{YYYY-MM-DD}.md` 생성. Cognitive load metadata header + `no_changes` / `failures` / Tier queue.

**Output 위치**:
- raw: `docs/upstream-tracking/{date}/raw.json`
- analyzed: 메모리 (Phase 0 에선 별도 파일 X)
- digest: `docs/daily-evolve/{date}.md`

**Flags**:
- `--skip-gh-api`: linked PR merge check 비활성 (offline / network 차단 환경)
- `--phase <N>`: 명시 Phase 진입 (default 0)

**검증 출력**:
- 정상: `[daily-evolve] {date} done: {N} records, actionable={M}, digest=docs/daily-evolve/{date}.md`
- 부분 실패: stderr 에 source error + exit 2
- 실패: stderr 에 `[daily-evolve] failure: {reason}` + exit 1

Phase 1+ 에서 Codex L3 triage (decision-triage profile) 통합, Phase 2 에서 active fork ranking + L7, Phase 4 에서 autonomous PR draft + L5 협의, Phase 5 자동화, Phase 6 self-evolve 추가.

Result 는 항상 사용자에게 verbatim 표시 (요약 금지 — digest 자체가 사용자 review 대상).
