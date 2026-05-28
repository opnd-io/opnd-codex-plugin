---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json "$ARGUMENTS"
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

Windows install error handling (#113):

- The `npm install` stderr on a Windows non-UTF-8 console (CP-949 / CP-1252
  etc.) often comes back **mojibake / garbled bytes**. Do **not** report
  garbled install output as a failure from the raw bytes alone.
- The rerun below is the source of truth. If it reports Codex **available**,
  the install succeeded despite the unreadable stderr — proceed normally.
- Only treat it as a real failure if the rerun still reports Codex
  **unavailable**. In that case surface the install command's exit code
  (not the garbled text) and advise the user to run
  `npm install -g @openai/codex` manually in a UTF-8 terminal.

- Then rerun:

```bash
"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json "$ARGUMENTS"
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Non-interactive fallback (PR-7.8, #223):

- If `AskUserQuestion` is not available — typically because the user invoked Claude Code with `claude --print` or another non-interactive mode that disables interactive tools — do **not** attempt the install prompt. Default to **Skip for now** so the script never reaches a state where it tries to globally install a package without explicit operator consent. Mention "non-interactive mode detected, skipping the Codex install prompt — run `npm install -g @openai/codex` manually if needed" once and proceed to the Output rules below.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.

Advisory disclaimer (single-use refresh token rotation):

- `setup --json` 의 `ready/loggedIn/verified: true` 응답은 **cached advisory** — Codex CLI 의 setup 명령이 직전 점검 결과를 응답하는 것으로, 정확한 source (auth.json / app-server cache / 직전 probe trace) 는 codex-cli 내부 구현에 의존하며 plugin 영역 외. 실제 rescue/agent/pair/review 호출 시 fresh app-server session 이 refresh token 을 새로 사용 — 다른 process (Codex Desktop / 이전 plugin call / `codex login` 직후 첫 호출 race) 가 이미 같은 refresh token 을 소비했으면 `Your access token could not be refreshed because your refresh token was already used` 로 fail.
- 즉 setup advisory verified:true → 다음 호출 100% 성공 보장 X. 다음 호출 fail 시 단순 재로그인 retry 가 같은 케이스 반복 가능 (cached state 만 갱신, plugin home 격리 영역은 stale 유지).
- **plugin home 격리 (v2.0+)**: plugin 은 `$HOME/.codex/claude-code/auth.json` 사용. 사용자가 `codex logout && codex login` 한 결과는 `~/.codex/auth.json` 에만 반영 → plugin home 의 auth 는 stale. 본 케이스 root cause + 복구 절차는 본 repo root `CLAUDE.md` 의 "Plugin home 격리 — auth sync 정책" 섹션 참조 (`cp ~/.codex/auth.json ~/.codex/claude-code/auth.json` + broker `codex.exe` (소문자) kill).
- 본 false-positive 패턴은 `plan-issue-setup-advisory-false-positive.md` (root) + `plan-issue-2-additional-repro.md` 에 상세 분석 + reproduction 보관 — upstream Codex CLI 의 setup --json 에 actual app-server round-trip probe 추가가 본질 fix.
