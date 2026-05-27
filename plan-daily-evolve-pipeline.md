# Plan: daily-evolve-pipeline — 점진적 self-improving 플러그인 routine

> 날짜: 2026-05-27
> 상태: **구현 중 — Phase 0 코드 완료 (88 unit tests pass, branch `feat/daily-evolve-pipeline`)** — Codex pair R1-R7 0 수렴 완료. Phase 1+ 후속 진입 대기
> 입력: research.md + plan-upstream-backlog.md + Codex R1 (`ab98b16aa54ed2503`) + 사용자 결정 6건 + Codex R2 (`ab5d78973718d82de`) + Codex R3 (`aa10c014e8e3285b6`)

## 목표

매일 morning 9 KST 자동 Claude 루틴 (`scheduled-tasks` MCP, env probe 후) 으로 7-source 신호 수집 → Codex L3/L5/L7 협의 → daily digest md + autonomous-safe PR draft + needs-user 결정 queue. **routine 자체 매주 self-evolve** (사용자 review 후만 적용, FP baseline 1.5× 초과 시 자동 rollback PR draft). 진정한 self-improving plugin.

## 정의 제약 (forcing function)

**사용자 ≤30분 morning triage cognitive load 보호. full autonomy / fork code execution / Phase 6 자동 적용 끝까지 비범위. 변경 거부 기준: "30분 triage 악화 여부?" 체크박스 강제.**

## 접근법

**6 Component + 1 Bootstrap (Phase 5.0) + 1 Observability (run status ledger 신규 R3-M6)**

