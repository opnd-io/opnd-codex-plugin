## Additional reproduction — single-use refresh token rotation hypothesis confirmed (2026-05-28, follow-up)

Captured a clean back-to-back trace in the same Claude Code session that confirms
the hypothesis from the original report (`setup --json` advisory is a cached
view of an already-rotated refresh token).

### Sequence

1. **`opnd-codex:setup --json`** (after the user re-authenticated):
   ```
   ready: true
   loggedIn: true
   verified: true
   detail: ChatGPT login active for <user-email-redacted>
   sessionRuntime.mode: direct startup
   ```
2. **1st rescue call — foreground, tiny prompt** (`Codex 연결 헬스 체크 / OK 만 출력하라`):
   - ✅ **Success.** `tool_uses:0, duration_ms:4150`. Codex replied with `OK / ...`.
3. **2nd rescue call — background, large audit prompt** (~3.5 KB, NOINDEX+tkmix audit):
   - ❌ **Fail.** `Your access token could not be refreshed because your refresh token was already used.`
4. **`opnd-codex:setup --json` again, immediately after the fail**:
   ```
   ready: false
   loggedIn: false
   verified: null
   detail: The active provider requires OpenAI authentication
   sessionRuntime.mode: shared
   sessionRuntime.endpoint: pipe:\\.\pipe\cxc-4s5skG-codex-app-server
   ```

### What this shows

- The 1st rescue call consumed and rotated the ChatGPT refresh token (single-use
  rotation policy on the OpenAI side).
- The 2nd rescue call tried to start a new app-server session using the
  already-rotated token → reuse detection → 401.
- Crucially, **`setup --json` correctly reflects the broken state *only after*
  a failed call rolls the cache** (step 4 reports `loggedIn:false` honestly).
  In step 1, `setup --json` read the cached "fresh after login" token and
  declared `verified:true`, but had no way to know the next rescue invocation
  would consume it.
- The `sessionRuntime.mode` also flips: `direct` → `shared` once the first
  call leaves a pipe behind. The shared pipe survives the auth failure, so
  subsequent calls hit the dead pipe (issue #2 step 5 pattern).

### What the host harness saw

Same as issue #2: the harness saw `verified:true`, started background work,
got the same `refresh token already used` error, and had no signal in advance
that the 2nd call would fail. Setup advisory remains a false-positive predictor.

### Suggested fix direction

- `setup --json` should either:
  - actually issue a no-op app-server probe before declaring `verified:true`
    (consuming the refresh token slot the same way a real rescue call would),
  - **or** stop emitting `verified:true` entirely when `authMethod=chatgpt`,
    and instead emit `verified:cached` so harness authors know the green light
    is advisory only.
- Alternatively, gate the **shared sessionRuntime** so that once a call fails
  with `refresh token already used`, the pipe is torn down and the next
  `setup --json` doesn't keep dangling a dead pipe in `sessionRuntime.endpoint`.

(이 텍스트는 #2 코멘트로 그대로 붙여 쓸 수 있도록 영문 위주로 작성.)
