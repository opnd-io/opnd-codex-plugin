---
description: Ask Codex for foreground read-only pair-programming feedback
argument-hint: "[--background] [--task-key <key>] [--capsule <path>] [prompt]"
allowed-tools: Bash
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" pair "$ARGUMENTS"`
