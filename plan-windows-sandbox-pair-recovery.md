# ULTRA PLAN — Windows `windows sandbox: spawn setup refresh` / `/pair` 복구

> 작성 2026-06-11 · Claude + Codex 페어 (rescue 경로 우회 — `/pair` 가 본 버그로 깨져 있어 pairing 은 rescue 로 진행) · 검증 종합 §6
> 결정 SoT: 사용자 합의 (memory `feedback-codex-pair-decision-surfacing`) — 결정 포인트는 §7 자기완결 블록 참조

## 0. Executive Summary

- **증상**: Windows 에서 Codex 호출이 `windows sandbox: spawn setup refresh` 로 실패 → 한 줄도 실행 못 함. 세션 중 `/pair` Round 1 사망. (본 ULTRA PLAN 작성 중 Codex 도 shell 실행 시 **3회 동일 재현**.)
- **Root cause (Claude+Codex Agreed 5/5)**: ① codex-cli **0.134.0** 의 Windows read-only/workspace-write 샌드박스가 spawn 실패 (CLI 결함, Layer 1). ② 플러그인 `handlePair` 가 `--read-only` 를 자동 주입 (Layer 2, 유일하게 남은 자동 read-only pin). danger-full-access 만 정상 동작하는 호스트에서 read-only 강제 → Layer 1 발동.
- **신규 결정 증거**: codex 릴리스 노트 — `sandbox setup refresh` 가 0.136~0.138 에서 **집중 수정 대상**. 0.136 이 `codex sandbox setup --elevated` 프로비저닝 추가. → **Path A(업데이트+프로비저닝) 승산 HIGH**.
- **권장 시퀀스**: **A 먼저(가역 probe) → 실패 시에만 B → 그동안 C 를 stopgap**. Path A 성공 시 플러그인 변경 0 + `/pair` read-only 안전 유지한 채 전 경로 복구.
- **Codex 핵심 반론(채택)**: A 가 고쳐도 **영구 무조건 win32 guard(B-lite) 추가 금지** — "Windows = read-only 없음"을 normalize 하는 건 defense 가 아니라 **안전 회귀**. B 가 필요하면 version-gated/opt-in + 명시 경고로.

---

## 1. Root Cause (검증 완료 — §6 Agreed 5/5)

### Layer 1 — codex-cli 0.134.0 (근본)
codex-cli 0.134.0 의 Windows read-only/workspace-write 샌드박스가 **spawn 자체 실패** → `windows sandbox: spawn setup refresh`. 이 호스트에서 정상 동작하는 유일 모드 = `danger-full-access`(샌드박스 미spawn). 근거: `plugins/opnd-codex/CHANGELOG.md:7` + Codex 의 라이브 재현 3회.

### Layer 2 — `handlePair` 의 read-only 강제 (트리거)
```js
// codex-companion.mjs:1996-1997 (handlePair)
if (!argvHasOption(...,"sandbox") && !...("write") && !...("read-only")) {
  nextArgv.unshift("--read-only");          // pair 는 무조건 read-only
}
```
arg flow (Codex 추적): `handlePair:1997` → `resolveSandbox:1709-1710` `sandbox="read-only"` → `1766 effectiveSandbox = sandbox ?? null` → `1872 sandbox: effectiveSandbox` → `executeTaskRun:991 request.sandbox ?? (...)` → **request.sandbox 가 non-null "read-only" 라 `?? null` fix 무력** → Layer 1 발동.

### 패턴 진단
**paired-consumer half-migration** 재발 (CLAUDE.md 기록 패턴). #12/#14 omit 마이그레이션이 3 consumer(review/task/continue)는 옮겼으나 `handlePair` 가 남은 4번째. Codex 확인: **다른 자동 read-only pin 없음** (handlePair:1997 이 유일 — REJECTED other pins, conf 0.9).

### 부수 사실
- 스크린샷 이전 진단(line 965)은 캐시 **2.2.0**(pre-fix) grep — fix 이전 버전. 캐시에 2.2.0/2.2.1/2.2.2 공존.
- `/analyze` codex-rescue 11분 후 `process_died` 는 본 버그와 **무관** (rescue 는 omit 경로라 샌드박스 정상; 별개 장시간-investigation/watchdog 추정).

---

## 2. 신규 증거 — codex 릴리스 노트 (Path A 실현성)

설치 0.134.0 / 최신 stable **0.139.0** (gh release 확인). `windows sandbox: spawn setup refresh` 의 정확한 용어가 active 수정 대상:

