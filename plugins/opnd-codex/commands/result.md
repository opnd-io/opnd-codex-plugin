---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id] [--digest|--raw] [--wait [--timeout-ms <ms>] [--poll-interval-ms <ms>]]'
allowed-tools: Bash(node:*)
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Pass `--wait <jobId>` to block until the job reaches a terminal status (`completed / failed / cancelled / terminated / timeout`), then print the stored result. Default deadline is 4 min (`--timeout-ms`) with 2 s polling (`--poll-interval-ms`). Use `--digest` when Claude only needs the compact handoff fields for a follow-up run. Mirrors `/opnd-codex:status --wait` semantics so the README workflow `/opnd-codex:rescue --background ... → /opnd-codex:result --wait <jobId>` is now end-to-end usable.

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/opnd-codex:status <id>` and `/opnd-codex:review`
