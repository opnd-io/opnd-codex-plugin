# Changelog

## 1.0.4

- `/codex:agent`: approval-aware control with `--approval` policy (`never` / `on-request` / `on-failure` / `untrusted`) and pending-approval surfacing in `/codex:status`
- `/codex:rescue` and `/codex:agent`: `--sandbox` override (`read-only` / `workspace-write` / `danger-full-access`) for explicit sandbox control
- Hardened approval controls: stricter approval state tracking and risk classification
- Windows companion runtime: hardened test suite for cross-platform consistency
- `/codex:rescue`: routes through the Agent tool to prevent Skill recursion
- Bash arg quoting fix for `cancel`, `result`, `status` commands
- README: corrected invalid `xhigh` reasoning effort
- `codex-rescue` agent: `model:` declared in frontmatter
- Companion: honors `--cwd` when reporting session runtime

## 1.0.3

- App-server auth status used for Codex readiness
- Graceful handling of older Codex CLI without `thread/name/set`
- App-server spawn inherits `process.env` when no explicit env is provided
- Windows: respects `SHELL` for Git Bash
- Working-tree review no longer crashes on untracked directories
- Implicit resume-last and default cancel selection scoped to the current Claude session

## 1.0.2

- CI: pull request workflow added (tests + build)
- Tests: portable across platforms, repo roots derived from test file locations
- Reduced background task timing flakiness in tests
- Windows ENOENT fix when spawning `codex app-server`

## 1.0.1

- Windows: `shell: true` on `spawnSync` so `.cmd` shims resolve

## 1.0.0

- Initial version of the Codex plugin for Claude Code
