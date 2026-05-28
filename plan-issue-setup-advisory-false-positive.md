# [Bug] `setup --json` reports `loggedIn:true, verified:true` but rescue/agent invocation fails with `refresh token already used`

## Summary

`codex-companion.mjs setup --json` advisory consistently reports the auth as
healthy (`auth.loggedIn:true, auth.verified:true, ready:true`), but the very
next rescue-agent invocation (`Agent({subagent_type:"opnd-codex:codex-rescue"})`)
fails with `Your access token could not be refreshed because your refresh token
was already used.` and never reaches Codex.

Re-running `codex logout && codex login` (or re-authenticating in Codex
Desktop) makes the next `setup --json` succeed again, but the very next
rescue-agent invocation still fails with the same `refresh token already used`
error. Observed **3 consecutive cycles** of (re-auth → setup verified → rescue
fail) in a single session.

This makes the setup verification effectively a **false-positive advisory**:
the host sees green light, retries the work, and burns a Codex session every
time.

## Environment

| Field | Value |
|---|---|
| Plugin | `opnd-io/opnd-codex-plugin` (this repo) |
| Plugin version | `2.1.0` (or latest `Unreleased` per CHANGELOG, observed locally at `plugins/opnd-codex/` HEAD) |
| Codex CLI | `codex-cli 0.130.0; advanced runtime available` |
| Auth source | `app-server` (ChatGPT, `authMethod: chatgpt`) |
| Account | ChatGPT subscription |
| Host | Windows 11 Pro 10.0.26200 (PowerShell + Git Bash) |
| Claude Code | Opus 4.7 harness |
| Locale mitigation | plugin spawns codex with `LANG/LC_ALL=en_US.UTF-8` (non-UTF-8 host locale notice fired) |
| sessionRuntime mode | observed both `shared` (pipe IPC) and `direct` between sessions; no difference in outcome |

## Reproduction

1. From Claude Code, run `/opnd-codex:setup`. Result:
   ```json
   {
     "ready": true,
     "codex": { "available": true, "detail": "codex-cli 0.130.0; advanced runtime available" },
     "auth": { "available": true, "loggedIn": true, "verified": true, "source": "app-server", "authMethod": "chatgpt" }
   }
   ```
2. From Claude Code, spawn a rescue agent (background or foreground) — e.g.
   `Agent({subagent_type:"opnd-codex:codex-rescue", prompt:"<anything>"})`.
3. Agent returns:
   ```
   [codex-rescue] Codex was not invoked — the Bash call failed or was denied.
   Codex 인증 토큰이 만료되어 있습니다 (refresh token already used).
   ```
4. User runs `codex logout && codex login` (or re-authenticates in Codex
   Desktop). `setup --json` reports green again.
5. Spawn rescue agent again — same `refresh token already used` failure.
6. Repeat 3 cycles. Same outcome each time.

## Expected vs Actual

- **Expected**: `setup --json verified:true` predicts that the next
  rescue-agent invocation can actually start a Codex session.
- **Actual**: setup probes a different code path (auth cache / token presence)
  than the rescue agent uses (new session start → uses refresh token →
  reuse-detection error). The two paths disagree, so the green light is
  misleading.

## Impact

- Users waste cycles on `codex logout && codex login` thinking the host harness
  needs a nudge, then the very next call still fails.
- Plugin tools that gate themselves on `setup verified:true` (e.g. router
  default-pair, skip-taxonomy `false_positive_advisory` reason) end up
  recommending Codex pair when the actual call cannot succeed.
- For me specifically: a 5-turn investigation thread ran 3 retries before
  giving up; verification looked healthy each turn, so the harness kept trying.

## Hypothesis

- ChatGPT-auth refresh tokens appear to be **single-use / rotated** in
  codex-cli 0.130.0. `setup` happily reads the cache while it is still valid
  in the file system, but the moment the rescue agent triggers a fresh
  app-server session start, the refresh token has already been consumed by an
  earlier process (Codex Desktop, an earlier plugin call, or an outdated cache
  entry) and rejected.
- The `setup --json verified` check needs to either:
  - actually issue a lightweight ChatGPT app-server probe that consumes a
    refresh-cycle the same way the rescue agent will, **or**
  - treat the auth cache as advisory only and downgrade `verified:true` to a
    softer signal (e.g. `loggedIn:true, verification:cached-only`).

## Suggested next steps for maintainer

1. Reproduce on a Windows + Git Bash + ChatGPT-auth host (the locale notice
   suggests this combination is already known).
2. Decide whether `setup --json` should perform a real app-server round trip
   before declaring `verified:true`, or whether the `verified` field should
   be removed in favor of a softer signal.
3. Document the failure mode in CHANGELOG / README so harness authors can
   choose a non-Codex fallback when 2+ recent rescue invocations have failed
   with `refresh token already used` in the same session.

## Related logs

- 3 consecutive failures captured locally; trace IDs available on request.
- All failures emitted the same string: `Your access token could not be
  refreshed because your refresh token was already used.`
- No `actionsTaken` reported by `setup --json` between the 3 cycles.

---

(이 파일은 사용자가 `opnd-io/opnd-codex-plugin` 의 이슈 기능을 활성화한 뒤
`gh issue create --body-file <이 파일> --title ...` 로 등록할 수 있도록 작성된
draft. 한글 + 영문 혼용 — 사용자 환경에 맞춰 가다듬어도 됨.)
