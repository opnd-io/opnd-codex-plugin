# Upstream HIGH Issue Port Plan — Sprint 2 (2026-05-28)

Branch: `chore/sprint-2-upstream-port-2026-05-28`

Sprint 1(PR #7)에서 comment body 8건 등록 완료.
Sprint 2 = trivial fix 2건 apply(#331, #333) + 나머지 M/L effort 6건 plan 문서화.

---

## 이미 적용 완료 (본 branch)

| Issue | 제목 | 적용 파일 |
|-------|------|-----------|
| #331  | taskkill /PID MSYS path translation | `scripts/lib/process.mjs` L168, `tests/process.test.mjs` |
| #333  | adversarial-review focus text flag leak | `scripts/lib/args.mjs` (parseReviewArgv 추가), `scripts/codex-companion.mjs` L1536 |

---

## 미적용 6건 — M/L Effort Plan

### #350 codex-rescue empty output on error

**제목**: codex-rescue returns empty string when Codex exits with error

**위치 후보**:
- `plugins/opnd-codex/scripts/lib/render.mjs` — renderResult, formatTaskOutput
- `plugins/opnd-codex/scripts/lib/tracked-jobs.mjs` — job terminal state mapping
- `plugins/opnd-codex/agents/codex-rescue.md` — output surface 규약

**추정 Effort**: M

**우선순위**: HIGH

**Fix 방향**: Codex CLI가 non-zero exit code로 종료할 때 companion은 현재 빈 문자열이나 최소 로그만 반환한다. `renderResult`가 `result.stderr`를 조건부로만 노출(`if (stderr)`)하므로 stderr 전용 실패의 경우 사용자에게 아무 정보도 전달되지 않는다. Fix: (1) non-zero exit code 경로를 별도 failure payload 구조로 분리, (2) `render.mjs`에 fallback 블록 추가 — exit code 비제로 + stdout 비어있으면 stderr 전체를 응답 앞에 삽입, (3) `tracked-jobs.mjs`의 terminal state 판정에 stderr-only 케이스 명시. retry path가 있다면 첫 실패 payload를 버퍼링 후 모든 retry 소진 시 마지막 payload 반환.

---

### #349 Windows broken sandbox modes

**제목**: Sandbox modes (read-only / workspace-write) do not apply on Windows

**위치 후보**:
- `plugins/opnd-codex/scripts/lib/codex.mjs` — `resolveSandboxValue`, `buildThreadParams`, `buildStartParams`
- `plugins/opnd-codex/scripts/codex-companion.mjs` — `--sandbox` arg 전달 site (L1486, L1559, L1568) — root cause 는 위 lib/codex.mjs 의 `resolveSandboxValue`
- `tests/sandbox-default-omit.test.mjs` — 현재 sandbox omit contract test

**추정 Effort**: M

**우선순위**: HIGH

**Fix 방향**: `resolveSandboxValue`는 env `CODEX_PLUGIN_SANDBOX_DEFAULT` fallback을 읽지만 Windows에서 sandbox 값이 Codex CLI에 실제 전달되는지 end-to-end 미검증. Fix: (1) Windows 전용 e2e test 추가 — `CODEX_PLUGIN_SANDBOX_DEFAULT=read-only` 설정 후 실제 Codex 프로세스의 file write 시도 결과 검증, (2) `buildThreadParams` / `buildStartParams`에서 sandbox 값이 CLI args로 직렬화되는 지점 추적 — Windows 경로에서 생략되는지 확인, (3) 발견된 gap을 `resolveSandboxValue` 또는 spawn args 레벨에서 패치.

---

### #345 SessionEnd kills broker while --background job is still running

**제목**: SessionEnd hook terminates broker and kills active background Codex tasks

**위치 후보**:
- `plugins/opnd-codex/scripts/session-lifecycle-hook.mjs` — SessionEnd 분기 (L92~L118)
- `plugins/opnd-codex/scripts/lib/broker-lifecycle.mjs` — `sendBrokerShutdown`
- `plugins/opnd-codex/scripts/lib/tracked-jobs.mjs` — active/running job 목록 조회
- `plugins/opnd-codex/scripts/lib/state.mjs` — job state persistence

**추정 Effort**: M

**우선순위**: HIGH

**Fix 방향**: 현재 SessionEnd는 broker에게 shutdown 신호를 보낸 뒤 `terminateProcessTree`로 강제 종료한다. `--background`로 큐된 active Codex task가 있으면 broker 종료로 해당 task도 강제 종료된다. Fix: (1) SessionEnd 진입 시 `tracked-jobs.mjs`에서 `running` 상태 job 목록 조회, (2) active job이 0개면 기존 경로 그대로 shutdown, (3) active job이 1개 이상이면 shutdown defer — broker를 살려두고 `detached: true` 상태로 분리, (4) 모든 active job terminal state 달성 시 broker 자동 종료. hook timeout(5s)이 너무 짧아 defer를 hook 안에서 완료하기 어렵다면 broker에 "graceful drain" API를 추가하고 hook은 그 신호만 보내는 2단계 방식 검토.

---

### #336 CreateProcessAsUserW error 1312 (Windows Store pwsh.exe)

**제목**: Broker spawn fails with CreateProcessAsUserW error 1312 when PowerShell is installed from Windows Store

**위치 후보**:
- `plugins/opnd-codex/scripts/lib/broker-lifecycle.mjs` — `spawnBrokerProcess`
- `plugins/opnd-codex/scripts/lib/codex.mjs` — Codex CLI 실행 경로
- `plugins/opnd-codex/scripts/lib/process.mjs` — `runCommand` Windows 분기

**추정 Effort**: L

**우선순위**: MEDIUM

**Fix 방향**: Windows Store로 설치된 pwsh.exe는 AppContainer 내부에서 실행되므로 `CreateProcessAsUserW`가 1312(ERROR_NO_SUCH_LOGON_SESSION)를 반환한다. Fix: (1) `which pwsh` 결과가 `%LOCALAPPDATA%\Microsoft\WindowsApps\` 경로면 Store 버전으로 판정, (2) `C:\Program Files\PowerShell\*\pwsh.exe` glob으로 non-Store 후보 탐색, (3) 없으면 `cmd.exe` fallback (이미 #331에서 taskkill에 적용한 패턴 재사용), (4) 진단 메시지에 1312 error code와 Store-pwsh 원인 명시. Spike: `spawnBrokerProcess`는 `process.execPath`(node)를 사용하므로 broker 자체는 pwsh 미사용 — 1312가 발생하는 정확한 호출 지점을 upstream issue 재현 리포트에서 확인 후 좁혀야 함.

---

### #330 IPC pipe deadlocks mid-review (Windows)

**제목**: Named pipe between app-server and broker deadlocks mid-review on Windows

**위치 후보**:
- `plugins/opnd-codex/scripts/lib/app-server.mjs` — review 결과 pipe 전송
- `plugins/opnd-codex/scripts/app-server-broker.mjs` — broker side pipe 수신
- `plugins/opnd-codex/scripts/lib/broker-endpoint.mjs` — endpoint write/read
- `plugins/opnd-codex/scripts/lib/jsonl.mjs` — JSONL framing / backpressure

**추정 Effort**: L

**우선순위**: HIGH

**Fix 방향**: Windows named pipe는 reader가 pipe buffer를 드레인하지 않으면 writer가 block되고, 양쪽이 서로 기다리는 교착 상태가 발생한다. mid-review에서 발생한다는 것은 첫 JSONL frame 이후 큰 payload가 pipe buffer를 채울 때라는 뜻이다. Fix: (1) `jsonl.mjs`에 write backpressure 감지 추가 — `writable.write()` 반환값이 false면 `drain` 이벤트 대기, (2) `app-server.mjs`의 review 결과 스트리밍 경로에 chunk 분할 — 단일 대형 JSON을 JSONL로 분할 전송, (3) watchdog timer 추가 — N초 이상 pipe 미응답 시 양쪽 모두 timeout error로 abort + 로그, (4) `broker-endpoint.mjs`의 read 루프에 `setImmediate`/`process.nextTick` 삽입 — event loop 기아 방지. Spike: Windows에서 최대 pipe buffer 크기 실측 후 chunk size 결정.

---

### #295 CreateProcessAsUserW error 1920 (Windows sandbox)

**제목**: Sandbox spawn fails with CreateProcessAsUserW error 1920 on Windows

**위치 후보**:
- `plugins/opnd-codex/scripts/lib/codex.mjs` — `buildThreadParams`, `buildStartParams` sandbox 전달
- `plugins/opnd-codex/scripts/codex-companion.mjs` — sandbox option 전달 경로
- `plugins/opnd-codex/scripts/lib/process.mjs` — subprocess spawn

**추정 Effort**: L

**우선순위**: MEDIUM

**Fix 방향**: 1920(ERROR_PRIVILEGE_NOT_HELD)는 `CreateProcessAsUserW`가 `SE_ASSIGNPRIMARYTOKEN_PRIVILEGE` 또는 `SE_INCREASE_QUOTA_PRIVILEGE` 없이 호출될 때 반환된다. Fix 방향 두 가지: (A) Windows에서 sandbox 모드를 명시 호출했을 때 사용자에게 권한 부족을 명확히 진단 — 1920 error를 "Windows sandbox 미지원: SE_ASSIGNPRIMARYTOKEN_PRIVILEGE 필요" 메시지로 전환, (B) Codex CLI 업스트림 수정 — Windows에서 job object + restricted token으로 sandbox 대체 (L effort 큰 범위). 단기 Fix: `resolveSandboxValue`에서 Windows + sandbox 조합 감지 시 warning log + sandbox 값을 omit하는 safe fallback (기존 PR-2.1의 omit 패턴 확장).

---

## 우선순위 요약

| Issue | Effort | Priority | Next Action |
|-------|--------|----------|-------------|
| #330  | L      | HIGH     | pipe deadlock spike — Windows pipe buffer 실측 |
| #345  | M      | HIGH     | tracked-jobs active check 후 broker drain API |
| #350  | M      | HIGH     | render.mjs failure payload 분기 |
| #349  | M      | HIGH     | Windows sandbox e2e test 후 gap 식별 |
| #336  | L      | MEDIUM   | Store pwsh 감지 후 non-Store fallback |
| #295  | L      | MEDIUM   | Windows sandbox 권한 진단 + safe omit fallback |

Priority 기준: HIGH = Windows에서 기능 완전 실패 / 데이터 손실 위험. MEDIUM = 특정 환경에서만 발생, workaround 존재.

---

*작성: 2026-05-28, branch: chore/sprint-2-upstream-port-2026-05-28*
