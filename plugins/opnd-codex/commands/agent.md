---
description: Start a long-running Codex agent task with approval-aware control from Claude Code
argument-hint: "[--wait|--background] [--task-key <key>] [--capsule <path>] [--sandbox <read-only|workspace-write|danger-full-access>] [--approval <never|on-request|on-failure|untrusted>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [task]"
allowed-tools: Bash(node:*)
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" agent "$ARGUMENTS"`

Present the command output exactly as-is.

Operational contract:
- This command is for substantial implementation, debugging, migration, and follow-up work delegated to Codex.
- The companion defaults to a write-capable background run with `--approval on-request` unless the user overrides those flags.
- Use `--task-key <key>` when this is part of a known Claude plan or follow-up chain, so the companion can reuse the right Codex thread safely.
- If Codex pauses for approval, tell the user to run `/opnd-codex:status`, then `/opnd-codex:approve <approval-id>` or `/opnd-codex:deny <approval-id>`.
- Do not summarize or replace Codex's result with Claude-side implementation work.
