import path from "node:path";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "execCommandApproval"
]);

export const VALID_APPROVAL_POLICIES = new Set(["never", "on-request", "on-failure", "untrusted"]);

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function redactText(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|token|authorization|password|secret)=)[^\s&]+/gi, "$1[REDACTED]");
}

function redactValue(value, depth = 0) {
  if (depth > 12) {
    return "[REDACTED_DEPTH]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(authorization|password|secret|token|api[_-]?key)/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactValue(entry, depth + 1);
      }
    }
    return result;
  }
  return value;
}

function isPathInside(basePath, candidatePath) {
  if (!basePath || !candidatePath) {
    return false;
  }
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function filterWorkspacePaths(paths, cwd) {
  if (!Array.isArray(paths)) {
    return null;
  }
  const filtered = paths.filter((entry) => typeof entry === "string" && isPathInside(cwd, entry));
  return filtered.length > 0 ? filtered : null;
}

function isSafeProjectSubpath(value) {
  if (value == null) {
    return true;
  }
  const text = String(value);
  return text !== "" && !path.isAbsolute(text) && !text.split(/[\\/]+/).includes("..");
}

function filterFileSystemEntries(entries, cwd) {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const filtered = entries.filter((entry) => {
    const entryPath = entry?.path;
    if (!entryPath || (entry.access !== "read" && entry.access !== "write" && entry.access !== "none")) {
      return false;
    }
    if (entryPath.type === "path") {
      return isPathInside(cwd, entryPath.path);
    }
    if (entryPath.type === "special" && entryPath.value?.kind === "project_roots") {
      return isSafeProjectSubpath(entryPath.value.subpath);
    }
    return false;
  });
  return filtered.length > 0 ? filtered : undefined;
}

function buildSafeFileSystemPermissions(fileSystem, cwd) {
  if (!fileSystem || typeof fileSystem !== "object") {
    return null;
  }
  const read = filterWorkspacePaths(fileSystem.read, cwd);
  const write = filterWorkspacePaths(fileSystem.write, cwd);
  const entries = filterFileSystemEntries(fileSystem.entries, cwd);
  if (!read && !write && !entries) {
    return null;
  }
  return {
    read,
    write,
    ...(typeof fileSystem.globScanMaxDepth === "number" ? { globScanMaxDepth: fileSystem.globScanMaxDepth } : {}),
    ...(entries ? { entries } : {})
  };
}

function buildSafeNetworkPermissions(network) {
  if (!network || typeof network !== "object" || typeof network.enabled !== "boolean") {
    return null;
  }
  return { enabled: network.enabled };
}

export function normalizeApprovalPolicy(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_APPROVAL_POLICIES.has(normalized)) {
    throw new Error('Unsupported approval policy "' + value + '". Use one of: never, on-request, on-failure, untrusted.');
  }
  return normalized;
}

export function isApprovalRequestMethod(method) {
  return APPROVAL_METHODS.has(method);
}

function summarizeApprovalParams(method, params = {}) {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return params.command ? `Command: ${params.command}` : "Command execution approval requested.";
    case "execCommandApproval":
      return Array.isArray(params.command) ? `Command: ${params.command.join(" ")}` : "Command execution approval requested.";
    case "item/fileChange/requestApproval":
      return params.grantRoot ? `File change approval for ${params.grantRoot}` : "File change approval requested.";
    case "applyPatchApproval": {
      const files = Object.keys(params.fileChanges ?? {});
      return files.length > 0 ? `Patch approval for ${files.join(", ")}` : "Patch approval requested.";
    }
    case "item/permissions/requestApproval":
      return params.reason || `Permission approval requested for ${params.cwd ?? "workspace"}.`;
    case "item/tool/requestUserInput":
      return `User input requested (${(params.questions ?? []).length} question(s)).`;
    case "mcpServer/elicitation/request":
      return params.message ? `${params.serverName}: ${params.message}` : `MCP elicitation from ${params.serverName}.`;
    case "item/tool/call":
      return params.tool ? `Dynamic tool call: ${params.tool}` : "Dynamic tool call requested.";
    case "account/chatgptAuthTokens/refresh":
      return `ChatGPT auth token refresh requested (${params.reason ?? "unknown reason"}).`;
    default:
      return `${method} requested.`;
  }
}

function extractApprovalThreadId(method, params = {}) {
  return params.threadId ?? params.conversationId ?? null;
}

function extractApprovalTurnId(_method, params = {}) {
  return params.turnId ?? null;
}

function commandTextForRecord(record) {
  const params = record.params ?? {};
  if (typeof params.command === "string") {
    return params.command;
  }
  if (Array.isArray(params.command)) {
    return params.command.join(" ");
  }
  return "";
}

