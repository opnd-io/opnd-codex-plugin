// 테스트 프로세스(및 그것이 spawn 하는 모든 자식)의 env 를 만든다.
//
// `tests/helpers.mjs` 의 `run()` 은 `options.env` 가 없으면 `spawnSync` 에 env 를 넘기지
// 않으므로, 자식이 부모 env 를 통째로 상속한다. 그래서 개발자의 Claude Code 세션이 주입한
// 변수가 스위트 안까지 흘러든다.
//
// 두 가지를 제거한다:
//
//   1. 세션 신원 (`CODEX_COMPANION_SESSION_ID` / `CODEX_COMPANION_TRANSCRIPT_PATH`).
//      SessionStart 훅이 주입한다. `filterJobsForCurrentSession` 은 sessionId 가 세워져
//      있으면 그것과 일치하지 않는 job 을 전부 걸러내는데, fixture 는 sessionId 를 세우지
//      않는다 → `status` / `result` 가 "job 없음" 을 보고하며 실패한다. Claude Code 세션
//      안에서만 실패하고 CI 에서는 통과하므로, 오랫동안 Windows fake-codex 문제로 잘못
//      귀인돼 있었다. 세션 신원을 필요로 하는 테스트는 spawn 마다 직접 세운다.
//
//   2. telemetry 목적지 무력화 (O1). 스위트가 사용자의 실제 ledger 에 fixture 이벤트를
//      append 했다. 이쪽은 기본값이므로, 실제 write 를 관찰해야 하는 테스트는 호출자 env
//      에 명시적 값을 두어 opt-out 한다 (아래 spread 순서가 그것을 보장한다).
//
// `CODEX_PLUGIN_DATA_DIR` 는 의도적으로 남긴다: job/state 디렉터리도 그것으로 해석되므로,
// 옮기면 스위트가 실제로 무엇을 테스트하는지가 달라진다 (tests/telemetry-isolation.mjs 참조).

/** SessionStart 훅이 주입하는 현재 세션 신원. 테스트가 상속하면 안 된다. */
export const SESSION_SCOPED_ENV_KEYS = ["CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH"];

/**
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function buildTestChildEnv(baseEnv) {
  const env = {
    // 호출자 env 의 명시적 값이 뒤에 spread 되어 이긴다 (opt-out 경로).
    CODEX_PLUGIN_TELEMETRY_DISABLED: "1",
    CODEX_PLUGIN_SUPPRESS_V2_NOTICE: "1",
    ...baseEnv
  };
  // 반대로 세션 신원은 opt-out 이 없다. 상속된 값은 언제나 오염이다.
  for (const key of SESSION_SCOPED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}
