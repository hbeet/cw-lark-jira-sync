#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = process.env.JIRA_LARK_RUNTIME_DIR || `${homedir()}/.local/share/jira-lark-sync`;
const plistLabel = process.env.JIRA_LARK_LAUNCHD_LABEL || "com.legend.jira-lark-sync";
const healthUrl = process.env.JIRA_LARK_HEALTH_URL || "http://127.0.0.1:8787/health";
const uid = process.getuid?.();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceDir,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${details ? `\n${details}` : ""}`);
  }
  return result.stdout || "";
}

function rsync(paths) {
  run("rsync", [
    "-a",
    "--delete",
    "--include", ".env.example",
    "--exclude", ".env",
    "--exclude", ".env.*",
    "--exclude", ".venv-lark-sdk",
    "--exclude", "cache",
    "--exclude", "logs",
    "--exclude", "node_modules",
    ...paths,
    `${runtimeDir}/`,
  ]);
}

async function waitForHealth() {
  const deadline = Date.now() + 120000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (!response.ok) throw new Error(`status=${response.status}`);
      const status = await response.json();
      const ok = status.startup_readiness?.ok
        && status.event?.listener_running
        && !status.running
        && Number(status.queued || 0) === 0;
      if (ok) {
        console.log(`health ok: queued=${Number(status.queued || 0)} event_listener=${Boolean(status.event?.listener_running)}`);
        return;
      }
      lastError = `queued=${Number(status.queued || 0)} event=${Boolean(status.event?.listener_running)} startup=${Boolean(status.startup_readiness?.ok)}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`service did not become healthy: ${lastError}`);
}

mkdirSync(runtimeDir, { recursive: true });

console.log(`source: ${sourceDir}`);
console.log(`runtime: ${runtimeDir}`);

run("npm", ["run", "check"]);
rsync([
  "sync-server.mjs",
  "sync-runner.mjs",
  "lark_event_listener.py",
  "run-sync-server.sh",
  "package.json",
  "README.md",
  ".env.example",
  "config",
  "lark_user_map.tsv",
  "jira_lark_fields.json",
  "lib",
  "docs",
  "scripts",
  "test",
]);

for (const stalePath of [
  `${runtimeDir}/rotate-jira-token.mjs`,
]) {
  rmSync(stalePath, { force: true });
}

run("chmod", [
  "700",
  `${runtimeDir}/sync-server.mjs`,
  `${runtimeDir}/sync-runner.mjs`,
  `${runtimeDir}/run-sync-server.sh`,
]);

if (uid !== undefined && existsSync(`${homedir()}/Library/LaunchAgents/${plistLabel}.plist`)) {
  run("launchctl", ["kickstart", "-k", `gui/${uid}/${plistLabel}`]);
  console.log(`restarted launchd service: ${plistLabel}`);
  await waitForHealth();
} else {
  console.log("launchd service not restarted; plist not found");
}

console.log("deploy complete");
