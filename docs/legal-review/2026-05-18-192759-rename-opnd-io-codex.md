# 법적/라이선스 리뷰 — opnd-io-codex rename + 마켓플레이스 publish

> 생성일: 2026-05-18 19:27:59 / 협력: Claude main (Opus 4.7) + Codex 5th-reviewer (gpt-5.4)
>
> **Scope**: read-only review of `LICENSE`, `NOTICE`, `.claude-plugin/marketplace.json`, `package.json`, `README.md` (first 80 lines). This is engineering / legal-risk analysis, **not legal advice**. Lawyer review recommended before publish.
>
> **Trigger**: 사용자 질문 "본 fork 를 마켓플레이스에 `opnd-io-codex` 로 rename 후 publish 가능? 라이선스 위반? 다운로드 용이?" → 5-round audit cycle (`docs/exploration/2026-05-18-163003-codex-as-claude-subagent.md`) 의 follow-up.

## 종합 판정

**verdict: safe-with-conditions**

- ✅ Apache 2.0 copyright 측면 mostly 정합 — LICENSE + NOTICE 모두 OK
- ⚠️ 현 marketplace metadata 의 OpenAI publisher identity 가 **blocking issue** — Apache 2.0 §6 + Lanham Act §43(a) 의 false association 위험
- ⚠️ NPM `@openai` scope publish — practically blocked (org permission) + legally risky
- ✅ Anthropic plugin marketplace policy 충돌 없음
- ⚠️ 사용자 disclaimer 추가 필요 (unofficial fork / separate Codex CLI / OpenAI terms)

## 1. Apache 2.0 라이선스 의무 점검

### § 4-a (LICENSE 동봉) — ✅ Safe

- `LICENSE` 파일이 표준 Apache 2.0 텍스트 포함
- `package.json` `"license": "Apache-2.0"`
- 마켓플레이스 distribution 이 LICENSE 파일을 포함하면 §4(a) 충족
- 출처: <https://www.apache.org/licenses/LICENSE-2.0.txt>

### § 4-b (Modified file 의 prominent notice) — ✅ Substantively safe

- `NOTICE` 에 `Modifications since 2026-05-16 © opnd-io / tgkim` 명시
- README 가 fork 임을 첫 줄에서 표명
- **권장 보강**: upstream 이 per-file header 사용했다면 modified file 마다 modification indicator 추가 (현재 NOTICE level 만)

### § 4-c (NOTICE 보존 + append) — ✅ Safe

- `Copyright 2026 OpenAI` 보존
- opnd-io/tgkim 의 modifications attribution 추가
- 변경 사항을 git log + `plugins/codex/CHANGELOG.md` 로 위임
- §4(c) 의 "preserve copyright, patent, trademark, attribution notices" 충족

### § 4-d (Apache 또는 compatible license + own terms 의 분리) — ✅ Safe

- License 가 Apache-2.0 유지
- NOTICE 가 restrictive terms 추가 안 함
- `package.json` `"private": true` — 현 시점 NPM publish 차단됨
- §4(d) 의 "you may add your own copyright statement and may provide additional or different license terms... for your modifications" 의 분리 원칙 충족

### § 6 (Trademarks) — ⚠️ Risky → Blocking fix 필요

