---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--tail [--tail-lines <N>]] [--watch [--tail-lines <N>] [--watch-interval-ms <ms>]] [--all]'
allowed-tools: Bash(node:*)
---

!`"$(command -v node || command -v nodejs || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -n1 || echo node)" "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

PR-3.5 (#264 / #237) — `--tail [N]` and `--watch` extend the same job-id mode:

- `--tail` prints the last 20 lines of the job log file (override count with `--tail-lines <N>`) PLUS every telemetry event matching the job's traceId. One-shot, no polling.
- `--tail-lines <N>` overrides the default tail count. Works with both `--tail` and `--watch`.
- `--watch` runs an initial `--tail` then keeps polling (default every 1500 ms, override with `--watch-interval-ms <ms>`) and emits **only new** log lines + new trace events as they appear. Exits cleanly once the job reaches a terminal status (completed / failed / cancelled / terminated / timeout). Mutually exclusive with `--wait`.

For both `--tail` and `--watch`, present the full command output verbatim — do not collapse or summarize.