| 버전 | Windows sandbox 관련 (직접 인용) |
|---|---|
| 0.136.0 | **`codex sandbox setup --elevated` 프로비저닝 신설** + "allowed Windows sandbox implementations" 요건 (#24831,#23766). 부수: reused refresh-token 재로그인(#23546) |
| 0.137.0 | "Windows SQLite startup, thread resume, **and sandbox setup refreshes**" 신뢰성 개선 (#25485,#25490,#25509,#25949) |
| 0.138.0 | #26471 "**Improve Windows sandbox setup refresh diagnostics**" + #26074 "Windows setup marker as completion signal" |
| 0.139.0 | #27068 `/debug-config` 가 effective sandbox modes 표시(검증 도구) + sandbox 승인 보존 |

**해석**: 에러가 "프로비저닝 미완"일 가능성 — 0.136 이 `codex sandbox setup --elevated` 를 추가했고(0.134 엔 그 명령조차 없음), 0.137/0.138 이 setup refresh 신뢰성/진단을 개선. 보너스: 0.136 의 refresh-token 수정이 별개 plugin-home auth staleness 도 완화.

---

## 3. Fix 경로 벤치마킹 (Codex scored — §6 Cross-validation)

| Path | 근본성 | Effort | read-only 안전 | Blast radius | Durability | Reversibility | 잔여위험 | **Score** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| **A**. codex 0.134→0.139 (+`sandbox setup --elevated`) | 5* | 4 | 5 | 2 | 3 | 4 | 5*/2 | **28*** |
| **B**. 플러그인 win32 guard (handlePair) | 2 | 4 | **1** | 4 | 4 | 5 | 2 | 22 |
| **C**. 무변경 — /pair 대신 /rescue | 1 | 5 | 1 | 5 | 2 | 5 | 1 | 20 |

\* "if fixed" — §2 릴리스 노트로 fixed 확률 HIGH 로 상향.

- **A**: 근본 fix. 성공 시 플러그인 0 변경 + read-only 안전 보존 + 전 경로 복구. 약점 = global npm 변경(Desktop/타 repo/타 플러그인 영향), fix 미확정(probe 필요).
- **B**: workaround. **read-only 안전 1점** — Windows /pair 가 danger-full-access(full access) 상속 → pair 의도 위반. Layer 1 미해결(다른 forced-non-danger 경로 여전히 깨짐).
- **C**: fix 아님, 트리거 회피. blast 0 이나 /pair UX gap 지속, rescue 도 read-only 아님(기존 동작).

---

## 4. 권장 시퀀스 (Claude+Codex 합의)

1. **Path A 먼저 — 가역 probe**: codex 0.139 업데이트 → (필요시) `codex sandbox setup --elevated` admin 프로비저닝 → read-only/workspace-write smoke test → `/pair` 재시도. **통과 시 여기서 종료** (플러그인 변경 없음, read-only 안전 보존).
2. **Path C 를 즉시 stopgap**: A 검증 전/실패 시 Windows 에선 `/opnd-codex:rescue` 사용 (omit→danger 상속, 동작).
3. **Path B 는 A 실패/불가 시에만** + **명시 경고**. 단 ⬇.

### Codex 핵심 반론 (채택 — Disagree 해소: 보수적 판단 우선)
> **A 가 Layer 1 을 고쳐도 영구 무조건 win32 guard(B-lite) 추가 금지.** platform-only guard 는 CLI 가 healthy 해진 뒤에도 Windows /pair 안전을 silently 강등 → defense 가 아니라 **안전 회귀**.

따라서 B 가 불가피하면 그 형태는:
- ❌ 무조건 `process.platform==="win32"` → read-only skip (안전 회귀 normalize)
- ✅ **version-gated** (codex 가 known-broken 버전일 때만) 또는 **explicit opt-in** (`--no-sandbox`/사용자 동의) + **loud 경고** + healthy 해지면 자동 해제

내 예비 랭킹은 "A+B 방어심화"를 2위로 뒀으나, Codex 의 안전 논거가 더 타당 → **B-lite 영구화 폐기**.

---

## 5. 실행 절차 + 검증 게이트

### Path A (probe) — BLOCKING: 사용자 동의 필요 (global 변경)
```bash
# 1) 현재 핀 백업 (가역성)
codex --version                      # 0.134.0 확인
# 2) 업데이트
npm install -g @openai/codex@0.139.0
codex --version                      # 0.139.0 확인
# 3) Windows sandbox 프로비저닝 (0.136+ 신규, admin PowerShell 필요할 수 있음)
codex sandbox setup --elevated       # 또는 `codex sandbox setup` (요건 확인)
# 4) smoke test — read-only 가 실제로 spawn 되는지
codex /debug-config                  # 0.139: effective sandbox modes 표시
codex exec --sandbox read-only "echo sandbox-ok"   # ← classifier 차단 시 §7-주의
# 5) plugin 경로 검증
node plugins/opnd-codex/scripts/codex-companion.mjs setup --json   # ready/verified
/opnd-codex:pair --wait "read-only pair smoke"
```
**검증 게이트 (PASS 조건)**: (a) `codex exec --sandbox read-only` 가 `spawn setup refresh` 없이 완료, (b) `/pair` 가 read-only 로 정상 응답, (c) `setup --json` ready:true. 셋 다 충족 → **Path A 종료, B 불필요**.
**롤백**: `npm install -g @openai/codex@0.134.0`.
**주의**: 4)의 raw `codex exec --sandbox ...` 는 Claude Code auto-mode classifier 가 차단할 수 있음(세션에서 실측). → PowerShell 직접 실행 또는 plugin 경로(`/pair`)로 검증.

### Path B (A 실패 시) — version-gated 형태
위치: `codex-companion.mjs:1996-1997` (handlePair). Codex 제안 최소 diff 를 **version-gated 로 보강**:
```js
if (shouldInjectImplicitReadOnly) {
  if (isWindowsSandboxBroken()) {   // win32 && codex<fixedVersion (또는 1회 probe 캐시)
    warn("Windows codex-cli sandbox 미가용 — /pair 가 config sandbox_mode 로 실행됩니다(read-only 미보장). codex 업데이트 권장.");
  } else {
    nextArgv.unshift("--read-only");
  }
}
```
**사용자가 명시 수용해야 할 trade-off**: Windows /pair 가 `~/.codex/config.toml` 의 sandbox_mode(이 호스트=danger-full-access) 로 실행 → **pair 의 read-only 미강제** (workaround, fix 아님). 명시 `--read-only`/`--sandbox` 는 항상 보존, non-Windows 무변경.
**테스트**: handlePair 단위 test (win32 broken → read-only 미주입+warn / win32 healthy → 주입 / 명시 flag 보존 / non-win32 무변경).

### Path C (stopgap) — 코드 0
Windows 에서 `/pair` 대신 `/opnd-codex:rescue` 사용. 즉시 적용, fix 아님.

---

## 6. 검증 종합 (§2.6 Cross-validation)

**Root cause (Agreed 5/5)**:
| # | Finding | verdict | conf |
|---|---|---|---|
| 1 | Layer 1 codex 0.134.0 Windows sandbox spawn 실패 | CONFIRMED | 0.9 + 라이브 재현 3회 |
| 2 | handlePair:1997 `--read-only` 자동 주입 | CONFIRMED | 0.99 |
| 3 | read-only 가 executeTaskRun 에 non-null 도달 → `?? null` 무력 | CONFIRMED | 0.99 |
| 4 | 다른 자동 read-only pin 없음 | CONFIRMED(배제) | 0.9 |
| 5 | 최소 fix = win32 implicit pair default 만 skip | CONFIRMED | 0.85 |

**Benchmark recommendation**:
- **Agreed**: A-first 가역 probe, C stopgap, B-only-if-A-fails + 경고, Path B diff 위치(1997).
- **Disagree (해소)**: 영구 B-lite 방어심화 — Claude 예비 YES ↔ Codex NO. → **Codex 채택** (안전 회귀 회피가 보수적 판단). version-gated/opt-in 으로 형태 변경.

**Codex 추가 리스크 (7 dimension 밖)**:
- global codex 업데이트가 output format/PATH/Desktop/permission 동작을 이 repo 밖에서 바꿀 수 있음.
- Path B expectation drift: 사용자가 /pair 를 read-only 로 오인하나 Windows 에선 full-access.
- `process.platform==="win32"` 는 coarse — WSL/Git Bash/PowerShell/Desktop 번들 CLI 경로별 상이.
- A 가 고치면 B 가 미래 CLI 회귀를 mask 하며 안전 약화.

---

## 7. 결정 포인트 (사용자 — 자기완결)

### ■ 결정 1 (즉시): Path A probe 진행 승인?
- **무엇**: codex 0.134→0.139 global 업데이트 + `codex sandbox setup --elevated` 프로비저닝 + smoke test.
- **왜 지금**: 릴리스 노트상 승산 HIGH, 가역(0.134 롤백), 성공 시 전체 moot(플러그인 변경 0).
- **리스크**: global npm 변경 → Desktop/타 repo/타 플러그인 영향 가능.
- **대안**: probe 보류하고 C stopgap 만 유지.

### ■ 결정 2 (조건부 — A 실패 시에만): Path B 수용?
- **무엇**: handlePair version-gated guard. Windows /pair 가 read-only 미보장(config sandbox_mode 상속).
- **수용해야 할 trade-off**: Windows 에서 /pair 가 full-access(danger) 로 실행될 수 있음.
- **형태 제약(Codex)**: 무조건 win32 guard 금지 — version-gated/opt-in + 경고 + healthy 시 자동 해제.

### ■ 결정 3 (정책): 영구 방어심화(B-lite) 추가?
- **권장: 아니오** (Codex 논거 채택). A 가 고치면 plugin guard 불필요 + 영구 guard 는 안전 회귀.

---

## 8. 실행 결과 (Path A probe — 2026-06-11 실측)

사용자 승인하 Path A probe 수행. **결과: Path A 성공 + sandbox 뒤에 가려져 있던 2번째 독립 버그 발견·수정.**

### Evidence (real backend e2e, mock var 없음, verified:true)
| # | 명령 | 결과 |
|---|---|---|
| 1 | `npm i -g @openai/codex@0.139.0` + `codex --version` | 0.134.0 → **0.139.0** |
| 2 | `codex sandbox -- cmd /c "echo sandbox-spawn-ok"` | `sandbox-spawn-ok` exit 0 → **Layer 1 fixed** |
| 3 | `setup --json` (broker.json 정리 후) | `ready/verified/loggedIn/available:true, staleHomeAuth:false` |
| 4 | `task-output.schema.json` required 7→9키 | valid JSON |
| 5 | `pair --wait "...PAIR_READONLY_OK"` | **Verdict: PAIR_READONLY_OK, exit 0**, terminal=Final output |
| 6 | `node --test ultraplan-runtime.test.mjs` (schema 소비 유일 테스트) | ✔ pair structured output schema PASS, exit 0 |

### 버그 2개 (둘 다 해결)
1. **Windows sandbox spawn** (codex-cli 0.134.0) → **codex 0.139 업데이트로 해결**. 플러그인 코드 변경 0. (릴리스 노트 §2: 0.136~0.138 이 `sandbox setup refresh` 집중 수정.)
2. **pair output-profile schema 비준수** (`schemas/output-profiles/task-output.schema.json:4`) — strict structured-output 가 `required`⊇`properties` 요구하는데 `changed_files`/`impacted_files` 누락 → 400 `invalid_json_schema`. **required 에 2키 추가로 수정.** 0.134 sandbox 실패가 모델 호출 전에 막아 **이 버그를 장기간 가려왔음** (rescue 는 `--output-profile` 미사용이라 무영향 → masking 입증).

### Path B/C 최종 판정: **moot (불필요)**
- 0.139 에서 read-only sandbox 정상 spawn → `handlePair` 의 `--read-only` 강제가 이제 정상 동작. Path B(win32 guard) 불필요 + Codex 가 경고한 안전 회귀 회피.
- `/pair` 가 read-only 안전 유지한 채 직접 동작 → Path C stopgap 불필요.

### 진단 정정 (정직)
- probe 중 setup/pair hang 을 "0.139 app-server 회귀"로 추정 → **오진**. 실제는 broker 10+개 mid-flight kill 로 stale `broker.json` 이 죽은 pipe 가리킴 → hang. **broker.json 정리로 해결** (교훈: broker 강제 kill 후 broker.json clear 필수).

### 미검증 영역
- `pair`(read-only)만 e2e. `review`/`task --write`(workspace-write) 별도 미검증 (0.139 릴리스 노트는 둘 다 커버).
- schema fix 는 `--output-profile` 전 경로 영향 — pair 로만 검증 + ultraplan-runtime.test.mjs PASS.
- codex 0.139 global 업데이트의 repo 밖 영향(Desktop/타 플러그인) 미평가.
- 전체 `npm test` suite: 진행 중 (관련 테스트는 PASS 확인).
