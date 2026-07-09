// O1 — `npm test` *바깥* 에서 시작한 테스트 프로세스를 위한 telemetry 격리. 사용법:
// `node --import ./tests/telemetry-isolation.mjs --test tests/some.test.mjs` 처럼 preload 한다.
//
// `npm test` 는 이 파일을 쓰지 않는다: `scripts/run-tests.mjs` 가 같은 변수를 자식 env 에
// 주입하고, 모든 후손이 Node 버전과 무관하게 상속한다. 여기서도 preload 하면 이미 지켜진
// 경로를 지키는 두 번째 레이어가 된다. 이 파일은 env 를 아무도 세우지 않는 "파일 하나씩"
// 워크플로를 위한 것이다.
//
// 왜 중요한가: telemetry writer 는 목적지를 `CODEX_PLUGIN_DATA_DIR` / `CLAUDE_PLUGIN_DATA`
// 에서 해석한다. Claude Code 세션 안에서 그것은 사용자의 실제 ledger 를 가리키므로, 이벤트를
// emit 한 테스트가 프로덕션 데이터에 그대로 썼다. 실제로 그랬다: 기록된 9,935 이벤트 중
// 7,284 가 스위트에서 나왔고, fixture job id 하나가 `terminated` 이벤트 72건을 기여했으며,
// 스트림에서 유도한 모든 실패율이 몇 배로 부풀었다.
//
// 격리가 기본값이다. 실제 write 를 관찰해야 하는 테스트는 변수를 직접 세우거나(아래 키 존재
// 검사가 그것을 존중한다) `emitEvent` 에 명시적 `env` 를 넘겨 opt-out 한다.
//
// 여기서 CODEX_PLUGIN_DATA_DIR 는 의도적으로 리다이렉트하지 *않는다*: 그 변수는 job/state
// 디렉터리도 해석하므로, 옮기면 스위트가 실제로 무엇을 테스트하는지가 달라진다. writer 를
// 끄는 것으로 충분하다 — `emitEvent` 는 파일시스템에 닿기 전에 단락된다.
if (!("CODEX_PLUGIN_TELEMETRY_DISABLED" in process.env)) {
  process.env.CODEX_PLUGIN_TELEMETRY_DISABLED = "1";
}

// v2.0.0 breaking-change 배너는 프로세스마다 첫 companion 호출에서 stderr 로 쓰인다.
// 테스트 출력에서 소음이고, 더 중요하게는 stderr assertion 을 취약하게 만든다.
if (!("CODEX_PLUGIN_SUPPRESS_V2_NOTICE" in process.env)) {
  process.env.CODEX_PLUGIN_SUPPRESS_V2_NOTICE = "1";
}
