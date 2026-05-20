import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildApprovalResponse,
  classifyApprovalRisk,
  createPendingApprovalRecord
} from "../plugins/opnd-codex/scripts/lib/approvals.mjs";
import { makeTempDir } from "./helpers.mjs";

test("approval records redact command secrets before persistence", () => {
  const record = createPendingApprovalRecord({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "curl -H 'Authorization: Bearer abc123' https://example.test?api_key=sk-secret123456",
      reason: "uses token=ghp_secret1234567890"
    }
  });

  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /abc123/);
  assert.doesNotMatch(serialized, /sk-secret123456/);
  assert.doesNotMatch(serialized, /ghp_secret1234567890/);
  assert.match(serialized, /REDACTED/);
});

test("permission approval only grants workspace-scoped filesystem paths", () => {
  const workspace = makeTempDir();
  const inside = path.join(workspace, "allowed.txt");
  const outside = path.dirname(workspace);
  const record = createPendingApprovalRecord({
    id: "approval-2",
    method: "item/permissions/requestApproval",
    params: {
      cwd: workspace,
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: [inside, outside],
          write: [inside, outside],
          entries: [
            { path: { type: "path", path: inside }, access: "write" },
            { path: { type: "path", path: outside }, access: "write" },
            { path: { type: "special", value: { kind: "root" } }, access: "write" },
            { path: { type: "special", value: { kind: "project_roots", subpath: "src" } }, access: "read" }
          ]
        }
      }
    }
  });

  const response = buildApprovalResponse({
    ...record,
    status: "approved",
    decision: { action: "approve" }
  });

  assert.deepEqual(response.permissions.network, { enabled: true });
  assert.deepEqual(response.permissions.fileSystem.read, [inside]);
  assert.deepEqual(response.permissions.fileSystem.write, [inside]);
  assert.deepEqual(response.permissions.fileSystem.entries, [
    { path: { type: "path", path: inside }, access: "write" },
    { path: { type: "special", value: { kind: "project_roots", subpath: "src" } }, access: "read" }
  ]);
});

test("powershell broad recursive delete is hard-denied", () => {
  const risk = classifyApprovalRisk({
    params: {
      command: "Remove-Item -Recurse -Force $HOME"
    }
  });

  assert.equal(risk.hardDeny, true);
  assert.equal(risk.level, "critical");
});
