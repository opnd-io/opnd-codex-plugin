# codex-plugin-cc — 작업 인수인계 UltraPlan (toolkit 세션 Claude 용 단일 컨텍스트 문서)

> 작성: 2026-05-20 / 방식: goal-driven 단일 handoff 문서
> **이 문서 하나만 읽고도 codex-plugin-cc 작업을 이어받을 수 있도록** 모든 컨텍스트·의도·방향성을 자기완결적으로 담는다.

---

## §0. 이 문서의 목적과 사용법 (GOAL)

**GOAL**: `~/.claude` 툴킷 환경의 Claude 세션이 이 문서 **하나만** 전달받아, codex-plugin-cc 프로젝트의 현재 상태·역사·아키텍처·남은 작업·의도·제약을 **추가 질의 없이 파악**한다. (질의 없이 파악하는 것은 *컨텍스트* 이고, *무엇을 할지* 는 아래 기본 동작을 따른다.)

**기본 동작 (사용자 지시가 없을 때)**: 이 문서를 받은 Claude 는 자동으로 큰 작업을 착수하지 **않는다**. 순서는 — ① §10 체크리스트로 상태 검증 → ② 사용자 프롬프트에 구체 작업 지시가 있으면 그것을 수행(그 지시가 곧 해당 범위의 승인임) → ③ 지시가 없으면 §5 백로그를 사용자에게 제시하고 우선순위를 질의. "추가 질의 없이"는 *컨텍스트 파악*에만 적용되며, 작업 선택·범위 확장은 항상 사용자 결정 영역이다.

이 문서를 받은 Claude 가 해야 할 일:
1. §1~§4 로 프로젝트를 이해한다 (정체성 → 현황 → 역사 → 아키텍처).
2. §5~§6 으로 무엇을 할지 판단한다 (백로그 → 의도/방향).
3. §7~§8 의 제약·절차를 **반드시 준수**하며 작업한다.
4. §9 의 기존 문서를 필요 시 참조 (이 문서는 그것들을 중복하지 않고 가리킨다).
5. §10 체크리스트로 작업을 시작한다.

> 이 문서는 "무엇을 구현하라"는 단일 지시서가 아니라 **컨텍스트 전달체**다. 구체 작업은 사용자가 별도 지시하거나, §5 백로그에서 사용자 승인 하에 선택한다.

---

## §1. 프로젝트 정체성 — codex-plugin-cc 가 무엇인가

- **무엇**: Claude Code 용 플러그인. Claude Code 세션 안에서 **OpenAI Codex CLI** 를 subprocess 로 구동해, 코드 리뷰·작업 위임·페어 피드백을 받게 해준다.
- **출신**: `openai/codex-plugin-cc` 의 **fork**. opnd-io / tgkim 이 유지하는 **비공식 fork**. Apache License 2.0. OpenAI·Anthropic 과 무관(non-affiliated) — README·NOTICE·marketplace.json 에 disclaimer 명시.
- **패키지 정체성**: `@opnd-io/codex-plugin-cc` v2.1.0, `private: true`. 마켓플레이스 식별자 `opnd-io-codex` (`.claude-plugin/marketplace.json`).
- **기술 스택**: 순수 Node.js ESM (`.mjs`) + markdown. 웹앱 아님. 외부 npm 런타임 의존성 없음. TypeScript 는 app-server 타입 생성용으로만(`tsconfig.app-server.json`).
- **실행 의존**: 사용자가 `@openai/codex` CLI 를 **별도 설치**해야 함 + ChatGPT 구독 또는 OpenAI API 키. 이 플러그인은 Codex CLI 를 로컬 subprocess 로만 띄운다.
- **fork 가 upstream 에 더한 것**: v2.0.0 split-train hardening (안정성/Windows/auth/sandbox-default-omit/Codex-home-isolation) + v2.1.0 observability·UX (JSONL telemetry + trace.id, `/codex:status --tail/--watch`, user-config defaults, opt-in completion bell, non-UTF-8 locale 완화, non-interactive fallback). 전체 수정 로그는 `plugins/codex/CHANGELOG.md`.

---

## §2. 현재 현황 ⚠️ (가장 중요 — 먼저 읽을 것)

### 2.1 게시 상태 — 로컬 작업, 마켓플레이스 미게시