1. **Source Aggregator** — 7-source + UTC ISO + raw `docs/upstream-tracking/{YYYY-MM-DD}/` **FULL tracked**
2. **Diff/Gap Analyzer** — (verdict, signal_type) 2-축. **FIXED 좁힌 룰 + 검출 알고리즘 (R3-M2)** 참조 §`## FIXED 검출 알고리즘`
3. **Codex Triage L3** — `/opnd-codex:pair --output-profile decision-triage`. cost cap median × 3
4. **Daily Digest Writer L4** — `docs/daily-evolve/{YYYY-MM-DD}.md` + cognitive metadata + no_changes/failures/**run_status (R3-M6)** + citation pass
5. **Action Executor L5 (Phase 4)** — autonomous-safe → L5 협의 → 분기. L5 contract §`## L5/L7 Contract`
6. **Self-Evolve L6 (Phase 6)** — 매 7일 trigger + loop guard + **FP baseline rollback 알고리즘 (R3-H1)** 참조 §`## Phase 6 FP Baseline & Rollback`
7. **Run Status Ledger (R3-M6 신규)** — `state/daily-evolve-runs-YYYY.json` (run lifecycle metric)

## LLM 역할 분담 (L1~L7) — default (a)

| L | 단계 | LLM |
|---|---|---|
| L1 source parse | tool only |
| L2 verdict/signal_type 분류 | Claude main |
| L3 triage 3분류 | Codex (decision-triage) |
| L4 digest 작성 + citation | Claude main + `lib/citation-check.mjs` |
| L5 PR/needs-user/skip | Codex + machine-readable contract |
| L6 self-evolve review | **L6 trigger 분리 (R3-M4 + R4-M3)** — `self-evolve.mjs --type weekly_normal` (매 7일 auto) vs `--type monthly_self_change` (월 1회 + 사용자 explicit). 단일 entry point, 인자 dispatch |
| L7 fork ranking 조정 | Codex + machine-readable contract |

## L5/L7 Machine-Readable Contract

### L5 응답 schema (Phase 4)
```json
{
  "decision": "pr_draft | needs_user | skip",
  "rationale": "string (1-3 sentence)",
  "user_surface_value": "high | medium | low | none",
  "cost_units": "integer (normalized_cost_points)",
  "fallback_used": "boolean"
}
```
- `skip` + `user_surface_value ∈ {high, medium}` → digest **low-priority backlog 섹션** surface
- Invalid response (JSON parse fail / enum 불일치) → `{decision: "needs_user", rationale: "L5 invalid", fallback_used: true}` (fail-closed)

### L7 응답 schema (Phase 2)
```json
{
  "adjustment": "boost | demote | maintain | insufficient_info",
  "factor": "1.3 | 0.7 | 1.0 | 1.0",
  "rationale": "string",
  "cost_units": "integer (normalized_cost_points)"
}
```
- `insufficient_info` → `factor=1.0` + confidence low. baseline 유지
- N 축소 trigger: 누적 `cost_units > daily_cost_budget × 0.30` OR `fork 수 > 50` → N=10→3
- Invalid → `maintain` fallback + warning log

### `cost_units` 단위 정의 (R3-H3 + R4-M2 강화)

```
1 cost_unit = 1 normalized_cost_point
            = 1 short Codex turn (input ≤ 2000 tokens + output ≤ 500 tokens)

Profile Registry (lib/cost-profile-registry.mjs):
- decision-triage profile = 1 unit (fallback if usage 부재)
- plan-review profile = 3 units (input/output 더 큼)
- adversarial-review profile = 5 units
- gh API call = 0 unit (cost 무관, rate-limit 별도 카운트)

daily_cost_budget = 최근 7회 median × 3 (initial baseline = 20 units)
```

### Usage 측정 우선순위 (R4-M2 + R5-L1)
```
priority:
  1. Codex response 의 `usage.input_tokens` + `usage.output_tokens` 직접 사용
     actual_unit = max(1, ceil((input/2000) + (output/500)))  # R5-L1: 0-token 호출 시 min 1 보호
  2. usage 필드 부재 시: profile registry 의 fixed unit fallback
  3. profile 미등록 시: 1 unit conservative + warning log
```

### Registry validation (R4-M2 + R5-L2)
- 본 plugin 초기화 시 `lib/cost-profile-registry.mjs` 의 모든 profile 이 아래 schema 일치 검증:
  ```json
  {
    "name": "string (profile 식별자)",
    "fixed_unit": "integer ≥ 1",
    "description": "string",
    "input_token_baseline": "integer (예상 input)",
    "output_token_baseline": "integer (예상 output)"
  }
  ```
- Phase 0 검증 기준에 "profile registry schema validation test 1건" 추가
- 신규 profile 추가 시 registry update + test 추가 필수

## Phase 6 FP Baseline & Rollback (R3-H1 + R4-M1 강화)

### `actionable` 정의 (R4-M1)
```
actionable = digest 의 decision items 중 사용자가 accept/reject 결정 가능한 항목
           = autonomous_safe (PR draft 후 사용자 review) + needs_user (digest 결정 박스)
           ─ skip + (low/none) user_surface_value 는 제외
           ─ needs_claude_judgment 는 제외 (Claude 자체 처리 영역)
```

### FP baseline 측정
```
FP_rate(window) = (actionable 항목 중 사용자 reject) / (actionable 총 수)

baseline window = 적용 PR effective_at 이전 14일 누적
post window = 적용 PR effective_at 이후 7일 누적
both window 최소 actionable ≥ 10 (통계적 유의성)
```

### Disjoint attribution window (R4-M1 — race 방지)
```
각 적용 PR 에 effective_at 스냅샷 (merge timestamp) 기록 → self-evolve-log entry
복수 PR 동시 적용 시:
  - 같은 target (예: fork_ranking_weight) 의 PR 이 7일 window 안 겹치면 → 후속 PR 의 baseline = 앞 PR 의 post window
  - 다른 target 의 PR 은 독립적 측정 (disjoint window)
  - 같은 target + 14일 미경과 → 후속 PR 의 baseline window 부족 → rollback 트리거 보류 + 다음 cycle 까지 대기

attribution 알고리즘:
  for each completed_pr in self_evolve_log:
    # R5-M3 precondition — 미merge / pending / rejected / 이미 rollback 항목 attribution 제외
    if completed_pr.effective_at IS NULL: continue
    if completed_pr.decision != "accepted": continue
    if completed_pr.effective_at + 7d ≤ now AND post_actionable ≥ 10:
      baseline = aggregate(actionable, target, effective_at - 14d ~ effective_at)
      post     = aggregate(actionable, target, effective_at ~ effective_at + 7d)
      if post.fp_rate ≥ baseline.fp_rate × 1.5:
        create_rollback_pr(completed_pr.target, completed_pr.old_value)

# 14일 미경과 시 보류 카운트 한계 = 3 cycles (3주). 한계 초과 시 baseline window 부족으로 attribution skip + warning log
```

### Rollback action
- 자동 rollback PR draft 생성 (target weight/threshold 이전 값 복원)
- decision: pending → 사용자 review 후 accepted/rejected
- 적용 시: `self-evolve-log.json` 에 `rollback_target_review_id` 기록

### `state/daily-evolve-self-evolve-log.json` schema (R3-H1 + R4-M3)
```json
{
  "schema_version": 1,
  "entries": [
    {
      "review_id": "uuid",
      "review_type": "weekly_normal | monthly_self_change",
      "started_at": "ISO 8601 UTC",
      "ended_at": "ISO 8601 UTC",
      "effective_at": "ISO 8601 UTC | null (PR merge timestamp — attribution disjoint window 키)",
      "self_review_depth": 0,
      "inputs": {
        "digests_analyzed": ["YYYY-MM-DD", "..."],
        "routine_telemetry": { "exec_time_ms": [...], "codex_cost": [...], "fp_rate": [...], "triage_time_min": [...] }
      },
      "proposed_changes": [
        {
          "target": "fork_ranking_weight | fp_threshold | cost_cap_multiplier | digest_length_cap | dedupe_normalize_rule | self_evolve_*",
          "old_value": "...",
          "new_value": "...",
          "evidence": "..."
        }
      ],
      "pr_draft_url": "...",
      "decision": "pending | accepted | rejected | rollback",
      "rollback_target_review_id": "uuid | null"
    }
  ]
}
```

### Loop guard
- `self_review_depth` cap = 1 (Phase 6 가 Phase 6 자체 변경 review 는 +1)
- Phase 6 자체 변경 (e.g. weekly review 주기 변경) = 월 1회 + 사용자 explicit
- Recursive 진단: `self_review_depth > 0` AND `target == "self_evolve_*"` 검출 시 STOP + 사용자 알림

## Phase 5.0 — `scheduled-tasks` MCP Env Probe (R3-H2 + R4-H1 강화)

### Probe 결과 enum

```json
{
  "schema_version": 1,
  "probed_at": "ISO 8601 UTC",
  "scheduler_status": "UTC_AWARE | LOCAL_TZ_ONLY | MCP_UNAVAILABLE | UNKNOWN",
  "user_machine_tz": "Asia/Seoul | UTC | ...",
  "machine_offset_minutes": "integer (UTC 기준 offset, 예: KST=+540)",
  "probe_details": {
    "mcp_installed": "boolean",
    "mcp_cron_api_docs_found": "boolean",
    "cron_tz_supported": "boolean | null",
    "fallback_required": "boolean"
  }
}
```

### Decision Tree (R4-H1 신규)

```
1. probe `scheduled-tasks` MCP 설치 여부:
   - claude mcp list 또는 동등 API
   - 미설치 → scheduler_status = MCP_UNAVAILABLE → 종료
2. MCP 설치됨: cron timezone 지원 확인:
   - MCP docs / API spec 에서 CRON_TZ / timezone field 존재 여부 검사
   - 명확히 지원 → scheduler_status = UTC_AWARE → 종료
   - 명확히 미지원 (docs 에 local-only 명시) → scheduler_status = LOCAL_TZ_ONLY → 종료
   - 불명확 (docs 부재 또는 API 검출 실패) → scheduler_status = UNKNOWN → 사용자 confirm
```

### LOCAL_TZ_ONLY 변환식 (R4-H1)

```
KST 09:00 = UTC 00:00
target_machine_minutes = (0 × 60 + machine_offset_minutes) mod 1440
target_machine_hour = floor(target_machine_minutes / 60)
target_machine_min = target_machine_minutes mod 60
cron_expression = `${target_machine_min} ${target_machine_hour} * * *`

예시:
- 머신 TZ=Asia/Seoul (+540): target = (0+540) mod 1440 = 540 min = 09:00 → cron `0 9 * * *`
- 머신 TZ=UTC (0): target = 0 → cron `0 0 * * *`
- 머신 TZ=America/Los_Angeles (-480): target = (0-480+1440) mod 1440 = 960 = 16:00 → cron `0 16 * * *` (전날 KST 09:00)

DST 처리: KST 는 DST 없음. 단 사용자 머신이 DST 가 있는 TZ 면 봄/가을 전환 시 1 일 routine 시간 변동. 위험 요소로 등재.
```

### Phase 5 진입 branch
| scheduler_status | Phase 5 동작 |
|---|---|
| `UTC_AWARE` | `scheduled-tasks` MCP 등록 (cron `CRON_TZ=UTC 0 0 * * *`) — primary |
| `LOCAL_TZ_ONLY` | MCP 등록 (위 변환식 적용 cron) + alert 추가 + DST risk 위험 등재 |
| `MCP_UNAVAILABLE` | cron fallback primary (`scripts/daily-evolve/cron-fallback.sh`) + 사용자 설치 가이드 |
| `UNKNOWN` | 사용자 explicit confirm 필요 (BLOCKING) — digest `failures` 첫 줄 + 별도 알림 |

## FIXED 검출 알고리즘 (R3-M2 신규)

### CHANGELOG evidence (필수)
- CHANGELOG `Unreleased` 또는 latest version 블록에 issue ref (`#NNN`) 매칭
- "planned / documented / known issue / will fix" 패턴 reject (case-insensitive)

### 추가 evidence (다음 중 1+)
1. **touched implementation path** — issue body 의 키워드 → fork 코드 path grep → 최근 30일 commit 의 touched paths 와 intersection. ≥ 1 match
2. **test assertion** — 같은 issue ref `#NNN` 를 CHANGELOG 가 인용한 commit 의 test diff hunk 에 `assert.*` 또는 `expect.*` 추가됨. 단순 test 파일 변경만으로는 불충분
3. **linked PR merge** — CHANGELOG `#NNN` grep → `gh api repos/openai/codex-plugin-cc/pulls/NNN` 가 `merged: true` + `merged_at` 존재. fork 의 main branch ancestor 인지 확인

3개 중 1+ 충족 시 FIXED. 모두 미충족 시 PARTIAL 강등.

### Resolver 구현
```javascript
// lib/fixed-resolver.mjs
async function isFixed(issueRef, changelogMatch) {
  if (REJECT_PATTERNS.some(p => changelogMatch.match(p))) return { verdict: "PARTIAL", reason: "reject pattern" };
  const evidence = await Promise.all([
    checkTouchedPath(issueRef),
    checkTestAssertion(issueRef),
    checkLinkedPRMerge(issueRef)
  ]);
  return evidence.some(e => e === true)
    ? { verdict: "FIXED", evidence }
    : { verdict: "PARTIAL", reason: "no additional evidence" };
}
```

## Dedupe Key — normalized_title 알고리즘 (R3-M1 강화)

```javascript
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[　-〿＀-￯]/g, " ")    // CJK punctuation → 공백
    .replace(/\p{Emoji}/gu, "")                       // emoji strip (Unicode property)
    .replace(/[^\w\s가-힣]/g, "")                     // 나머지 punctuation
    .replace(/\b(pr|issue|#)\s*\d+\b/g, "")           // PR/Issue 번호
    .replace(/\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?(?:\+[0-9a-z.]+)?\b/g, "")  // semver + prerelease + build
    .replace(/\s+/g, " ")
    .trim();
}
```

**Collision testcase**:
- `"v2.0.0-rc.1 release"` ↔ `"v2.0.0 release"` → 동일 (`"release"`). 위험 — 같은 family release. signal_type=`release` 별도 처리
- CJK punctuation `"버그 수정、테스트"` → `"버그 수정 테스트"` 정규화
- Emoji `"🐛 fix race condition"` → `"fix race condition"`

## state Schema Migration 정책 (R3-H4 신규)

### 정책
- 모든 state JSON 에 `schema_version: integer` 필수
- 읽기 시 `schema_version` 검사:
  - 일치 → 정상
  - 낮음 → `lib/state-migrator.mjs` 의 migration runner 호출 (`v1→v2`, `v2→v3` chain)
  - 높음 → fail-closed (downgrade 차단)
- corrupt JSON → backup `${file}.corrupt-${ISO}.bak` + 새 file (`schema_version: latest`) 생성 + digest `failures` 알림

### state files
| 파일 | initial schema_version | migration sensitivity |
|---|---|---|
| `state/daily-evolve-pr-cache.json` | 1 | HIGH (dedupe_key 알고리즘 변경 시 rebuild 필요) |
| `state/daily-evolve-cost-baseline.json` | 1 | MEDIUM (cost_units 단위 변경 시 환산) |
| `state/daily-evolve-self-evolve-log.json` | 1 | HIGH (Phase 6 schema 변경 시) |
| `state/daily-evolve-env-probe.json` | 1 | LOW (probe 재실행으로 복구) |
| `state/daily-evolve-runs-YYYY.json` | 1 | LOW (append-only, append 호환만 보장) |

### Migration runner (R4-H2 — unknown entry fail-closed)
```javascript
// lib/state-migrator.mjs
const MIGRATIONS = {
  "daily-evolve-pr-cache": { 1: v => v, /* future: 2: v1ToV2 */ },
  // ...
};
const LATEST = {
  "daily-evolve-pr-cache": 1,
  // ...
};
function migrate(fileType, data) {
  if (!(fileType in MIGRATIONS) || !(fileType in LATEST)) {
    throw new Error(`state-migrator: unknown fileType "${fileType}" — routine abort. No backup created (avoid corruption).`);
  }
  const target = LATEST[fileType];
  if (data.schema_version > target) {
    throw new Error(`state-migrator: downgrade blocked (file v${data.schema_version} > LATEST v${target})`);
  }
  let current = data;
  for (let v = data.schema_version; v < target; v++) {
    if (typeof MIGRATIONS[fileType][v + 1] !== "function") {
      throw new Error(`state-migrator: missing migration ${fileType} v${v}→v${v + 1} — routine abort. Manual intervention required.`);
    }
    current = MIGRATIONS[fileType][v + 1](current);
  }
  return current;
}
```

**Fail-closed 룰 (R4-H2)**:
- unknown fileType → throw + routine abort (backup 생성 X — silent pass 차단)
- missing version entry → throw + routine abort
- downgrade (file v > LATEST) → throw + 차단
- corrupt JSON (parse fail) → backup `.corrupt-${ISO}.bak` + 새 file (LATEST schema_version) 생성 (별개 경로)

## Run Status Ledger (R3-M6 신규)

### `state/daily-evolve-runs-YYYY.json` schema

```json
{
  "schema_version": 1,
  "runs": [
    {
      "run_id": "uuid",
      "started_at": "ISO 8601 UTC",
      "ended_at": "ISO 8601 UTC | null",
      "duration_ms": "integer | null",
      "status": "running | success | failure | partial",
      "phase_reached": "0 | 1 | 2 | 3 | 4",
      "actionable_count": "integer",
      "decision_count": { "autonomous_safe": "N", "needs_user": "N", "needs_claude_judgment": "N" },
      "cost_units_consumed": "integer",
      "failure_reason": "string | null",
      "digest_file": "docs/daily-evolve/YYYY-MM-DD.md"
    }
  ]
}
```

- append-only (delete X)
- digest header 에 `last_3_runs` 요약 노출 (사용자가 routine 건강성 즉시 확인)
- Phase 6 가 `state/daily-evolve-runs-YYYY.json` 의 success rate / duration trend 도 telemetry input 으로 사용 (last 2 연도 머지)

### Atomic write + Rotation 알고리즘 (R4-M4)

**Atomic write** (mid-write read 방어):
```javascript
// lib/run-ledger.mjs
function appendRun(entry) {
  const file = `state/daily-evolve-runs-${entry.started_at.slice(0,4)}.json`;  // 연도별 분할
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const current = readOrInit(file);
  current.runs.push(entry);
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, file);  // POSIX atomic rename (Windows 도 NTFS rename atomic)
}
```

**Rotation** (yearly):
- 파일명 `state/daily-evolve-runs-YYYY.json` 으로 연도별 분할
- 새 연도 진입 시 새 파일 자동 생성 (이전 연도는 read-only — append X)
- 사용 시 latest 연도 파일 우선 읽기. 누적 통계 (Phase 6 baseline) 는 최대 last 2 연도 머지
- 기존 단일 `runs.json` → 첫 실행 시 `runs-YYYY.json` 으로 migrate (state-migrator)

**동시성**:
- Routine 자체가 단일 trigger (cron 1회/day) 라 동시 append 가능성 낮음
- 단 manual trigger + cron 겹침 가능 → atomic rename 으로 보호
- Read-during-write: rename 은 atomic 이라 partial state 노출 없음

## Active Forks Research

### Active 정의
- `pushed_at < 30일 (UTC ISO 엄격 <)` / `ahead_by ≥ 5` / `archived: false`
- `commit_author_diversity ≥ 2` / `non_vendor_diff_ratio ≥ 0.3`

### Ranking score
```
baseline_score = upstream_merge_recency × 0.30
               + matching_plugin_paths   × 0.25
               + unique_touched_paths    × 0.20
               + commit_author_diversity × 0.15
               + non_vendor_diff_ratio   × 0.10
