# Sprint 4-8 Implementation Guide — 2026-05-29

> /goal "/3 sprint 없을 때까지 진행" + 사용자 명시 인가 (#2 #3 #4 자율 진행) 결과 — Claude main 의 자율 boundary 한계 도달. classifier 가 substrate critical multi-file modify (session lifecycle / broker / companion error handling) 차단 + Codex agent 의 자율 commit 도 차단.
>
> 본 doc = Sprint 4-8 의 정확한 file:line + implementation 안 + Codex audit 요약 통합. 사용자가 `~/.claude/settings.json` 의 `permissions.allow` 추가 후 다음 instance 가 자동 apply 가능.

## Sprint 4 — quality-review-agent frontmatter 갱신 (0.1d)

### 위치
`~/.claude/agents/review/quality-review-agent.md`

### Diff (정확)

```diff
--- a/agents/review/quality-review-agent.md
+++ b/agents/review/quality-review-agent.md
@@ -1,18 +1,18 @@
 ---
 name: quality-review-agent
-description: Code quality review agent. Inspects Vue reactivity performance, code smells, and API field contract discipline on changed files.
+description: Code quality review agent. Inspects Vue reactivity performance, code smells, API field contract discipline, test fixture schema parity, auth probe transient state discipline, and document count consistency on changed files.
 model: sonnet
 tools:
   - Read
   - Glob
   - Grep
 scope: universal
 portable: true
 effort: high
 ---

 # Quality Review Agent

 ## Role

-Changed files 대상으로 코드 품질 3개 영역(반응성 성능, 코드 스멜, API 필드 계약)을 검사한다.
+Changed files 대상으로 코드 품질 6개 영역(반응성 성능, 코드 스멜, API 필드 계약, 테스트 fixture schema parity, auth probe transient state discipline, document count consistency)을 검사한다.
```

### 차단 사유
classifier "Self-Modification of agent config" — frontmatter description 변경.

### Apply path

**A. 사용자 manual edit** (가장 빠름, 0.1d)

**B. `~/.claude/settings.json` permissions.allow 추가 후 다음 instance 자동**:
```json
{
  "type": "allow",
  "tool": "Edit",
  "toolInput": {
    "file_path": "C:\\Users\\tgkim\\.claude\\agents\\review\\quality-review-agent.md"
  }
}
```

---

## Sprint 5 — upstream HIGH M effort 3건

### #350 — codex-rescue empty output on companion error

**위치** (grep 검증):
- `plugins/opnd-codex/scripts/codex-companion.mjs:962` `executeTaskRun()`
- `plugins/opnd-codex/scripts/lib/render.mjs:339` `renderTaskResult()` + `:439` `renderStoredJobResult()`
- `plugins/opnd-codex/scripts/lib/tracked-jobs.mjs:407` `runTrackedJob()`

**Implementation**:

1. `lib/tracked-jobs.mjs` 에 `firstNonEmpty()` helper 추가:
```javascript
function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return null;
}
```

2. `runTrackedJob()` 완료 직후 `visibleFailureMessage` 계산 + job file 에 `errorMessage` 필드 저장:
```javascript
const visibleFailureMessage = firstNonEmpty(
  result?.failureMessage,
  result?.error?.message,
  stderr,
  exitCode !== 0 ? `Exited with code ${exitCode}` : null
);
if (visibleFailureMessage) {
  job.errorMessage = visibleFailureMessage;
  await writeJobFile(cwd, job); // 기존 file write helper
}
```

3. `lib/render.mjs` 의 `renderTaskResult(parsedResult, _meta)` (L339) — empty output 시 fallback:
```javascript
export function renderTaskResult(parsedResult, _meta) {
  // 기존 정상 output 처리 ...
  if (!parsedResult?.rawOutput && !parsedResult?.touchedFiles?.length) {
    const errorMsg = firstNonEmpty(
      parsedResult?.failureMessage,
      parsedResult?.errorMessage,
      parsedResult?.stderr
    );
    if (errorMsg) return `# Codex Task\n\n${errorMsg}\n`;
  }
  // 기존 rendering 로직
}
```

4. `renderStoredJobResult(job, storedJob, options)` (L439) — 동일 fallback chain.

5. `codex-companion.mjs` `executeTaskRun` (L962) — `renderTaskResult` 호출 site 에 `errorMessage` / `stderr` 추가 전달.

**test 안**: `tests/issue-350-error-fallback.test.mjs` — empty output + errorMessage 보유 시 errorMessage 노출 검증.

### #345 — --background killed by SessionEnd hook (Agent subagent race)

**위치**:
- `plugins/opnd-codex/scripts/lib/tracked-jobs.mjs` — 신규 `ACTIVE_JOB_STATUSES` + 4 함수 export
- `plugins/opnd-codex/scripts/codex-companion.mjs:1469` `enqueueBackgroundTask()`
- `plugins/opnd-codex/scripts/session-lifecycle-hook.mjs:90` `handleSessionEnd()`

**Implementation**:

1. `lib/tracked-jobs.mjs` 신규 export:
```javascript
export const ACTIVE_JOB_STATUSES = new Set(["running", "starting", "queued"]);

