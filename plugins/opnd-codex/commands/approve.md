---
description: Approve a pending Codex command, file-change, permission, or tool request
argument-hint: "<approval-id|prefix> [--session] [--response-json <json>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" approve "$ARGUMENTS"`

Present the command output exactly as-is.
The approval reference can be the full approval ID or a unique prefix; the companion accepts any prefix that matches exactly one pending approval.
Use `--session` only when the user explicitly wants the same class of request approved for the rest of the Codex session.
Use `--response-json` only for advanced tool or elicitation requests that require a structured response payload.
