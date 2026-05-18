# PR-5.2 follow-up — broker auto-restart on stale auth (design spec, **not implemented**)

**Status**: design proposal, awaiting user approval before any runtime change.
**Author**: autonomous session, 2026-05-18.
**Scope owner (after approval)**: whoever takes PR-5.2-followup-impl.
**Related**: PR-5.2 (v1.0.6, #281) — annotated stale-auth-cache error with restart hint.

---

## 1. Problem (what PR-5.2 left open)

The `codex app-server` broker child caches the OpenAI auth token at startup and never re-reads `~/.codex/auth.json`. After `codex logout && codex login` from the user's shell, the running broker still holds the old token and every subsequent `/codex:rescue`, `/codex:task`, `/codex:adversarial-review` fails with:

```text
[codex] Codex error: Your access token could not be refreshed because you have
since logged out or signed in to another account. Please sign in again.
```

even though a direct `codex exec` works fine with the same `~/.codex/auth.json`.

**v1.0.6 PR-5.2 (already shipped)** annotated this error with a "restart Claude Code" hint so the user knows what to do. That hint is sufficient for interactive operators but **breaks unattended runs**:

- A scheduled `claude --print` job hits stale auth, surfaces the hint, exits non-zero. The next scheduled run still hits stale auth (broker still alive). Loop until manual restart.
- A `/codex:rescue --background` job that survives a token rotation fails on the next poll; the user only finds out via `/codex:status`.
- The Stop-review-gate hook (`stop-review-gate-hook.mjs`) can rewake into the same failure cycle the v2.0.0 PR-3.1 classifier was built to prevent (different cause, same shape).

PR-5.2 follow-up is the **auto-restart** path: detect stale-auth on the broker side, terminate the broker cleanly, and let the next request spawn a fresh one that re-reads the auth file.

---

## 2. Why this is a design doc, not an impl PR

Three things need user decision before any code lands:

1. **Safety policy** — auto-restart kills any in-flight broker traffic. Even a single in-flight `/codex:task --background` would be torn down mid-turn. The user has to decide whether "tear down in-flight to fix stale auth" is acceptable, and under what conditions.
2. **Detection signal** — the "stale auth" classifier currently lives in [`plugins/codex/scripts/lib/codex.mjs`](../../plugins/codex/scripts/lib/codex.mjs) annotating the error. Promoting it to a broker-killing signal needs a tighter match (no false positives killing the broker on unrelated auth phrasing).
3. **Restart UX** — does the user see the restart, or is it silent? Loud + transparent is friendlier but pollutes script output; silent is cleaner but hides the actual cause.

This document spells the trade-offs out; once the user picks an option, the impl is small (≈ 100 LOC in `broker-lifecycle.mjs` + tests).

---

## 3. Trigger criteria — when to auto-restart

The broker should only restart when **all** of these hold:

| Predicate | Source of truth | Rationale |
|---|---|---|
| Error from the broker child matches the stale-auth signature exactly | the existing classifier in `lib/codex.mjs` (PR-5.2 v1.0.6) | reuse the regex that already powers the hint annotation; any drift between the two is a bug |
| The error fires within the first turn of a new request (not mid-stream after a long-running turn) | RPC request/response correlation in `app-server.mjs` | mid-stream failures are rarely auth — more often network / sandbox / model-side. Tightening to "first turn" avoids killing a healthy long-running job because of a transient network error |
| `~/.codex/auth.json` (or the plugin home `~/.codex/claude-code/auth.json`) has an `mtime` newer than the broker's `processStartedAt` | `fs.statSync` + the broker session record | confirms the user actually rotated the token. A stale-auth error without a fresh auth file means the broker is right and the user is wrong; restart would just loop |
| No in-flight non-current request — i.e. the only outstanding request is the one that surfaced the auth error | RPC pending-promises map | prevents tearing down an unrelated `/codex:task --background` that happens to be running |
| User has not opted out via env var | `CODEX_PLUGIN_BROKER_AUTORESTART_DISABLED=1` | escape hatch for users who want the explicit-hint behavior |

If any one fails → fall back to the existing v1.0.6 annotated error (no restart).

---

## 4. Restart sequence

1. Surface a one-shot stderr notice **before** the kill so the cause is visible in the script output:

   ```text
   [codex-plugin-cc] broker auth is stale (codex login since broker start at <iso ts>).
   Restarting the broker to pick up the rotated token. Pending request will be retried once.
   ```

2. Call `sendBrokerShutdown()` (already in `broker-lifecycle.mjs`).
3. Wait up to **5 s** for the broker child to exit cleanly. On timeout, `terminateProcessTree(pid)` (existing helper).
4. Clear the in-process broker session cache so the next request spawns fresh.
5. Retry the **same** request exactly once. If the retry hits stale-auth again → fall back to the annotated-error path (the auto-restart loop guard, see § 5).

The retry is critical: without it, the user-visible behavior is "first request fails, second request works", which is worse than the current "every request shows a hint" — the user does not know they have to re-issue the request.

---

## 5. Loop guard

Auto-restart that loops is worse than no auto-restart. Guard against:

- **Repeated stale-auth on the freshly spawned broker** → the rotation itself is broken (bad token, expired key, etc.). After **one** failed retry, mark the broker as `quarantined: true` for the rest of the process lifetime; further requests fall straight through to the annotated-error path without spawning a new broker.
- **Restart storm across rapid requests** → if more than **one restart per 60 s** is triggered, latch into the same quarantined state for 5 min (configurable via `CODEX_PLUGIN_BROKER_AUTORESTART_QUARANTINE_MS`).
- **Concurrent restart attempts** → only one restart at a time, gated by the same `withBrokerLockAsync` pattern that already serializes broker init (see `lib/state.mjs` `withBrokerLockAsync`).

The quarantine state surfaces via `/codex:status` as a stderr-only annotation; jobs themselves still report `failed` with the original auth error so existing dashboards keep working.

---

## 6. Test strategy

Three layers:

1. **Unit (no spawn)** — mock the broker child + RPC layer. Assert:
   - Trigger criteria from § 3 evaluated correctly (each predicate gated individually).
   - Quarantine after one failed retry (§ 5).
   - Single-flight via `withBrokerLockAsync`.
   - Stderr notice fires exactly once per restart.
2. **Integration (fake-codex shim, like the existing tests/runtime.test.mjs pattern)** — spawn the broker with a fake codex that returns the stale-auth string on first turn. Touch `auth.json` mtime to trigger the rotation gate. Assert restart happens + retry succeeds.
3. **Telemetry contract (depends on PR #4 = PR-9.1 merging)** — emit a `broker_auto_restart` event with `traceId`, `reason: "stale-auth"`, `quarantined`, `retrySucceeded` fields. Test asserts the event lands in events.jsonl.

---

## 7. Out of scope (deliberate)

- Auto-restart on broker crashes that are **not** stale-auth. The existing PID-reaper (PR-1.1) and SIGTERM handler (PR-1.2) already handle those. Auto-restart adds value only for the silent-state-on-running-child case.
- Hot-reload of the auth token without process restart. Would need an upstream codex CLI change; out of plugin scope.
- Restart on `LANG` / `LC_ALL` / `CODEX_HOME` mid-session change. PR-4.5 audit finding #2 documented that as a known limitation; addressing it would need the same locking-and-quarantine machinery as this PR and is a natural follow-on.

---

## 8. User decisions needed (block impl)

1. **Default ON or OFF?** Recommendation: **default ON**, opt-out via `CODEX_PLUGIN_BROKER_AUTORESTART_DISABLED=1`. The current state (always-fail-until-restart-CC) is strictly worse for unattended runs, and the loop guard in § 5 prevents auto-restart from making things worse.
2. **Notify on every restart or only first per process?** Recommendation: **every restart**. The stderr line is one line; users who pipe through `2>/dev/null` already see nothing, and operators investigating an issue need the full timeline.
3. **In-flight tolerance**: kill OR drain? Recommendation: **kill only if the in-flight request is the one that failed auth; otherwise reject the auto-restart and surface the annotated error**. Draining (waiting for in-flight to finish) is gentler but the in-flight requests will also hit stale auth on their own turns and just queue more failures.

Once the user picks (or accepts the recommendations), impl is a separate PR — call it `PR-5.2-followup`.

---

## 9. Filing this design

This document lives at `docs/ultraplan/PR-5.2-broker-restart-design.md` so it is co-located with the other ultraplan artifacts. The SESSION-HANDOFF.md update + a CHANGELOG entry (under v2.1.0 "planned") happen when the user approves the recommendations and the impl PR opens.

No runtime code changes in this PR. No tests added. Pure spec.