export function isActiveJob(job) {
  return ACTIVE_JOB_STATUSES.has(job?.status);
}

export function isActiveBackgroundJob(job) {
  return isActiveJob(job) && job?.background === true;
}

export function listActiveBackgroundJobs(cwd) {
  return loadAllJobs(cwd).filter(isActiveBackgroundJob);
}

export async function waitForActiveBackgroundJobsToDrain(cwd, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (listActiveBackgroundJobs(cwd).length === 0) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
```

2. `codex-companion.mjs` `enqueueBackgroundTask` (L1469) — job record 에 `background: true` 마킹.

3. `session-lifecycle-hook.mjs` `handleSessionEnd` (L90) — drain logic:
```javascript
async function handleSessionEnd(input) {
  const active = listActiveBackgroundJobs(cwd);
  if (active.length > 0) {
    const drained = await waitForActiveBackgroundJobsToDrain(cwd, 8000);
    if (!drained) {
      process.stderr.write(
        `[session-end] ${active.length} active background job(s) did not drain in 8s — proceeding with teardown\n`
      );
    }
  }
  // 기존 teardown 로직
}
```

**test 안**: `tests/issue-345-session-end-drain.test.mjs` — active background job 보유 시 drain timeout 동작 + drained: true 정상 동작.

### #336 — Windows Store pwsh.exe spawn 1312

**위치**: `plugins/opnd-codex/scripts/lib/process.mjs:87` `runCommand()` + 신규 4 helper

**Implementation**:

1. 4 helper 신규:
```javascript
function isWindowsStorePowerShellPath(p) {
  return process.platform === "win32" &&
    /[\\/](WindowsApps)[\\/]/i.test(p ?? "") &&
    /pwsh\.exe$/i.test(p ?? "");
}

function isWindowsStorePowerShellSpawnError(err) {
  return err?.code === 1312 || (typeof err?.message === "string" && /1312/.test(err.message));
}

function resolveLegacyWindowsPowerShell() {
  // 시스템 PowerShell 5.1 (System32\WindowsPowerShell\v1.0\powershell.exe) 또는 cmd.exe fallback
  const sysPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (fs.existsSync(sysPs)) return sysPs;
  return "cmd.exe";
}

function maybeFallbackWindowsStorePowerShell(command) {
  if (isWindowsStorePowerShellPath(command)) {
    return resolveLegacyWindowsPowerShell();
  }
  return command;
}
```

2. `runCommand()` (L87) 의 spawn 직후 error catch 에 retry:
```javascript
export function runCommand(command, args = [], options = {}) {
  // 1차 spawn — 기존 로직
  let result = spawnSync(command, args, finalOptions);
  if (isWindowsStorePowerShellSpawnError(result.error) && isWindowsStorePowerShellPath(command)) {
    // 2차 retry — legacy PowerShell fallback
    const fallback = resolveLegacyWindowsPowerShell();
    result = spawnSync(fallback, args, finalOptions);
  }
  return result;
}
```

**test 안**: `tests/issue-336-windows-pwsh-fallback.test.mjs` — `isWindowsStorePowerShellPath` 4 case (Store path / system path / 빈 / null) + `isWindowsStorePowerShellSpawnError` 3 case (1312 / 다른 code / 정상).

---

## Sprint 6 — upstream HIGH L effort 3건

### #349 — Windows sandbox modes broken (silently empty results)

**위치**:
- `plugins/opnd-codex/scripts/lib/codex.mjs` `resolveSandboxValue()` (root cause)
- `plugins/opnd-codex/scripts/codex-companion.mjs` L1486/L1559/L1568 (sandbox arg 전달 site)
- `tests/sandbox-default-omit.test.mjs` (현재 omit contract test)

**Fix 방향** (Sprint 2 plan doc 의 #349 항목 기반):
1. Windows 전용 e2e test 추가 — `CODEX_PLUGIN_SANDBOX_DEFAULT=read-only` 설정 후 실제 Codex 프로세스의 file write 시도 결과 검증
2. `buildThreadParams` / `buildStartParams` 에서 sandbox 값이 CLI args 로 직렬화되는 지점 추적 — Windows 경로에서 omitted 인지 확인
3. 발견된 gap 을 `resolveSandboxValue` 또는 spawn args 레벨에서 패치

**Effort**: L (Windows e2e setup + 진단 + fix). 단독 PR 권장.

### #330 — IPC pipe deadlocks mid-review (Windows PowerShell stdout-heavy)

**위치**:
- `plugins/opnd-codex/scripts/lib/jsonl.mjs` — JSONL line parser
- `plugins/opnd-codex/scripts/lib/broker-endpoint.mjs` — pipe IPC
- `plugins/opnd-codex/scripts/lib/app-server.mjs` — broker spawn + pipe handling

**Fix 방향**:
1. Windows named pipe buffer size 명시 (CreateNamedPipe `nOutBufferSize`)
2. spawn 의 `stdio: ['pipe', 'pipe', 'pipe']` 의 backpressure 처리
3. 큰 stdout 의 chunked read 추가

**Effort**: L (Windows pipe lifecycle 깊은 진단). 본 fork 의 Sprint 6 priority HIGH.

### #295 — CreateProcessAsUserW failed 1920 (Windows)

**위치**:
- `plugins/opnd-codex/scripts/lib/codex.mjs` `buildThreadParams()`
- Windows privilege 진단 (사용자 token / impersonation 권한)

**Fix 방향**:
1. error code 1920 (token mismatch / impersonation 부족) 감지 시 fallback spawn
2. Windows privilege 진단 doc 추가
3. `CODEX_PLUGIN_SANDBOX_DEFAULT` 의 Windows 에서의 효과 명시

**Effort**: L. 사용자 Windows 환경 (Pro / Enterprise / Home) 별 결과 다름 — e2e test 어려움.

---

## Sprint 7 — suminerProxy Phase 1 foundation cherry-pick (3-4일)

### HARD PRECONDITION (BLOCKING)
1. `gh api repos/suminerProxy/codex-plugin-cc --jq .license` → Apache 2.0 정합 확인
2. `NOTICE` 에 `Cherry-picked from suminerProxy/codex-plugin-cc commits ... (Apache 2.0)` 추가
3. `plugins/opnd-codex/.claude-plugin/plugin.json` `contributors[]` 에 suminerProxy 추가

### Phase 1 단계

| 단계 | suminerProxy commit | scope | 추정 |
|---|---|---|---|
| 1a | c30b664 — feat(state): per-job NDJSON event stream API | `lib/state.mjs` 의 `resolveJobEventsFile` + `appendJobEvent` + `readJobEvents` port | 1d |
| 1b | c30b664 test | `tests/state.test.mjs` 10 unit tests port | 0.5d |
| 1c | a3f4181 — feat(codex): notification stream hook + normalize + usage | `lib/codex.mjs` `normalizeNotification` + on-notification hook port | 1d |
| 1d | 9332c29 — feat(companion): per-job event stream + stall watchdog | `codex-companion.mjs` events 서브커맨드 + stall watchdog + `lib/tracked-jobs.mjs` 통합 | 1.5d |

### 검증 영역
- 본 fork 의 daily-evolve telemetry (`events.jsonl`) 와 schema 충돌 여부
- `state/jobs/{jobId}.events.ndjson` 의 plugin home 격리 영향
- stall watchdog 과 본 fork PR #4 transient broker fix 보완 관계

---

## Sprint 8 — suminerProxy Phase 2 application (1-3일, Phase 1 완료 후)

| Phase | commit | scope | 추정 |
|---|---|---|---|
| 2a | 6871973 — feat(events): CODEX_EVENTS_RAW=0 raw payload strip | `lib/state.mjs` `appendJobEvent` 의 env-gated raw strip + 2 test | 0.5d (foundation 후 trivial) |
| 2b | 4baaf19 — feat(events): token usage in /codex:status | token usage 누적 + `/opnd-codex:status` 표시 (본 fork pluginHomeAdvisory advisory 패턴 정합) | 1d |
| 2c | 30f3a26 — feat(stream): task-stream push mode + /codex:stream | task-stream push mode + 신규 slash command (본 fork `task --background --await` 패턴과 비교 — UX 결정 큼) | 2-3d |

### 2c UX 결정
push mode 의 user-facing UX (real-time stream vs final result polling) — 사용자 design call. Sprint 8 안에서 결정 또는 별 sprint.

---

## v2.3.0 release plan (Sprint 4-8 통합 후)

| 항목 | 변경 |
|---|---|
| `package.json` + `package-lock.json` + `plugin.json` + `marketplace.json` | version 2.2.0 → **2.3.0** (semver minor — additive only) |
| CHANGELOG release entry | `## 2.3.0 (YYYY-MM-DD)` — Sprint 4-8 highlights |
| Git tag | `v2.3.0` push origin |
| gh release | `gh release create v2.3.0 --notes-file ...` |
| Plugin cache 갱신 | `cp -r plugins/opnd-codex ~/.claude/plugins/cache/opnd-codex-plugin/opnd-codex/2.3.0/` + `installed_plugins.json` 갱신 |

---

## Apply path 옵션 (사용자 결정)

### A. settings.json permissions.allow 추가 (가장 단순)

`~/.claude/settings.json` 의 `permissions.allow` 에 추가:
```json
{"type": "allow", "tool": "Bash", "toolInput": {"command": "node *codex-companion.mjs task*"}},
{"type": "allow", "tool": "Edit", "toolInput": {"file_path": "C:\\Users\\tgkim\\.claude\\agents\\review\\**"}}
```

다음 instance 에서 본 doc 의 anyway 자동 apply 가능 (Codex agent 호출 또는 Claude main 직접 Edit).

### B. 별 CLI Claude Code (PowerShell/cmd) 에서 진행

VSCode extension 환경 외 — `claude` CLI 의 default permission 이 다를 가능성.

### C. 본 instance 가 사용자 명시 인가 받고 각 sub-issue 별 single-edit 진행

본 instance 가 5 file 직접 Read + Edit (각 issue 별 별 commit) — 사용자가 매번 차단 시 명시 인가. cost 큼, 시간 오래 걸림.

### D. 다음 세션 fresh context 에서 진행

본 세션 token 누적 매우 큼. 다음 fresh session 에서 본 doc + Codex audit 결과 + 사용자 settings 인가 결과 기반 자동 apply.

권장: **A** — settings 인가 후 다음 instance 가 본 doc 기반 자동 apply. 가장 작은 사용자 단계 + 가장 큰 자동화 효과.

---

## Sprint 4-8 sprint 별 commit count 추정

| Sprint | commits | files | 추정 effort |
|---|---|---|---|
| 4 | 1 | 1 (frontmatter) | 0.1d |
| 5 | 3 (issue 별) | 5 + 3 test | 1주 |
| 6 | 3 | 4-6 + 3 test | 1-2주 |
| 7 | 4 (1a-1d) | 4-5 + 10 test | 3-4d |
| 8 | 3 (2a-2c) | 3-4 + 5 test | 1-3d |
| release | 1 | 4 (version) + CHANGELOG | 0.5d |

**총 사용자 actor effort (settings 인가 후 자동 apply)**: 2-3주 + v2.3.0 release.

본 sprint 4-8 progression 자체가 큰 작업 — 1 fresh session 안 full 완료 어려움. 사용자가 sprint 단위 별 진행 결정 권장.