- **현 marketplace.json 의 `owner: { name: "OpenAI" }` + `plugins[0].author: { name: "OpenAI" }`** 는 fork publisher 가 OpenAI 라는 false implication
- Apache 2.0 §6: "This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for describing the origin of the Work and reproducing the content of the NOTICE file"
- OpenAI brand guidance: misrepresent relationship 금지, imply endorsement 금지, OpenAI mark 를 자신의 mark 보다 prominent 하게 쓰지 말 것 (<https://openai.com/brand/>)
- **NOTICE 의 origin 명시는 OK** (Apache 2.0 §6 의 명시 예외)
- **마켓플레이스 card / README title / install alias** 가 OpenAI publisher 처럼 보이는 건 위반 위험

### "codex" 단어 분석 — ✅ Safe-with-conditions

- "Codex" 는 사전 단어 (manuscript / codebook) 인 동시에 OpenAI 의 product family 식별
- Descriptive / nominative use 는 trademark 법 일반 원칙에서 허용 — compatibility 식별 목적에서 필요한 만큼만 사용 + endorsement implication 회피
- `codex-plugin-cc` 유지가 `openai-codex` 보다 안전 — function description 에 가까움
- OpenAI 공식 brand page (2025 기준) 에 "Codex" trademark 명시 entry 없으나, product 컨텍스트에서는 product mark 로 추정

## 2. NPM scope `@openai` — ⚠️ Blocking fix 필요

### 관찰

- 현 `package.json`: `"name": "@openai/codex-plugin-cc"` + `"private": true`
- Codex CLI (`@openai/codex`) 는 dependency 아님 — 사용자가 별도 `npm install -g @openai/codex` 후 plugin 이 subprocess spawn

### NPM 정책 분석

- `@openai` scope 는 npm 의 OpenAI org 일 가능성 — non-member 의 publish 차단
- 출처: <https://docs.npmjs.com/cli/v8/using-npm/scope/>
- `"private": true` 도 publish 차단

### 법적 분석

- Non-authorized `@openai` publish: **unsafe** — source/affiliation confusion + Apache 2.0 §6 + Lanham Act false association
- `@opnd-io/codex-plugin-cc` 변경: safe-with-conditions (npm `@opnd-io` org / user scope 통제권 보유 가정)
- `@openai/codex` (Codex CLI) 의 runtime 의존: descriptive 표현으로 안전 — "requires the OpenAI Codex CLI (`@openai/codex`) installed separately"

## 3. GitHub repo naming — ✅ Safe-with-conditions

- `opnd-io/codex-plugin-cc` 는 fork 로서 README + marketplace 가 unofficial + derived from 표기 시 OK
- Apache 2.0 §2 가 derivative works 허용. §6 가 trademark 사용 제한
- README/UI 에서 "OpenAI" + "Codex" 사용:
  - ✅ origin/upstream 식별 컨텍스트 OK
  - ✅ required CLI 식별 OK
  - ❌ title / owner / author field 의 OpenAI publishing implication 은 위반 위험

## 4. Anthropic Claude Code plugin marketplace — ✅ Low risk

### Policy 출처

- <https://code.claude.com/docs/en/plugin-marketplaces> (Claude Code plugin marketplace docs)

### 관찰

- Anthropic 이 공식 marketplace 의 이름 일부 reserve. third-party / demo marketplace 는 manual add 허용 — 즉 third-party fork 명시 지원
- `opnd-io-codex` 는 reserved name 충돌 없음 (2025 기준)
- Cross-vendor plugin (Claude → OpenAI Codex) 제한 정책 found 없음

### 운영 측면

- Plugin 이 third-party CLI (Codex) 를 launch + 사용자 prompt/file 을 OpenAI 측에 전송 가능 → **transparency 의무** (사용자에게 명시)
- **Blocking issue**: 현 marketplace owner/author = OpenAI 는 user 가 publisher 를 OpenAI 로 오인 → unsafe until rename

## 5. 사용자 disclaimer (Required / Recommended)

### Required (publish 전 추가 필수)

- **"Unofficial fork maintained by opnd-io / tgkim; not affiliated with, sponsored by, or endorsed by OpenAI or Anthropic."**
- **"Derived from `openai/codex-plugin-cc` under Apache License 2.0; see `LICENSE` and `NOTICE`."**
- **"Requires a separately installed OpenAI Codex CLI (`@openai/codex`) and a ChatGPT subscription or OpenAI API key."**
- **"Use of Codex/OpenAI services is governed by OpenAI's applicable terms, policies, account limits, and pricing."**
- **"This plugin runs Codex CLI as a subprocess from Claude Code; prompts/files supplied to Codex may be processed by OpenAI services depending on your Codex configuration."**

### 법적 근거

- Apache 2.0 자체가 non-endorsement disclaimer 의무 명시 안 함, 단 §6 + nominative fair use 원칙이 권고
- Cross-vendor bridge (Claude → OpenAI) 라 privacy / security expectation management 추가 의무

## 6. 국제 trademark 시각

### 한국 (KIPO)

- 상표법 §89: trademark 보유자의 designated goods 독점권
- 상표법 §90: 일반 / 기술 (descriptive) 사용 + 자기 이름 / 상호 사용 한정 — generally accepted business practices 범위 안
- 출처: <https://www.kipo.go.kr/upload/en/download/TRADEMARK_ACT_2016.pdf>
- `opnd-io` publisher 명시 + OpenAI/Codex 의 descriptive reference = lower risk
- "OpenAI" 를 publisher / author 로 사용 = source confusion → high risk

### 미국 (Lanham Act)

- DMCA (저작권 회피) 는 본 rename 의 직접 issue 아님
- Lanham Act §43(a) (15 U.S.C. §1125(a)): false association / sponsorship / endorsement
- Nominative fair use 가 "requires OpenAI Codex CLI" 같은 정확한 + non-prominent reference 허용
- `codex-plugin-cc` (function description) 가 `openai-codex` (publisher identity) 보다 안전

## 7. Edge cases / 잠재 위험

### OpenAI challenge 가능성

- OpenAI 가 marketplace listing 을 trademark / 부정경쟁 차원에서 challenge 가능 (특히 "Codex" 가 plugin name 에 포함 + README/marketplace copy 의 OpenAI mark 과사용 시)
- Apache copyright 위반 아니라 trademark / unfair-competition 위험 (Apache 2.0 §6 + Lanham Act)
- **Mitigation**: title `opnd-io-codex`, author `opnd-io`, first README paragraph 의 unofficial 명시, OpenAI logo 사용 금지, "official" / "OpenAI Codex plugin" 같은 product title 회피

### `@openai/codex` separate package license

- Plugin 이 `@openai/codex` 를 npm dependency 로 install 하지 않음 (subprocess spawn 만)
- `@openai/codex` package license 가 plugin fork 에 자동 contamination 안 함 — Apache 2.0 §1 의 derivative-work 정의 + §2 copyright grant 가 subprocess invocation 을 derivative work 로 포함 안 함
- ❗ **future risk**: plugin 이 Codex CLI 를 bundle / vendor / patch / redistribute 시 별도 license review 필요

### v2.0.0 / v2.1.0 own changes

- NOTICE 가 opnd-io/tgkim 의 v2.0.0 + v2.1.0 변경 명시
- 변경이 본인 copyright claim 확장 — 단 trademark 권리 확장 아님 (§6 그대로 유지)
- **Version drift latent issue**: marketplace.json 2.1.0 (이전 PR 에서 fix) ↔ 과거 stale 2.0.0 — 법적 위반 아니나 공개 release 전 cleanup 필요 (이미 PR #1 에서 fix 완료)

## Required actions (Blocking — publish 전 필수)

1. **marketplace.json**:
   - `name`: `"openai-codex"` → `"opnd-io-codex"`
   - `owner.name`: `"OpenAI"` → `"opnd-io"`
   - `plugins[0].author.name`: `"OpenAI"` → `"opnd-io"`
2. **README install path**:
   - `/plugin marketplace add openai/codex-plugin-cc` → `opnd-io/codex-plugin-cc`
   - `/plugin install codex@openai-codex` → `codex@opnd-io-codex`
3. **README + marketplace description 의 non-affiliation disclaimer**:
   - "Unofficial fork maintained by opnd-io..." 한 줄
   - 또는 README top section 에 명시
4. **NPM publish 정책**:
   - `@openai/codex-plugin-cc` scope 사용 금지
   - `@opnd-io/...` (own npm scope 통제 시) 로만 publish 또는 unscoped
5. **package.json** 의 `name` 변경 동반 (NPM publish 의도가 있으면)

## Recommended actions

- `LICENSE` + `NOTICE` 를 모든 distributed source / plugin bundle 에 포함
- OpenAI attribution 을 origin / NOTICE text 한정 — publisher identity 아님
- Codex reference 표현: **"requires OpenAI Codex CLI (`@openai/codex`) installed separately"**
- Package / marketplace version align (이미 PR #1 에서 완료)
- OpenAI logo / "official" / "certified" / co-branding 표현 회피

## Optional actions

- Plugin display description: "Unofficial Claude Code plugin for running the OpenAI Codex CLI"
- README 에 "Privacy and third-party services" 섹션 추가
- Marketplace 에 "이 plugin 은 local `codex` subprocess 를 launch" 보안 noted

## Claude main 통합 핵심 finding (5 bullet)

1. **Apache 2.0 copyright 측면 정합** — LICENSE 존재, NOTICE 가 OpenAI attribution 보존 + opnd-io modifications append, blocking copyright issue 없음
2. **현 marketplace metadata 의 OpenAI publisher identity 가 main blocker** — `owner.name="OpenAI"` + `author.name="OpenAI"` 가 Apache 2.0 §6 + Lanham Act false-association 위반 위험
3. **`codex-plugin-cc` 는 descriptive compatibility naming 으로 acceptable** — 단 `openai-codex` 가 publisher identity (name/owner/author) 로 쓰이는 건 risky → 변경 필수
4. **NPM `@openai` publishing 은 practically + legally blocked** — npm org permission 차단 + trademark false affiliation. `@opnd-io/codex-plugin-cc` (own scope) 로 변경 필수
5. **README + marketplace 에 unofficial-fork + separate Codex CLI + OpenAI terms disclaimers 추가** — publish 전 필수

## 출처

- Apache License 2.0 공식 텍스트: <https://www.apache.org/licenses/LICENSE-2.0.txt>
- OpenAI Brand Guidelines: <https://openai.com/brand/>
- NPM scoped package docs: <https://docs.npmjs.com/cli/v8/using-npm/scope/>
- Claude Code plugin marketplace docs: <https://code.claude.com/docs/en/plugin-marketplaces>
- 한국 상표법 (KIPO English): <https://www.kipo.go.kr/upload/en/download/TRADEMARK_ACT_2016.pdf>
- Lanham Act § 43(a): 15 U.S.C. § 1125(a)

---

> **Lawyer review recommended** before public marketplace publish. 본 문서는 engineering-level legal-risk analysis 이고 jurisdiction-specific legal advice 아님. trademark / 부정경쟁 영역의 명시적 자문은 변호사 의견 권장.
