---
description: Send a follow-up instruction to the latest Codex task, steering it if it is still running
argument-hint: "[--job <job-id>|--task-key <key>] [--background] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [follow-up]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" continue "$ARGUMENTS"`

Present the command output exactly as-is.

If the selected Codex task is still running, this command steers the active turn.
If the selected task already finished, it starts a new turn on that Codex thread.
Use `--task-key <key>` to continue the logical task registered by `/codex:pair` or `/codex:agent`.
