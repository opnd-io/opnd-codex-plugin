---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Non-interactive fallback (PR-7.8, #223):

- If `AskUserQuestion` is not available — typically because the user invoked Claude Code with `claude --print` or another non-interactive mode that disables interactive tools — do **not** attempt the install prompt. Default to **Skip for now** so the script never reaches a state where it tries to globally install a package without explicit operator consent. Mention "non-interactive mode detected, skipping the Codex install prompt — run `npm install -g @openai/codex` manually if needed" once and proceed to the Output rules below.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
