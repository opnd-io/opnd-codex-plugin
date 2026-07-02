import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  // 두 경로를 분리 해석해 에러가 실제 원인(source 부재/읽기불가 vs projects
  // 디렉토리 부재)을 가리키게 한다 — 항상 source 파일 탓으로 돌리지 않도록.
  let source;
  try {
    source = fs.realpathSync(sourcePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Claude session file not found: ${sourcePath}`);
    }
    throw new Error(`Could not read Claude session file (${error?.code ?? "error"}): ${sourcePath}`);
  }
  let projects;
  try {
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude projects directory not found: ${CLAUDE_PROJECTS_DIR}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Codex can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  // resolved 경로에 대해 확장자 재검사: 첫 검사는 realpath 이전 경로에 대해
  // 돌아서, projects 내부의 symlink `x.jsonl`(secret.txt 로 resolve)이 non-JSONL
  // 파일을 게이트로 통과시킬 수 있다(SEC-001). 봉쇄는 위에서 이미 성립 —
  // 여기서 .jsonl 보장을 실제로 만든다.
  if (path.extname(source) !== ".jsonl") {
    throw new Error(`Claude session source must resolve to a JSONL file: ${source}`);
  }
  return source;
}
