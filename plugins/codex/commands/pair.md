---
description: Ask Codex for foreground read-only pair-programming feedback
argument-hint: "[--background] [--task-key <key>] [--capsule <path>] [prompt]"
allowed-tools: Bash
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" pair "$ARGUMENTS"`
