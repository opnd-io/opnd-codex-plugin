#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// #338 — codex-namespaced var first (see session-lifecycle-hook.mjs), then the
// generic CLAUDE_PLUGIN_DATA (hook context), then the tmpdir fallback.
const pluginData =
  process.env.CODEX_PLUGIN_DATA_DIR ?? process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), "codex-companion");
const telemetryFile = path.join(pluginData, "telemetry", "events.jsonl");

function readEvents(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function summarize(events) {
  const byEvent = new Map();
  const byProfile = new Map();
  const failures = new Map();
  for (const event of events) {
    byEvent.set(event.event, (byEvent.get(event.event) ?? 0) + 1);
    const profile = event.extras?.outputProfile ?? "none";
    byProfile.set(profile, (byProfile.get(profile) ?? 0) + 1);
    const failureClass = event.extras?.failureClass ?? event.errorClass ?? null;
    if (failureClass) {
      failures.set(failureClass, (failures.get(failureClass) ?? 0) + 1);
    }
  }
  return {
    telemetryFile,
    totalEvents: events.length,
    events: Object.fromEntries([...byEvent.entries()].sort()),
    outputProfiles: Object.fromEntries([...byProfile.entries()].sort()),
    failures: Object.fromEntries([...failures.entries()].sort())
  };
}

const json = process.argv.includes("--json");
const report = summarize(readEvents(telemetryFile));
if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      "# Codex Efficiency Report",
      "",
      `Telemetry: ${report.telemetryFile}`,
      `Events: ${report.totalEvents}`,
      "",
      `By event: ${JSON.stringify(report.events)}`,
      `By output profile: ${JSON.stringify(report.outputProfiles)}`,
      `Failures: ${JSON.stringify(report.failures)}`
    ].join("\n") + "\n"
  );
}
