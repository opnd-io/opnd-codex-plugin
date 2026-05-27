---
description: Deny a pending Codex command, file-change, permission, or tool request
argument-hint: "<approval-id|prefix>"
allowed-tools: Bash(node:*)
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" deny "$ARGUMENTS"`

Present the command output exactly as-is.
The approval reference can be the full approval ID or a unique prefix; the companion accepts any prefix that matches exactly one pending approval.