export function classifyApprovalRisk(record) {
  const command = commandTextForRecord(record);
  if (!command) {
    return { level: "medium", hardDeny: false, reason: null };
  }

  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  const hardDenyPatterns = [
    /\brm\s+-[^\n]*r[^\n]*f[^\n]*(\s+\/|\s+~|\s+\$home|\s+%userprofile%)/i,
    /\bremove-item\b[^\n]*(\s+-recurse\b|\s+-r\b)[^\n]*(\s+-force\b|\s+-f\b)[^\n]*(\s+\/|\s+~|\s+\$home|\s+%userprofile%|[a-z]:\\\s*$)/i,
    /\b(mkfs|fdisk|diskpart)\b/i,
    /\bdd\s+if=/i,
    /\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b)[^\n]*(\bmain\b|\bmaster\b)/i
  ];

  for (const pattern of hardDenyPatterns) {
    if (pattern.test(normalized)) {
      return {
        level: "critical",
        hardDeny: true,
        reason: "Hard-denied by Claude Codex companion safety policy."
      };
    }
  }

  if (/\b(rm|del|remove-item|move-item|git push|curl|wget|chmod|chown)\b/i.test(normalized)) {
    return { level: "high", hardDeny: false, reason: null };
  }

  return { level: "medium", hardDeny: false, reason: null };
}

export function createPendingApprovalRecord(message) {
  const method = message.method;
  const params = message.params ?? {};
  const risk = classifyApprovalRisk({ method, params });
  const safeParams = redactValue(params);
  return {
    id: `approval-${Date.now().toString(36)}-${randomId()}`,
    rpcId: message.id,
    method,
    threadId: extractApprovalThreadId(method, params),
    turnId: extractApprovalTurnId(method, params),
    itemId: params.itemId ?? params.callId ?? null,
    approvalId: params.approvalId ?? null,
    summary: redactText(summarizeApprovalParams(method, params)),
    reason: params.reason ? redactText(params.reason) : null,
    risk: risk.level,
    hardDeny: risk.hardDeny,
    hardDenyReason: risk.reason,
    status: risk.hardDeny ? "denied" : "pending",
    decision: risk.hardDeny ? { action: "deny", decidedAt: nowIso(), reason: risk.reason } : null,
    responseJson: null,
    params: safeParams,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

export function pendingApprovalCount(approvals = []) {
  return approvals.filter((approval) => approval.status === "pending").length;
}

export function buildApprovalResponse(record) {
  if (record.responseJson && typeof record.responseJson === "object") {
    return record.responseJson;
  }

  const action = record.decision?.action ?? record.status;
  const approved = action === "approve" || action === "approve-session" || action === "approved";
  const session = action === "approve-session";

  switch (record.method) {
    case "item/commandExecution/requestApproval":
      return { decision: approved ? (session ? "acceptForSession" : "accept") : "decline" };
    case "item/fileChange/requestApproval":
      return { decision: approved ? (session ? "acceptForSession" : "accept") : "decline" };
    case "execCommandApproval":
      return { decision: approved ? (session ? "approved_for_session" : "approved") : "denied" };
    case "applyPatchApproval":
      return { decision: approved ? (session ? "approved_for_session" : "approved") : "denied" };
    case "item/permissions/requestApproval":
      if (!approved) {
        return { permissions: {}, scope: "turn", strictAutoReview: true };
      }
      const network = buildSafeNetworkPermissions(record.params?.permissions?.network);
      const fileSystem = buildSafeFileSystemPermissions(record.params?.permissions?.fileSystem, record.params?.cwd);
      return {
        permissions: {
          ...(network ? { network } : {}),
          ...(fileSystem ? { fileSystem } : {})
        },
        scope: session ? "session" : "turn",
        strictAutoReview: false
      };
    case "item/tool/requestUserInput":
      return record.responseJson ?? { answers: {} };
    case "mcpServer/elicitation/request":
      return record.responseJson ?? { action: approved ? "accept" : "decline", content: null, _meta: null };
    case "item/tool/call":
      if (!approved) {
        return { contentItems: [], success: false };
      }
      throw new Error(`${record.method} requires --response-json to approve.`);
    case "account/chatgptAuthTokens/refresh":
      if (!approved) {
        throw new Error("ChatGPT auth token refresh was denied.");
      }
      throw new Error(`${record.method} requires --response-json to approve.`);
    default:
      if (approved && !record.responseJson) {
        throw new Error(`${record.method} requires --response-json to approve.`);
      }
      throw new Error(`${record.method} was ${approved ? "approved" : "denied"} without a supported response payload.`);
  }
}
