---
description: Deny a pending Codex command, file-change, permission, or tool request
argument-hint: "<approval-id>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" deny "$ARGUMENTS"`

Present the command output exactly as-is.
