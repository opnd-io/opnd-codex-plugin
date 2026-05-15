---
description: Deny a pending Codex command, file-change, permission, or tool request
argument-hint: "<approval-id|prefix>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" deny "$ARGUMENTS"`

Present the command output exactly as-is.
The approval reference can be the full approval ID or a unique prefix; the companion accepts any prefix that matches exactly one pending approval.