- **이 프로젝트는 아직 어떤 Claude Code 마켓플레이스에도 게시되지 않았다.** 현재까지 전부 **로컬 작업 + opnd-io GitHub fork(`github.com/opnd-io/codex-plugin-cc`)** 단계.
- `package.json` 은 `private: true` — npm 에도 publish 안 됨.
- `.claude-plugin/marketplace.json` 의 `opnd-io-codex` 는 식별자만 정의돼 있을 뿐, 마켓플레이스 등록/제출은 안 된 상태.
- → **"게시(publish)"는 아직 도달하지 않은 마일스톤**이다 (§5 백로그 B4).
- **게시 금지 행위의 범위 (명확히)**: 사용자 명시 지시 전까지 금지 = `npm publish`, 마켓플레이스 등록 PR/제출, `private: true` 해제, 공개 릴리스 태깅. **허용** = 게시 준비도(readiness) 점검·문서화·smoke test (실제 제출만 차단).

### 2.2 git 상태

- 기본 브랜치: `main`, HEAD = **`8d88a05`** (PR #4 merge commit).
- remote `origin` = `https://github.com/opnd-io/codex-plugin-cc.git`. upstream = `openai/codex-plugin-cc`.
- main 은 현재 **정상 동작 상태** — `codex-companion.mjs` 로드 검증 통과 (직전 세션에 `17385e4` broken-commit 을 PR #4 로 복구함, §3.4 참조).
- 워킹트리 untracked (커밋 안 된 세션 산출물): `.claude/`(프로젝트 로컬 agent-memory), `checkpoint.md`, `plan.md`, `docs/exploration/`, `docs/ultraplan/` 의 신규 ultraplan 2건, `ultraplan-round1-codex.md`(stray scratch). **이들은 의도적 미커밋 — 코드 아님**. 코드 작업 시 건드리지 말 것.

### 2.3 검증 상태

- 테스트: `tests/*.test.mjs` 35개 파일. 직전 세션 clean-env 전체 통과 (327 tests).
- ⚠️ **로컬 테스트 함정**: Claude Code 세션 안에서 `node --test` 를 돌리면 ~5개 테스트가 환경 아티팩트로 실패한다 — Claude Code 가 `CLAUDE_PLUGIN_DATA` 를 주입해 `resolveStateDir` 가 그것을 따르기 때문. **CI 동등 실행**: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_ROOT node --test tests/*.test.mjs`. 상세: `docs/TROUBLESHOOTING.md` #14.
- `node --test` 는 파일을 병렬 실행 → `state.test.mjs`+`ultraplan-runtime.test.mjs` 간 state-dir 간섭으로 간헐 실패 가능. 격리 재실행으로 진위 확인.

---

## §3. 히스토리 — PR #1~#4 와 주요 사건

### 3.1 PR #1 — audit follow-ups
upstream audit 후속 수정 + `marketplace.json` 버전 2.0.0→2.1.0.

### 3.2 PR #2 — opnd-io 리브랜딩
`@openai/codex-plugin-cc` → `@opnd-io/codex-plugin-cc`, 마켓플레이스 정체성 `opnd-io-codex`, 법무 리뷰 리포트(`docs/legal-review/`). Apache 2.0 §4/§6 trademark·Lanham Act 검토 완료.

### 3.3 PR #3 — upstream Tier 1 수동 포트 (8 HIGH)
upstream 의 OPEN 이슈/PR 을 Codex 와 함께 전수 탐색 → fork 에도 영향 있는 8건을 **수동 포트**(cherry-pick 은 fork 의 v2.0.0/v2.1.0 hardening 과 conflict 로 불가). 포함: per-turn watchdog(#312), env injection sanitization(#190), prompt-file containment(#289), git `--end-of-options`(#290), UTF-8 truncation(#314), JSONL ANSI strip(#24+#311). 신규 `lib/jsonl.mjs` + `TurnWatchdogError`.

### 3.4 ⚠️ `17385e4` broken-commit 사건 + PR #4 복구 (반드시 학습할 것)
- PR #3 의 commit `17385e4` 가 `codex-companion.mjs` 에 **두 개의 얽힌 workstream 을 부분적으로 섞어** 커밋했다 — workstream A(의도된 Tier1 포트) + workstream B(pair/capsule/output-profile 기능).
- 결과: 커밋된 `codex-companion.mjs` 가 `lib/capsule.mjs`(미스테이징 untracked) + `lib/state.mjs` 의 `readTaskSession`(미커밋 working-tree export)을 import → **fresh clone 시 `ERR_MODULE_NOT_FOUND` / `SyntaxError` 로 플러그인 전체 로드 불가**. 작업 트리엔 파일이 있어 로컬 test·lint 전부 green 이라 검출 안 됨.
- **PR #4 (`58be1ae`+`625d773`, merge `8d88a05`)** 가 workstream B 델타 전체를 landing 해 복구 + PR #3 코드리뷰 fix(ARCH-002 git `--end-of-options` 2 sink, SEC-001 env injection vector) + Codex PR #4 리뷰 fix(`GIT_CONFIG_*` 차단, NTFS-unsafe 세션 파일명).
- **교훈 (재발 방지)**: 수동 포트는 **1 commit = 1 workstream**. `git add -p` 로 hunk 선별. 커밋 전 staged `*.mjs` 의 상대경로 import 가 `git ls-files --others` 와 겹치는지 확인. 상세: `~/.claude/docs/solutions/manual-port-commit-untracked-import-fresh-clone-break.md`.

---

## §4. 아키텍처 개요 — 코드 네비게이션

### 4.1 디렉토리

```
codex-plugin-cc/
├── plugins/codex/              ← 실제 플러그인 본체
│   ├── commands/               12 슬래시커맨드 (.md): review, adversarial-review,
│   │                           agent, task(→agent.md), rescue, pair, continue,
│   │                           status, result, cancel, approve, deny, setup
│   ├── scripts/
│   │   ├── codex-companion.mjs ← 메인 진입점 (모든 커맨드가 이걸 호출)
│   │   ├── app-server-broker.mjs
│   │   ├── codex-efficiency-report.mjs
│   │   └── lib/                21 모듈 — codex.mjs(턴 캡처·watchdog),
│   │                           app-server.mjs(JSONL 프로토콜·env sanitize),
│   │                           broker-*.mjs, state.mjs(잡·세션 영속),
│   │                           git.mjs, jsonl.mjs, capsule.mjs, task-identity.mjs,
│   │                           render.mjs, telemetry.mjs, tracked-jobs.mjs ...
│   ├── skills/                 codex-cli-runtime, codex-result-handling, gpt-5-4-prompting
│   ├── agents/ hooks/ prompts/profiles/ schemas/output-profiles/
│   └── CHANGELOG.md            플러그인 수정 전체 로그
├── tests/                      35 *.test.mjs (node:test)
├── docs/                       §9 참조
├── package.json                @opnd-io/codex-plugin-cc 2.1.0 (private)
└── .claude-plugin/marketplace.json   opnd-io-codex
```

### 4.2 실행 모델
- 사용자가 `/codex:review` 등 슬래시커맨드 실행 → 커맨드 `.md` 가 `codex-companion.mjs <subcommand>` 를 호출.
- `codex-companion.mjs` 가 broker(`app-server-broker.mjs`)를 통해 Codex CLI 의 app-server 와 JSONL 프로토콜로 통신.
- 잡(job)은 `state.mjs` 가 per-workspace state dir 에 영속 (`resolveStateDir` — `CLAUDE_PLUGIN_DATA` 또는 temp fallback).
- 턴마다 watchdog(`TurnWatchdogError`, exit 124), 각종 hardening (env injection sanitize, ANSI strip, UTF-8-safe truncation).

### 4.3 workstream B 기능 (PR #4 로 landing 됨)
`/codex:pair`(foreground 읽기전용 페어 피드백), `--task-key`(세션 재사용), `--capsule`(대형 프롬프트 캡슐), `--output-profile`(구조화 산출 — `prompts/profiles/` 의 plan-review/root-cause/decision-triage/implementation/pair-programming), `codex-efficiency-report.mjs`, task-session 영속.

### 4.4 현재 한계 ⚠️ (계획이 가정하면 안 되는 것)

`docs/code-review/2026-05-20-pair-readiness-adversarial.md` 의 Claude×Codex 적대적 분석 결과 — 위 기능을 caveat 없이 신뢰하지 말 것:

- **`--output-profile` 은 라벨 수준** — 임의 문자열 수용 + 항상 generic schema 1개. profile 이름이 강한 동작 매핑이 아님.
- **`--task-key` 는 completed-run 한정** — `registerTaskSession` 이 `taskKey`+`threadId`+completed 모두 있어야 등록. 실패/무출력 run 은 재사용 세션이 안 됨.
- **`invalidateTaskSession` 미배선** — export 됐으나 caller 0. task-session invalidation 경로 half-wired.
- **Codex 는 검증자 불가 (hard ceiling)** — Codex sandbox 가 `node`/test/CLI 실행 불가. Codex 는 분석·리뷰·draft 엔진으로만 완전활용 가능, runtime 검증은 항상 Claude.
- **페어는 매끄럽지 않음 (구조적)** — foreground 600s Bash 한계·broker 직렬화·polling·approval round-trip 은 "Bash tool 로 subprocess 구동" substrate 에 내재. 페어 라운드는 **background+poll 을 기본 패턴**으로 설계할 것.
- **준비도 fix (PR #6)** — A1 approval-loop hang·A2 watchdog opt-in·A3 broker teardown zombie·A4 prompt-file containment 은 PR #6 `fix/pair-readiness-a1-a4` 에서 수정 진행 중. 머지 전이면 main 에 미반영 상태이므로 `git log` 로 확인.

---

## §5. 남은 작업 / 백로그 (사용자 승인 후 선택 진행)

> 기준선: 모든 upstream 항목은 `docs/upstream-tracking/2026-05-18-upstream-backlog-audit.md` (2026-05-18 audit 스냅샷) 근거. **착수 전 upstream 재-audit 필수** — 그 사이 upstream 이 변했을 수 있음. cherry-pick 가능 여부는 fork 의 v2.0/v2.1 hardening 과 conflict 나면 **수동 포트**(§3.3 선례).

| ID | 항목 | 상태 | 비고 / 의도된 종료상태 |
|---|---|---|---|
| B1 | upstream Tier 2 (13 MEDIUM) **평가 + cherry-pick/수동포트** | deferred | scope/policy 검토 필요. 각 건을 cherry-pick vs 수동포트 vs 기각으로 판정 후 진행 |
| B2 | fork-affected OPEN 4건 (#59·#75·#113·#238) | **거의 완료** | #59 FIXED(upstream PR #125 port), #113·#238 FIXED(docs), #75 DOCUMENTED(limitation 명시 — full bridge 는 size-L 백로그 잔존). 잔존: #75 bridge, #250 per-tool timeout(우선순위 낮음). 상세: `docs/upstream-tracking/2026-05-20-open-vs-fixed-matrix.md` |
| B3 | codex-plugin-cc `/code-review` LOW 미해결 | open | (a) `invalidateTaskSession` — wire 하거나 제거 (현재 half-wired, **먼저 조사 후 결정**) (b) 신규 코드 테스트 추가 — auto capsule key·path-containment·secret-refusal 케이스 (동작은 이미 존재, 테스트만 부재) — `docs/code-review/2026-05-19-184449.md` |
| B4 | **마켓플레이스 게시** | **미도달 마일스톤** | §2.1 — 실제 제출만 금지, 준비도 점검은 허용 |
| B5 | 운영-모델 UltraPlan 2건 구현 | plan 존재, 미착수 | ① `2026-05-18-...token-efficiency` — Codex 호출 토큰 효율화 ② `2026-05-20-...competitive-pair` — Claude×Codex 경쟁 페어 운영 모델 (7-PR 로드맵 내장). 둘 다 L+ 규모, 사용자 우선순위 결정 필요 |

> 백로그는 **사용자 우선순위 결정 영역**이다. 자동 착수하지 말 것 — §0 기본 동작을 따른다. 단 사용자가 같은 프롬프트에서 특정 백로그 항목을 직접 지시하면 그 지시가 해당 항목의 승인이다.

---

## §6. 의도와 방향성

- **정체성 유지**: upstream(`openai/codex-plugin-cc`)을 추적하되, opnd-io fork 로서 v2.0/v2.1 hardening 을 유지·발전. upstream 변경은 cherry-pick 불가 시 **수동 포트**.
- **품질 우선**: `17385e4` 사건 이후 — fresh-clone 무결성, 1 commit = 1 workstream, 커밋 전 import 무결성 검증이 핵심 규율.
- **Codex 페어 활용**: 이 프로젝트는 자기 자신이 Codex 연동 도구이므로, 개발 과정에서도 Claude×Codex 경쟁 페어를 적극 사용 (운영 모델은 `2026-05-20-claude-codex-competitive-pair-ultraplan.md` 참조).
- **게시는 신중히**: 마켓플레이스 게시는 법무 disclaimer·trademark 검토가 끝난 상태지만(PR #2), 실제 제출은 사용자 결정 마일스톤.

---

## §7. 컨벤션과 제약 ⚠️ (작업 시 반드시 준수)

이 문서를 받는 toolkit 세션 Claude 는 전역 `~/.claude/CLAUDE.md` 를 **이미 자동 로드**하고 있다 (외부 의존이 아님 — 타깃 세션의 기본 컨텍스트). 아래는 그중 이 프로젝트 작업에서 특히 어기기 쉬운 항목을 자기완결적으로 재기술한 것:

1. **커밋/PR/이슈 메시지 금지어**: `Co-Authored-By: Claude ...` trailer, `🤖 Generated with Claude Code` 푸터 — **절대 포함 금지** (harness 기본 템플릿을 오버라이드).
2. **한글 인코딩**: 한글 포함 커밋 메시지·PR body 는 HEREDOC + quoted `'EOF'` 로 전달. 단일 라인 `-m "..."` 금지.
3. **scope discipline**: 요청 범위 밖 수정 금지. 인접 수정 필요 시 먼저 질의 — silent scope 확장 금지.
4. **`git commit --no-verify` / `git push --no-verify` 금지** — 사용자 명시 승인 시에만.
5. **admin merge (branch protection 우회)** 는 **사용자 명시 승인 필요**. PR #1~#4 는 매번 승인받아 진행했음.
6. **시간 라벨 금지**: "이번 주", "1-2일" 등 미래 시간/작업시간 환산 금지. effort 사이즈(XS~XL)만.
7. **검증 규율**: negative assertion(어떤 것이 dead/stale/missing/unused 라는 단정)은 **5-Check** 통과 시에만 — ① Glob 으로 파일 존재 확인 ② Read 로 본문 확인 ③ `settings*.json` grep ④ 테스트 파일 grep ⑤ docs grep — 5개 모두 비어야 "certain". e2e/runtime PASS 보고 전 mock env var(`CLAUDE_PLUGIN_DATA` 등) 사전 점검 필수.
8. **Codex cross-verification**: Codex(`codex:codex-rescue`) 기본 호출 대상 = (a) substrate 단정 — 아키텍처 결론·도구 동작 단정·메타 finding (b) >2000자 SoT 문서 생성 (c) negative assertion + destructive follow-up. 단 **toolkit-aware 작업**(`~/.claude` 의 frontmatter·INDEX·hook·convention 변경)은 Codex 위임 금지, Claude only.

### §7.1 Safety rails (이 문서를 문자 그대로 따랐을 때 사고 방지)

- **파괴적 git 금지**: `git clean`·`git reset --hard`·`git checkout -- <path>` 로 워킹트리를 청소하지 말 것 (§2.2 untracked 산출물·사용자 미커밋 변경 소실). 사용자 명시 승인 시에만.
- **사용자 변경 보존**: 편집 전 `git status` 로 무관한 dirty 변경을 확인하고 절대 되돌리지/덮어쓰지 말 것.
- **브랜치**: 항상 **새 고유 이름** feature branch (`feat/...`·`fix/...`). 기존 브랜치 재사용·force-push 금지 (사용자 승인 시 예외).
- **admin merge**: branch protection 우회 머지는 CI 통과 + diff 리뷰 완료 + **사용자 명시 승인** 3박자 모두 충족 시에만.
- **시크릿**: OpenAI API 키·토큰을 echo·로그·커밋·capsule·telemetry 에 절대 포함하지 말 것. capsule 작성 전 시크릿 스캔.
- **state 파일**: `state.mjs` 가 관리하는 잡/세션 파일을 수동 편집·삭제하지 말 것 (백업 + 사용자 승인 시 예외).
- **법무·정체성 파일**: `README.md` disclaimer·`NOTICE`·`LICENSE`·`marketplace.json` 메타데이터 변경은 사용자 승인 필수. 변경 시 OpenAI/Anthropic non-affiliation disclaimer 가 유지되는지 확인.
- **upstream 포트**: cherry-pick 은 fork hardening 을 덮어쓸 수 있음 — 적용 후 반드시 fork hardening diff 리뷰 + 대상 테스트.

---

## §8. 작업 환경과 절차

- **OS/Shell**: Windows 11 + Git Bash (Bash tool) / PowerShell. cross-OS 경로 주의.
- **테스트 실행** (CI 동등):
  ```bash
  env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_ROOT node --test tests/*.test.mjs
  ```
  Claude Code 세션 내 일반 실행은 ~5개 환경-아티팩트 실패가 정상 (§2.3 / TROUBLESHOOTING #14).
- **구문 점검**: `node --check <file.mjs>`.
- **git/PR 절차**:
  - main 직접 커밋 금지 (pre-commit 게이트 + scope). 작업 전 `git fetch origin && git checkout -b <branch> origin/main` 로 fresh base.
  - 브랜치 이름: `feat/<요약>` · `fix/<요약>` · `chore/<요약>` (kebab-case, 고유).
  - PR 생성·머지는 `gh api` REST — GraphQL `gh pr` 가 "Could not resolve PullRequest" 로 실패한 전례 있음. 검증된 템플릿:
    ```bash
    # PR 생성 (한글 body 는 파일로)
    gh api repos/opnd-io/codex-plugin-cc/pulls -f title="..." -f head="<branch>" -f base="main" -F body=@/tmp/pr-body.md --jq '.html_url,.number'
    # 머지 (admin — 사용자 승인 후에만)
    gh api -X PUT repos/opnd-io/codex-plugin-cc/pulls/{n}/merge -f merge_method=merge -f sha=<head-sha>
    ```
  - 머지는 §7.1 admin merge 3박자 충족 시에만.
- **셸 주의**: 위/§8 의 명령은 **bash(Git Bash)** 기준. PowerShell 로 실행 시 `env -u VAR cmd` 는 동작 안 함 — `$env:VAR=$null; cmd` 또는 Bash tool 사용. 명령 블록 실행 전 셸을 확인할 것.
- **커밋 전 import 무결성 체크** (필수, §3.4 교훈):
  ```bash
  git diff --cached --name-only -- '*.mjs' | while read f; do grep -oE 'from "\./[^"]+\.mjs"' "$f"; done
  git ls-files --others --exclude-standard -- '*.mjs'   # 위 import 대상이 여기 있으면 broken commit
  ```

---

## §9. 참조 문서 맵 (이 문서가 중복하지 않고 가리키는 것들)

| 문서 | 내용 |
|---|---|
| `plugins/codex/CHANGELOG.md` | 플러그인 수정 전체 로그 |
| `README.md` / `NOTICE` / `LICENSE` | fork disclaimer, Apache 2.0 |
| `docs/TROUBLESHOOTING.md` | 14개 장애 모드 + 진단. **#14 = 로컬 테스트 함정** |
| `docs/MIGRATION_v2.0.md` | v1.x→v2.0 breaking changes |
| `docs/upstream-tracking/2026-05-18-upstream-backlog-audit.md` | upstream OPEN 이슈/PR 전수 audit, Tier 1/2/3 분류 (백로그 B1/B2 근거) |
| `docs/code-review/2026-05-19-184449.md` | PR #3 코드리뷰 21건 (백로그 B3 근거) |
| `docs/legal-review/2026-05-18-192759-rename-opnd-io-codex.md` | 리브랜딩 법무 검토 |
| `docs/ultraplan/2026-05-18-codex-harness-token-efficiency-ultraplan.md` | 토큰 효율 운영 plan |
| `docs/ultraplan/2026-05-20-claude-codex-competitive-pair-ultraplan.md` | Claude×Codex 경쟁 페어 운영 모델 |
| `~/.claude/docs/solutions/manual-port-commit-untracked-import-fresh-clone-break.md` | `17385e4` 사건의 안티패턴 솔루션 |

---

## §10. 작업 시작 체크리스트 (이 문서를 받은 Claude 가 처음 할 일)

1. [ ] §2 현황 확인 — `git log --oneline -5`, `git status`, HEAD 가 `8d88a05` 인가 (다르면 이 문서가 stale → 사용자에게 보고).
2. [ ] §2.1 재확인 — 마켓플레이스 미게시 상태. 게시 작업은 사용자 명시 지시 전 금지.
3. [ ] 작업 대상 결정 — 사용자 지시가 있으면 그것. 없으면 §5 백로그를 사용자에게 제시하고 우선순위 질의.
4. [ ] §7 컨벤션 숙지 — 특히 commit 금지어, scope discipline, admin merge 승인 규칙.
5. [ ] 코드 변경 시작 전 — §8 테스트 명령으로 baseline green 확인 (clean-env).
6. [ ] 커밋 전 — §8 import 무결성 체크 + 1 commit = 1 workstream.
7. [ ] PR 시 — §8 `gh api` REST 경로. 머지는 사용자 승인.

---

## 부록 — 이 문서의 한계

- 이 문서는 2026-05-20 시점 스냅샷이다. HEAD 가 `8d88a05` 가 아니면 이후 변경이 있으므로 git log 로 보강할 것.
- 코드 세부는 담지 않는다 — 네비게이션 지도(§4)만 제공. 실제 구현은 해당 파일을 Read 할 것.
- 백로그(§5) 우선순위는 미확정 — 사용자 결정 영역.
