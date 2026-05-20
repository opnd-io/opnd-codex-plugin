# Codex plugin for Claude Code (opnd-io fork)

> **Unofficial fork maintained by opnd-io / tgkim. Not affiliated with, sponsored by, or endorsed by OpenAI or Anthropic.**
>
> Derived from [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) under the Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
> Tracks the upstream and adds the v2.0.0 split-train hardening (stability / Windows / auth / sandbox-default-omit / Codex-home-isolation) plus the v2.1.0 observability + UX changes (JSONL telemetry with trace.id, `/opnd-codex:status --tail/--watch`, user-level config defaults, opt-in completion bell, non-UTF-8 locale mitigation, non-interactive command fallbacks). See [`plugins/opnd-codex/CHANGELOG.md`](plugins/opnd-codex/CHANGELOG.md) for the full modification log.
>
> **Requires a separately installed OpenAI Codex CLI ([`@openai/codex`](https://www.npmjs.com/package/@openai/codex))** plus a ChatGPT subscription or an OpenAI API key. Use of Codex / OpenAI services is governed by OpenAI's applicable terms, policies, account limits, and pricing. This plugin runs Codex CLI as a local subprocess from Claude Code; prompts and files supplied to the plugin may be processed by OpenAI services depending on your Codex configuration.

Use the OpenAI Codex CLI from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/opnd-codex:review` for a normal read-only Codex review
- `/opnd-codex:adversarial-review` for a steerable challenge review
- `/opnd-codex:pair` for foreground read-only pair-programming feedback with task-key reuse and structured result digests
- `/opnd-codex:agent`, `/opnd-codex:continue`, `/opnd-codex:approve`, `/opnd-codex:deny`, `/opnd-codex:status`, `/opnd-codex:result`, and `/opnd-codex:cancel` to delegate and control long-running Codex work

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add opnd-io/opnd-codex-plugin
```

Install the plugin:

```bash
/plugin install opnd-codex@opnd-codex-plugin
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/opnd-codex:setup
```

`/opnd-codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/opnd-codex:review --background
/opnd-codex:status
/opnd-codex:result
```

## Usage

### `/opnd-codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review or `--branch <ref>` to review a remote branch (e.g. `origin/feature-x`) **without checking it out locally**. Also supports `--wait`, `--background`, `--max-findings <N>` (default 20, hard cap 100), `--profile <name>`, and `--fast`. It is not steerable and does not take custom focus text. Use [`/opnd-codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/opnd-codex:review
/opnd-codex:review --base main
/opnd-codex:review --branch origin/feature-x  # remote-branch review, no checkout
/opnd-codex:review --background
/opnd-codex:review --max-findings 50          # lift the implicit 2-3 cap on large diffs
/opnd-codex:review --fast                     # ~1.5x speed, ~2x credits
```

This command is read-only and will not perform any changes. When run in the background you can use [`/opnd-codex:status`](#codexstatus) to check on the progress and [`/opnd-codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/opnd-codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/opnd-codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/opnd-codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/opnd-codex:adversarial-review
/opnd-codex:adversarial-review --base main challenge whether this was the right caching and retry design
/opnd-codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/opnd-codex:pair`

Asks Codex for a foreground, read-only pair-programming pass. Use this for second opinions, plan critique, focused risk review, or decision triage where Claude should keep control of the main workflow.

It supports `--task-key <key>` for session reuse, `--capsule <path>` for large prompt capsules under `.claude/cache/codex-capsules/`, `--output-profile <name>` for structured output, and `--background` when the pass is no longer short.

Examples:

```bash
/opnd-codex:pair --task-key auth-plan --output-profile plan-review review this plan for hidden coupling
/opnd-codex:pair --capsule .claude/cache/codex-capsules/auth-plan.md --task-key auth-plan
/opnd-codex:pair --background --task-key perf-risk check the tradeoffs independently
```

### `/opnd-codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, `--resume-id <thread-id>`, and `--fresh`. If you omit all of these, the plugin can offer to continue the latest rescue thread for this repo.

Runtime control flags (all per-invocation, never modify your config):

- `--sandbox <read-only|workspace-write|danger-full-access>` — explicit sandbox override
- `--full-access` / `--dangerously-skip-permissions` — shorthand for `--sandbox danger-full-access --approval never` (prints a stderr warning)
- `--profile <name>` — select a `[profiles.<name>]` block from `~/.codex/config.toml`. Forces a direct codex spawn (broker is bypassed)
- `--fast` — request the Codex fast service tier (~1.5x speed / ~2x credits) via `-c service_tier=fast`
- `--context <text>` — prepend a `<context>...</context>` block before the prompt for cheap orientation
- `--prompt-file <path>` / `--prompt-stdin` — use a file or stdin for the prompt. Required when the prompt exceeds ~3 KB to avoid the upstream argv-size rejection

Examples:

```bash
/opnd-codex:rescue investigate why the tests started failing
/opnd-codex:rescue fix the failing test with the smallest safe patch
/opnd-codex:rescue --resume apply the top fix from the last run
/opnd-codex:rescue --resume-id 019e2ed4-73c7-7530-aaa5-8a0f4167a4c5 keep going on that thread
/opnd-codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/opnd-codex:rescue --model spark --fast fix the issue quickly
/opnd-codex:rescue --profile review-fast --background look for races
/opnd-codex:rescue --sandbox danger-full-access run the migration in this externally sandboxed environment
/opnd-codex:rescue --full-access run the migration in this externally sandboxed environment
/opnd-codex:rescue --context "working on auth module" investigate the 401 loop
/opnd-codex:rescue --prompt-file ./big-prompt.md investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo
- **(v2.0.0)** if you do not pass `--sandbox`, the plugin inherits `sandbox_mode` from your `~/.codex/config.toml` (was hard-coded to `read-only` / `workspace-write` in v1.x). See [docs/MIGRATION_v2.0.md](docs/MIGRATION_v2.0.md) to restore legacy behavior with `CODEX_PLUGIN_SANDBOX_DEFAULT=read-only`
- `danger-full-access` should only be used when the machine or surrounding environment is already sandboxed

### `/opnd-codex:agent`

Starts Codex as a long-running, approval-aware task agent. This is the preferred command when you want Claude Code to delegate substantial implementation or debugging work and keep controlling it from Claude.

By default, `/opnd-codex:agent` starts a write-capable background task with `--approval on-request`. Codex can pause for command, file-change, permission, or tool approval, and `/opnd-codex:status` will show the pending approval IDs.

Examples:

```bash
/opnd-codex:agent fix the failing integration test end to end
/opnd-codex:agent --sandbox danger-full-access run the migration in this externally sandboxed environment
/opnd-codex:agent --wait --approval never inspect the current failure without stopping for approval
```

When Codex requests approval:

```bash
/opnd-codex:status
/opnd-codex:approve approval-abc123
/opnd-codex:deny approval-abc123
```

### `/opnd-codex:continue`

Sends a follow-up instruction to a Codex task. If the task is still running, the command steers the active turn. If it already finished, it starts a new turn on the same Codex thread.

Examples:

```bash
/opnd-codex:continue focus on the failing assertion and rerun the narrow test
/opnd-codex:continue --job task-abc123 apply the smaller fix instead
/opnd-codex:continue --task-key auth-plan incorporate the result digest and check the next risk
```

### `/opnd-codex:approve` and `/opnd-codex:deny`

Resolves a pending Codex approval request. Use `/opnd-codex:status` to find the approval ID.

Examples:

```bash
/opnd-codex:approve approval-abc123
/opnd-codex:approve approval-abc123 --session
/opnd-codex:deny approval-abc123
```

### `/opnd-codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/opnd-codex:status
/opnd-codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/opnd-codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.
Use `--digest` when Claude only needs the compact handoff fields for a follow-up prompt.

Examples:

```bash
/opnd-codex:result
/opnd-codex:result task-abc123
/opnd-codex:result --digest task-abc123
```

### `/opnd-codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/opnd-codex:cancel
/opnd-codex:cancel task-abc123
```

### `/opnd-codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/opnd-codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/opnd-codex:setup --enable-review-gate
/opnd-codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/opnd-codex:review
```

### Hand A Problem To Codex

```bash
/opnd-codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

Foreground rescues / reviews are capped at the upstream Claude Code Bash tool's ~600 s ceiling. A rescue that runs longer is killed by Claude Code before Codex finishes, and there is no jobId to resume — pick `--background` whenever you expect a deep refactor, full-repo audit, or open-ended investigation. If you forget, the `codex:codex-rescue` subagent will surface a one-line notice in front of the result reminding you to re-issue with `--background` next time.

```bash
/opnd-codex:adversarial-review --background
/opnd-codex:rescue --background investigate the flaky test
```

Each background invocation prints a jobId of the form `task-<…>` immediately (no waiting). Poll progress with:

```bash
/opnd-codex:status                       # show every active job in the workspace
/opnd-codex:status task-mp7sdta9-ppf8we  # show one job
/opnd-codex:status --wait task-mp7sdta9-ppf8we   # block until terminal (completed/failed/cancelled)
```

Retrieve the final output:

```bash
/opnd-codex:result task-mp7sdta9-ppf8we           # one-shot — empty if still running
/opnd-codex:result --wait task-mp7sdta9-ppf8we    # block until the job reaches a terminal state, then print
```

If you decide partway through that the job should stop:

```bash
/opnd-codex:cancel task-mp7sdta9-ppf8we
```

## v2.0.0 Defaults & First-Run Setup

If you are coming from v1.x, the v2.0.0 release shipped two BREAKING default changes that you need to know about — both are opt-out. The first invocation per shell prints a one-shot stderr notice naming both; this section summarizes the actionable parts.

### Sandbox now inherits your `~/.codex/config.toml`

v1.x hard-coded `sandbox: "read-only"` (review / read-only task) and `sandbox: "workspace-write"` (`--write` task), overriding whatever you had configured in `~/.codex/config.toml`. v2.0.0 omits the field unless you pass `--sandbox` explicitly, so the codex app-server picks up your `sandbox_mode` instead. Most users benefit silently. If your CI or workflow relied on the v1.x hard-coded values, restore them with:

```bash
export CODEX_PLUGIN_SANDBOX_DEFAULT=read-only        # or workspace-write
```

Full migration notes and per-environment guidance: [`docs/MIGRATION_v2.0.md`](docs/MIGRATION_v2.0.md).

### Plugin codex sessions are isolated from Codex Desktop

To stop plugin-launched threads from burying your real Codex Desktop conversations, v2.0.0 spawns codex with `CODEX_HOME=$HOME/.codex/claude-code/` instead of the shared `~/.codex/`. Side effect: **`codex login` writes the OpenAI token into `~/.codex/auth.json`, not the plugin home**, so `/opnd-codex:setup` will keep reporting `loggedIn: false` until you either copy the token or log in directly into the plugin home. Three equivalent fixes:

```bash
# Option A — one-time copy (preserves history isolation; repeat after token rotation)
cp ~/.codex/auth.json ~/.codex/claude-code/auth.json

# Option B — log in directly into the plugin home (no copy needed; re-runnable)
CODEX_HOME="$HOME/.codex/claude-code" codex login

# Option C — opt out of the isolation entirely (restores v1.x shared home)
export CODEX_PLUGIN_USE_DEFAULT_HOME=1
```

Diagnostic walkthrough and edge cases: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) (the "loggedIn: false after codex login" + "Codex Desktop history pollution" sections).

### Silence the first-run notice

```bash
export CODEX_PLUGIN_SUPPRESS_V2_NOTICE=1
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/opnd-codex:result` or `/opnd-codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/opnd-codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

### Why can't Claude run `/opnd-codex:status` (or `/opnd-codex:review`, `/opnd-codex:cancel`, …) on its own?

Nine commands — `/opnd-codex:review`, `/opnd-codex:adversarial-review`, `/opnd-codex:agent`, `/opnd-codex:continue`, `/opnd-codex:status`, `/opnd-codex:result`, `/opnd-codex:cancel`, `/opnd-codex:approve`, `/opnd-codex:deny` — are marked `disable-model-invocation: true`. Claude Code's harness will not let the assistant auto-invoke them mid-reasoning; **only you (the human) can type them**.

This is deliberate: these commands start or steer Codex runs (which cost tokens), mutate job state, or gate session-end review. Letting the assistant fire them autonomously could burn budget or take side-effecting actions without your explicit intent.

What this means in practice:

- To act on a Codex job, **run the command yourself** (e.g. type `/opnd-codex:status`), then ask Claude — it can read the printed output and reason about it.
- For work you *do* want Claude to drive autonomously, use **`/opnd-codex:rescue`** — it is model-invocable (it delegates through the `codex:codex-rescue` subagent via the Agent tool) and is the intended entry point for assistant-driven Codex delegation.
- There is no flag to flip this per-session; the policy is set in each command's frontmatter by design.
