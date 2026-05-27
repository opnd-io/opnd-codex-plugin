---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id] [--dry-run]'
allowed-tools: Bash(node:*)
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"`

With no job id, the companion auto-selects the single active job for this session and cancels it. Pass `--dry-run` first to preview the target without cancelling.