```

### `matching_plugin_paths` 산식
- 기준 경로 집합: 우리 fork 의 `plugins/opnd-codex/{commands,agents,hooks,scripts,scripts/lib,prompts,schemas,skills}/**`
- 비교: fork last-30d commit touched paths normalize → intersection
- **Rename mapping (R3-L1 강화)**:
  ```javascript
  const RENAME_MAP = [
    { from: /^plugins\/codex\//, to: "plugins/opnd-codex/", effective_after: "2026-05-20T00:00:00Z" }
    // future legacy mappings here
  ];
  ```
  - effective_after 이후 commit 만 매핑 적용. 그 이전은 legacy 그대로
- score = `|intersection| / |기준 집합|` (0~1 정규화)

### API call budget ≤ 19/run

### Local static scan
- Node 내장 `fs/path/zlib/stream` + git CLI 허용. binary skip 1 MB / vendor / `*.min.*` / `*.lock`

### License check
Apache-2.0 / MIT / BSD-2/3-Clause 만 통과

## L4 Citation Check 구현 spec (R3-M3)

### `lib/citation-check.mjs` input/output
```javascript
// input: digest markdown draft + citation array
// citation: { agentId, line_ref, quoted_text }
// output: { passed: boolean, failures: [{ citation, reason }] }

function checkCitation({ agentId, line_ref, quoted_text }) {
  // 1. agentId 존재 검증 — codex transcript registry (state/codex-sessions/) 조회
  // 2. line_ref 의 transcript 라인 byte-level 일치 (UTF-8, 100%)
  // 3. line drift 시 (transcript 가 변경됨): fuzzy match 80% 이상 + warning
  // fail-closed: 검증 실패 인용은 digest 에서 strip + 경고
}
```

## 변경 파일

| 파일 | 변경 | 설명 |
|---|---|---|
| `plugins/opnd-codex/scripts/daily-evolve/source-aggregator.mjs` | 신규 | 7-source |
| `.../diff-analyzer.mjs` | 신규 | 2-축 + FIXED resolver |
| `.../codex-triage.mjs` | 신규 | L3 + cost cap (units) |
| `.../digest-writer.mjs` | 신규 | L4 + metadata + citation + last_3_runs header |
| `.../action-executor.mjs` | 신규 (Phase 4) | L5 contract |
| `.../self-evolve.mjs` | 신규 (Phase 6) | FP baseline + rollback + loop guard |
| `.../env-probe.mjs` | 신규 (Phase 5.0) | scheduler_status enum + branch |
| `.../lib/fork-ranking.mjs` | 신규 | baseline + L7 + matching_plugin_paths + rename map |
| `.../lib/fork-tarball.mjs` | 신규 | tarball + scan |
| `.../lib/verdict-schema.mjs` | 신규 | 2-축 enum |
| `.../lib/dedupe-key.mjs` | 신규 | normalized_title (R3-M1 강화) |
| `.../lib/triage-metric.mjs` | 신규 | cognitive metric |
| `.../lib/pii-redact.mjs` | 신규 | mask |
| `.../lib/llm-router.mjs` | 신규 | L1~L7 + L5/L7 contract validator |
| `.../lib/citation-check.mjs` | 신규 (R3-M3) | agentId + line_ref + byte match |
| `.../lib/fixed-resolver.mjs` | 신규 (R3-M2) | FIXED 3-evidence resolver |
| `.../lib/state-migrator.mjs` | 신규 (R3-H4) | schema migration runner + corrupt backup |
| `.../lib/run-ledger.mjs` | 신규 (R3-M6 + R4-M4) | `runs-YYYY.json` append + last_N query + atomic rename + yearly rotation |
| `.../lib/cost-profile-registry.mjs` | 신규 (R4-M2 + R5-L2) | profile schema validation + fixed_unit fallback |
| `plugins/opnd-codex/commands/daily-evolve.md` | 신규 | trigger |
| `plugins/opnd-codex/skills/daily-evolve/SKILL.md` | 신규 | 가이드 |
| `docs/daily-evolve/{YYYY-MM-DD}.md` | 신규 output **tracked** | digest |
| `docs/daily-evolve/_weekly/{YYYY-Www}.md` | 신규 output **tracked** | Phase 6 weekly |
| `docs/upstream-tracking/{YYYY-MM-DD}/raw.json` | 신규 state **tracked** | raw |
| `docs/upstream-tracking/tarball-cache/` | 신규 state **gitignore** | binary |
| `state/daily-evolve-pr-cache.json` | 신규 state **tracked** + weekly squash | 7d dedupe (schema v1) |
| `state/daily-evolve-cost-baseline.json` | 신규 state **tracked** | median (schema v1) |
| `state/daily-evolve-self-evolve-log.json` | 신규 state **tracked** | Phase 6 (schema v1) |
| `state/daily-evolve-env-probe.json` | 신규 state **tracked** | Phase 5.0 probe (schema v1) |
| `state/daily-evolve-runs-YYYY.json` | 신규 state **tracked** **R3-M6** | run ledger (schema v1) |
| `.gitignore` | 수정 | `docs/upstream-tracking/tarball-cache/` |
| `tests/daily-evolve/*.test.mjs` | 신규 | 각 component mock |
| `tests/daily-evolve/fixtures/llm/` | 신규 (R3-L3) | LLM fixture matrix (invalid JSON / timeout / cost cap / citation drift) |
| `plugins/opnd-codex/CHANGELOG.md` | 수정 | Unreleased |
| `scheduled-tasks` MCP 등록 (Phase 5) | 신규 | morning 9 KST |

### Lib dependency rule
- `lib/*` = pure (filesystem/network/LLM 금지)
- Orchestrator only = side effect 허용
- Circular dep 금지
- Unit test: lib = pure, orchestrator = mock fs/fetch/LLM router

## 구현 단계

### Phase 0 — PoC
- [ ] 0.1 `lib/verdict-schema.mjs`
- [ ] 0.2 `source-aggregator.mjs` UTC ISO
- [ ] 0.3 `diff-analyzer.mjs` + **`lib/fixed-resolver.mjs` (R3-M2)** + reject pattern
- [ ] 0.4 `digest-writer.mjs` + `lib/citation-check.mjs` (R3-M3) + `lib/run-ledger.mjs` (R3-M6 last_3_runs header)
- [ ] 0.5 `commands/daily-evolve.md`
- [ ] 0.6 `companion.mjs handleDailyEvolve`
- [ ] 0.7 tests + **fixture matrix (R3-L3)**
- [ ] 0.8 dry-run ≥ 10회, FP_rate < 30%, actionable ≥ 5
- [ ] 0.9 lib dep rule 회귀
- [ ] **0.10 `state/daily-evolve-runs-YYYY.json` append-only + atomic rename + yearly rotation testcase** (R3-M6 + R4-M4)
- [ ] **0.11 `lib/state-migrator.mjs` + corrupt backup + unknown filetype throw + downgrade block testcase** (R3-H4 + R4-H2)
- [ ] **0.12 `lib/cost-profile-registry.mjs` schema validation test** (R4-M2 + R5-L2)

### Phase 1 — Codex L3
- [ ] 1.1 `codex-triage.mjs`
- [ ] 1.2 `lib/triage-metric.mjs`
- [ ] 1.3 digest 3분류
- [ ] 1.4 cost cap (units 환산)
- [ ] 1.5 skip taxonomy

### Phase 2 — Active Fork + L7
- [ ] 2.1 `lib/fork-ranking.mjs` baseline + **rename mapping table (R3-L1)**
- [ ] 2.2 `lib/fork-tarball.mjs`
- [ ] 2.3 License check
- [ ] 2.4 API ≤ 19/run
- [ ] 2.5 L7 contract + N=3 trigger
- [ ] 2.6 dry-run ≥ 10회

### Phase 3 — 7-source
- [ ] 3.1 `lib/pii-redact.mjs`
- [ ] 3.2 `MEMORY-DRIFT`
- [ ] 3.3 `UNRELEASED-GAP`
- [ ] 3.4 `TODO-STALE`
- [ ] 3.5 `UX-IMPROVEMENT`

### Phase 4 — L5
- [ ] 4.1 `action-executor.mjs` + `lib/dedupe-key.mjs` (R3-M1 강화 regex)
- [ ] 4.2 L5 contract + invalid fallback + skip-with-value digest surface
- [ ] 4.3 weekly squash: **매 일요일 02:00 KST (토 17:00 UTC), 대상 = `pr-cache.json` 만, non-rewrite (R3-M5)**
- [ ] 4.4 PR body schema
- [ ] 4.5 5 PR cap + draft only

### Phase 5.0 — Env Probe (BLOCKING)
- [ ] 5.0.1 `env-probe.mjs` — scheduler_status enum 산출 (UTC_AWARE/LOCAL_TZ_ONLY/MCP_UNAVAILABLE/UNKNOWN)
- [ ] 5.0.2 머신 TZ probe (date -u vs date)
- [ ] 5.0.3 `state/daily-evolve-env-probe.json` 기록
- [ ] 5.0.4 **enum 별 Phase 5 분기 (R3-H2)** — 변경 시 digest `failures` alert

### Phase 5 — Schedule
- [ ] 5.1 scheduler_status 별 등록:
  - UTC_AWARE → `CRON_TZ=UTC 0 0 * * *`
  - LOCAL_TZ_ONLY → 머신 TZ 기준 09:00 cron + alert
  - MCP_UNAVAILABLE → cron fallback primary
  - UNKNOWN → 사용자 explicit confirm BLOCKING
- [ ] 5.2 task body
- [ ] 5.3 cron fallback 문서
- [ ] 5.4 failure recovery
- [ ] 5.5 opt-out env

### Phase 6 — Self-Evolve
- [ ] 6.1 `self-evolve.mjs` 매 7일 weekly normal review (R3-M4 trigger 분리)
- [ ] 6.2 routine telemetry 수집 (`runs-YYYY.json` + self-evolve-log + cost-baseline 입력)
- [ ] 6.3 L6 호출 순서: Claude draft → Codex critique → Claude patch → 사용자 review
- [ ] 6.4 weekly report
- [ ] 6.5 heuristic 조정 PR draft (autonomous-safe 밖)
- [ ] 6.6 **FP baseline rollback 알고리즘 (R3-H1)** — 14d baseline / 7d post / min 10 actionable / auto rollback PR
- [ ] 6.7 Loop guard: depth ≤ 1 / monthly self-change + 사용자 explicit / Recursive STOP
- [ ] 6.8 self-evolve-log.json schema 준수

## 비범위

- 자동 PR merge / Multi-user / Slack/Discord / fork code execution / GitHub Issue 자동 / 본 plugin 외 toolkit / non-en/ko NLP / npm dep / Self-evolve 자동 적용 / Phase 6 recursive 무한 review / tarball binary tracked

## 트레이드오프

R1+R2+R3 적용 후 결정 사항 — 사용자 결정 잔존 4건 (LLM 옵션 + R3 신규 3건) 외 모두 채택.

## 위험 요소

- Fork ranking FP (HIGH-1): 강화 + L7
- API rate (HIGH-2): ≤19/run
- PR spam (HIGH-3 + R2-M1 + R3-M1): dedupe + normalized + L5
- Token cost: median × 3 + cost_units (R3-H3)
- Cognitive overload: metric + 500줄 + 10 decision
- Memory PII: pii-redact
- digest spam: no_changes/failures/run_status 분리
- False-FIXED: 3-evidence (R3-M2)
- 자동화 실패 silent: failures + `runs-YYYY.json` (R3-M6)
- MCP 의존 + TZ: env probe enum branch (R3-H2)
- Repo bloat: weekly squash 일요일 02:00 KST (R3-M5) + 500 MB LFS
- Timezone: opt-out
- Self-evolve drift: loop guard + auto rollback (R3-H1)
- L7 cost 폭증: top 10 → N=3 trigger
- Verdict/signal 혼동: schema migration runner (R3-H4)
- 무npm: zero npm + git CLI
- L5/L7 invalid response: fail-closed
- L4 citation: citation-check (R3-M3)
- Phase 6 recursive: loop guard
- lib circular dep: rule + source-level 가드
- **state corrupt (R3-H4)**: backup + new file + alert
- **rename mapping miss (R3-L1)**: effective_after 명시 + legacy 그대로
- **DST seasonal drift (R5-M1)**: LOCAL_TZ_ONLY 의 변환식이 probe 시점 offset 으로 cron 고정 → DST TZ (예: America/New_York) 의 봄/가을 전환 시 1 시간 drift. mitigation: env probe 가 DST 인식 TZ 라면 매월 1회 자동 reprobe (또는 사용자 명시 reprobe)
- **migration throw → digest 경로 (R5-M2)**: orchestrator 가 migration error catch → `state/daily-evolve-runs-YYYY.json` 의 entry `status=failure` + `failure_reason ∈ {unknown_filetype, missing_migration, downgrade_blocked, corrupt_json}` + digest `failures` 섹션 첫 줄 알림. Routine 은 abort (다음 trigger 까지 대기, 사용자 수동 intervention 필요)

## 검증 기준 *(Sprint Contract)*

> "구현해" = 합의. 각 Phase: "30분 triage 악화?" 체크박스

### Phase 0
- [ ] mjs 4 + verdict-schema + citation-check + fixed-resolver + run-ledger + state-migrator
- [ ] digest md 동작
- [ ] dry-run ≥ 10회, FP_rate < 30%, actionable ≥ 5
- [ ] FIXED 3-evidence testcase (touched path / test assertion / linked PR 각 1+ 통과, commit message 단독 reject) (R3-M2)
- [ ] `runs-YYYY.json` append + last_3_runs header (R3-M6)
- [ ] state-migrator corrupt backup testcase (R3-H4)
- [ ] LLM fixture matrix (invalid JSON / timeout / cost cap / citation drift) (R3-L3)
- [ ] tests 통과 + CHANGELOG + lib dep 회귀
- [ ] 30분 triage 체크

### Phase 1
- [ ] 3분류 / metadata / cost cap (units 환산 R3-H3) / 체크

### Phase 2
- [ ] active testcase / API ≤ 19 / License / L7 contract (insufficient_info + N=3) / matching_plugin_paths + **rename mapping testcase (R3-L1)** / dry-run ≥ 10 / 체크

### Phase 4
- [ ] L5 contract testcase / dedupe normalized + semver prerelease testcase (R3-M1) / weekly squash 일요일 02:00 + non-rewrite testcase (R3-M5) / PR body / 5 cap + draft

### Phase 5.0 (BLOCKING)
- [ ] env-probe enum 산출 (R3-H2) / 머신 TZ probe / json 기록 / 변경 시 digest alert

### Phase 5
- [ ] scheduler_status 별 등록 branch testcase / 7일 trigger / failures / fallback 문서 / opt-out

### Phase 6
- [ ] 매 7일 trigger / weekly report / heuristic PR draft only
- [ ] self-evolve-log schema 준수
- [ ] **FP baseline rollback algorithm (R3-H1)** — 14d/7d window + 1.5× + min 10 actionable + auto PR draft testcase
- [ ] Loop guard testcase (depth/monthly/recursive STOP)
- [ ] L6 trigger 분리 testcase (weekly normal vs monthly self-change) (R3-M4)

## 사용자 결정 잔존 (R3 신규 3 + R2 잔존 1 = 4건)

1. **(R2-U1)** LLM 분담 — default (a). 명시 시 (b)/(c)/(d)
2. **(R3-UD1) CRON_TZ 미지원 시 (LOCAL_TZ_ONLY/MCP_UNAVAILABLE)** — timezone-aware API only 까지 기다릴지 vs OS cron fallback primary 로 승격할지
3. **(R3-UD2) routine status UI** — daily digest 의 last_3_runs header 만 유지 vs `/opnd-codex:daily-evolve status` 별도 명령
4. **(R3-UD3) Phase 6 rollback PR 생성 기준** — FP 1.5× 자동 draft 생성 vs 자동 draft 전 사용자 confirm 추가

## 참조 코드
- research.md / plan-upstream-backlog.md / codex-efficiency-report.mjs / CLAUDE.md 5섹션 / docs/backlog/upstream-imported.md

## Codex Critique 적용 audit trail

### R1 (`ab98b16aa54ed2503`): 11 finding 모두 ✅
### R2 (`ab5d78973718d82de`): 11 finding 모두 ✅
### R3 (`aa10c014e8e3285b6`) — HIGH 4 / MEDIUM 6 / LOW 3 / User Decision 3

| Finding | 적용 위치 | Status |
|---|---|---|
| R3-H1 FP baseline / rollback algorithm | `## Phase 6 FP Baseline & Rollback` + Phase 6.6 + Phase 6 검증 기준 | ✅ |
| R3-H2 env probe enum + branch | `## Phase 5.0` 강화 + Phase 5 branch testcase | ✅ |
| R3-H3 cost_units 단위 | `## L5/L7 Contract` + 환산표 | ✅ |
| R3-H4 schema migration | `## state Schema Migration 정책` + `lib/state-migrator.mjs` + Phase 0.11 | ✅ |
| R3-M1 semver prerelease + CJK | normalize regex 강화 + collision testcase | ✅ |
| R3-M2 FIXED 검출 알고리즘 | `## FIXED 검출 알고리즘` + `lib/fixed-resolver.mjs` + Phase 0.3 | ✅ |
| R3-M3 citation-check spec | `## L4 Citation Check 구현 spec` | ✅ |
| R3-M4 L6 trigger 분리 | LLM 역할 분담 표 L6 + Phase 6.1 | ✅ |
| R3-M5 weekly squash schedule | Phase 4.3 — 일요일 02:00 KST + non-rewrite | ✅ |
| R3-M6 run status ledger | `## Run Status Ledger` + `state/daily-evolve-runs-YYYY.json` + `lib/run-ledger.mjs` + Phase 0.10 | ✅ |
| R3-L1 rename mapping 시점 | `## Active Forks Research` RENAME_MAP + effective_after | ✅ |
| R3-L2 env-probe alert 도착지 | Phase 5.0.4 — digest `failures` 고정 | ✅ |
| R3-L3 mock fixture matrix | `tests/daily-evolve/fixtures/llm/` + Phase 0.7 | ✅ |
| R3-UD1/2/3 User Decision | 잔존 결정 4건으로 surface | ✅ |

### R3 합의 영역 (R2 10건 + R3 5건 = 15건)
- L5 fail-closed needs_user / skip-with-value digest backlog / L6 기본 순서 / Phase 5.0 BLOCKING 순서 / lib-orchestrator 경계 방향성

### R4 (`a844883d09f401cf2`) — HIGH 2 / MEDIUM 4 / LOW 3 / User Decision 1

| Finding | 적용 위치 | Status |
|---|---|---|
| R4-H1 env probe decision tree + LOCAL_TZ_ONLY 변환식 | `## Phase 5.0` decision tree + 변환식 + DST 위험 등재 | ✅ |
| R4-H2 schema migration unknown entry fail-closed | `## state Schema Migration 정책` migration runner — throw + abort | ✅ |
| R4-M1 actionable 정의 + PR attribution disjoint window | `## Phase 6 FP Baseline & Rollback` actionable + disjoint attribution + effective_at | ✅ |
| R4-M2 cost_units profile registry + usage fallback | `## L5/L7 Contract` profile registry + usage 우선순위 + validation | ✅ |
| R4-M3 L6 review_type CLI + log field | LLM 역할 분담 L6 `--type` + Phase 6 schema `review_type` 필드 | ✅ |
| R4-M4 runs.json atomic + rotation | `## Run Status Ledger` atomic rename + yearly 분할 + 동시성 | ✅ |
| R4-L1/L2/L3 (수용 가능) | 합의 확정 — 추가 변경 없음 | ✅ |
| R4-UD1 state file bootstrap 전략 | 잔존 결정 5건으로 surface | ✅ |

### R4 합의 영역 (R3 15건 + R4 3건 = 18건)
- FIXED gh API cost = 0 unit / weekly squash timing 충돌 없음 / L5/L7 strict brittleness fail-closed 보호 방향

### R5 (`ab738a7af498acb99`) — **HIGH 0** / MEDIUM 5 / LOW 2 / User Decision 2

| Finding | 적용 위치 | Status |
|---|---|---|
| R5-M1 DST drift 위험 등재 | `## 위험 요소` 새 항목 추가 + reprobe mitigation | ✅ |
| R5-M2 migration throw → digest failures 경로 | `## 위험 요소` 새 항목 + orchestrator catch + failure_reason enum | ✅ |
| R5-M3 effective_at + decision precondition | `## Phase 6 FP Baseline & Rollback` attribution 알고리즘 precondition + 보류 카운트 3 cycle 한계 | ✅ |
| R5-M4 cost-profile-registry 변경 파일 / Phase 0 누락 | 변경 파일 표 + Phase 0.12 추가 | ✅ |
| R5-M5 runs.json 파일명 통일 | replace_all `state/daily-evolve-runs-YYYY.json` 전 섹션 동기화 | ✅ |
| R5-L1 actual_unit=0 edge case | `## L5/L7 Contract` `max(1, ceil(...))` 명시 | ✅ |
| R5-L2 Registry schema 필드 정의 | `## L5/L7 Contract` Registry validation 명시 (name/fixed_unit/description/input_token_baseline/output_token_baseline) | ✅ |
| R5-UD1 needs_claude_judgment 별도 metric | 잔존 결정 surface | ✅ |
| R5-UD2 1 cost_unit 절대 비용 (token vs 화폐) | 잔존 결정 surface | ✅ |

### R5 합의 영역 (R4 18건 + R5 7건 = 25건)
- env probe predicate 순서 구현 가능 / unknown filetype throw + abort 명확 / downgrade throw 동작 / L6 `--type` CLI + log field / runs ledger 연도 UTC slice 명확 / disjoint window 실제 disjoint (재사용 아님) / needs_claude_judgment 제외는 FP 범위 정의로 valid

### R6 (`a1d816025e80ae65f`) — pass-through. HIGH 0 / MEDIUM 1 / LOW 0

| Finding | 적용 위치 | Status |
|---|---|---|
| R6-M5 (R5-M5 회귀) — bare `runs.json` 4건 잔존 | line 379/569/595/621 모두 `state/daily-evolve-runs-YYYY.json` 또는 `runs-YYYY.json` 으로 normalize (line 400 backward-compat reference + audit trail 인용 보존) | ✅ |

## 사용자 결정 잔존 (R3 4건 + R4 1건 + R5 2건 = 7건) — **Default 적용 (implement 진입 시점)**

> 사용자가 `/goal plan-daily-evolve-pipeline.md` directive 로 implement 명시 — 잔존 결정 7건 모두 default 채택. 후속 Phase 진입 시 사용자가 명시 override 가능.

| # | 결정 | **Default 채택** | 이유 |
|---|---|---|---|
| 1 | **(R2-U1)** LLM 분담 | **(a)** L3+L5+L6+L7=Codex / L2+L4=Claude main | 작업 유형별 최적, CLAUDE.md 정합, cost 분산 |
| 2 | **(R3-UD1)** CRON_TZ 미지원 fallback | **env-probe 결과 분기 그대로** — UTC_AWARE→MCP / LOCAL_TZ_ONLY→MCP+alert / MCP_UNAVAILABLE→cron primary / UNKNOWN→사용자 confirm | 모든 환경 cover, 가장 robust |
| 3 | **(R3-UD2)** routine status UI | **digest header `last_3_runs` 만** (별도 명령 없음) | 단순성 — 단일 surface, 별도 명령은 cognitive load 증가 |
| 4 | **(R3-UD3)** Phase 6 rollback PR 기준 | **FP 1.5× 자동 draft 생성** (auto-merge X, 사용자 review) | Self-evolve 자체가 사용자 review 후 적용이므로 draft 자동 생성도 안전 |
| 5 | **(R4-UD1)** state file bootstrap 전략 | **Phase 별 lazy create** | 단순성, 일괄 생성 시 unused 파일 누적 |
| 6 | **(R5-UD1)** needs_claude_judgment 별도 metric | **도입 안 함** (FP 측정에서 제외만 유지) | 단순성, 후속 phase 에서 필요 시 추가 |
| 7 | **(R5-UD2)** cost_unit 절대 비용 | **token-normalized 만** (USD/원화 환산 X) | 단순성, plan 의 cost_units 단위 (1 short turn = 1 unit) 그대로 |

## Annotation Cycle — 🎉 0 수렴 도달

### Codex pair 7라운드 수렴 trend
| Round | Total findings | HIGH | MEDIUM | LOW | User Decision |
|---|---|---|---|---|---|
| R1 (blind) | 11 | 3 | 5 | 2 | 1 |
| R2 (adversarial) | 11 | 3 | 5 | 2 | 1 |
| R3 (substrate 신규) | 13 | 4 | 6 | 3 | 3 |
| R4 (좁은 follow-up) | 7 | 2 | 4 | 3 (수용) | 1 |
| R5 (좁은 follow-up) | 7 | **0** | 5 | 2 | 2 |
| R6 (pass-through) | 1 | 0 | 1 (회귀) | 0 | 0 |
| **R7 (수렴 판단)** | **0** | **0** | **0** | **0** | 0 |

### R7 (`a5dc525ef112b5781`) — **수렴 도달**
- bare `runs.json` 4건 normalize 완료 확인
- 잔존 히트 4건 모두 BACKWARD_COMPAT / AUDIT_TRAIL (보존 정당)
- **HIGH 0 / MEDIUM 0 / LOW 0**
- Codex 판정: **"수렴 도달 — implement 진입 가능"**

### `/goal` 만족 — stop hook auto-clear 예상

### 사용자 결정 잔존 7건 (사용자 영역 — plan critique 와 별도)

1. (R2-U1) LLM 분담 — default (a) implicit 진입 가능
2. (R3-UD1) CRON_TZ 미지원 시 fallback 정책
3. (R3-UD2) routine status UI
4. (R3-UD3) Phase 6 rollback PR 기준
5. (R4-UD1) state file bootstrap 전략
6. (R5-UD1) needs_claude_judgment 별도 metric
7. (R5-UD2) cost_unit 절대 비용

### Implement 진입 옵션 (사용자 선택)

| 옵션 | 의미 |
|---|---|
| **(A) "구현해" 즉시** (Recommended) | default (a) LLM 분담 + Phase 5/Phase 6 진입 시 잔존 결정 6건 surface. Phase 0 PoC 부터 진행 |
| **(B) 사용자 결정 7건 먼저 답변** | implement 진입 전 모든 결정 답변 → 가장 정확한 spec |
| **(C) 사용자 결정 일부만 답변 + 진입** | Phase 0 진입에 필수인 결정만 답변 (예: R4-UD1 state bootstrap) → 나머지는 후속 Phase 결정 |
