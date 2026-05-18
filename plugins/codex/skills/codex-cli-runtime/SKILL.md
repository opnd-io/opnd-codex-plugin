---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Leave `--sandbox` unset unless the user explicitly requests a sandbox mode. Accepted values are `read-only`, `workspace-write`, and `danger-full-access`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- **`--background` / `--wait` policy (#324 — unified rule):** these tokens are command-layer routing flags. The `/codex:rescue` command consumes them to decide whether to invoke the rescue subagent with `run_in_background: true` (for `--background`) or foreground (for `--wait` or neither). They are NOT forwarded to the `task` subcommand of `codex-companion.mjs`.
  - Strip both `--background` and `--wait` from the natural-language task text — they are not prompt content.
  - Strip both from the argv passed to `task`. The companion `task` subcommand also supports `--background` for direct invocations, but in the rescue chain backgrounding is handled at the Agent layer (the parent `/codex:rescue` command runs the subagent with `run_in_background: true`); adding `--background` again to `task` would double up and break job tracking.
  - When the user passed neither flag, run foreground exactly as the command layer requests. Do not infer `--background` from prompt length, perceived complexity, multi-step phrasing, or estimated runtime. The rescue subagent is a forwarder, not a scheduler; mode selection belongs to the user via the `/codex:rescue` command.
  - The subagent must never independently choose `run_in_background: true` for its own Bash call. The `/codex:rescue` command already mapped `--background` to the Agent invocation; the subagent simply runs the Bash call in whatever mode the parent passed.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--sandbox`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `--sandbox`: accepted values are `read-only`, `workspace-write`, `danger-full-access`.
- `--profile <name>`: select a `[profiles.<name>]` block from `~/.codex/config.toml` for this single invocation. Forces a direct codex spawn (broker is bypassed). Only pass when the user explicitly requests a profile by name.
- **Large prompts (#308):** if the forwarded prompt is larger than ~3 KB, the upstream Claude Code Bash tool will silently reject the call with the generic "user denied tool use" wording. Always write the prompt to a temp file and pass `--prompt-file <path>` (or pipe via stdin with `--prompt-stdin`) when the prompt approaches that size. Never pass multi-KB prompts as a single positional argument.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.
- **Worktree isolation guard (#198):** when the parent invoked the rescue subagent inside a worktree (cwd matches `.git/worktrees/*` or `*/.claude/worktrees/*`, or the parent passed `isolation: "worktree"`), never use `--background` and never `run_in_background` the Bash call — even if the user passed `--background`. Drop the flag and run foreground only. Otherwise the host harness cleans the worktree as soon as the subagent returns, leaving Codex pinned in a deleted directory. Foreground keeps the Bash alive so cleanup waits for the result. This is the only situation in which an explicit user `--background` is overridden.

Foreground runtime hint (long-running heuristic, #122):
- The upstream Claude Code Bash tool enforces a hard ~600 s timeout on every invocation. A long-running foreground rescue (deep refactor, multi-file rewrite, full repo audit) will hit that limit, the Bash call will be killed, and the user is left with no jobId to resume — the broker's task may still be alive but it has no caller waiting for it.
- When the forwarded request reads as long-running and the user did not pass `--background`, the rescue subagent must surface a single short routing-notice line **before** the `task` invocation. The line must:
  1. State the ~600 s Bash ceiling and that a long foreground rescue may be killed before Codex finishes.
  2. Recommend re-issuing the same request with `--background` so the run is enqueued and a jobId is returned immediately.
  3. Point at the poll commands explicitly: `/codex:status <jobId>` (or `/codex:status --wait <jobId>` to block until terminal) and `/codex:result <jobId>` (or `/codex:result --wait <jobId>`) to retrieve once done.
  4. Then forward the original request as foreground exactly as the user asked — **never auto-switch on the user's behalf**.
- The hint is the only Claude-side text the rescue subagent is allowed to add to its response. It is a routing notice, not a commentary on Codex output. Place it strictly **before** the verbatim Codex output; never append anything after.
- If the user already passed `--background`, do not emit the hint: the user has already chosen background, and the bash call will return the jobId from `enqueueBackgroundTask` immediately.
- This hint is intentionally not a hard `--background` auto-promote: that would re-introduce the #324 stub-return failure mode this SKILL was rewritten to prevent.
