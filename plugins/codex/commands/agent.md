---
description: Start a long-running Codex agent task with approval-aware control from Claude Code
argument-hint: "[--wait|--background] [--sandbox <read-only|workspace-write|danger-full-access>] [--approval <never|on-request|on-failure|untrusted>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [task]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" agent "$ARGUMENTS"`

Present the command output exactly as-is.

Operational contract:
- This command is for substantial implementation, debugging, migration, and follow-up work delegated to Codex.
- The companion defaults to a write-capable background run with `--approval on-request` unless the user overrides those flags.
- If Codex pauses for approval, tell the user to run `/codex:status`, then `/codex:approve <approval-id>` or `/codex:deny <approval-id>`.
- Do not summarize or replace Codex's result with Claude-side implementation work.
