#!/usr/bin/env node
/**
 * MCP 端到端验证 — 一键测试所有连通性
 */
import { loadEnvFile } from "../lib/env-file.mjs";
import { checkJiraReachable } from "../lib/jira-client.mjs";
import { checkLarkReachable } from "../lib/lark-base-sync.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(__dirname);
const envPath = process.env.JIRA_LARK_ENV_FILE || `${homedir()}/.config/jira-lark-sync/env`;
const env = { ...process.env, ...loadEnvFile(envPath) };

const results = [];

function log(label, ok, detail = "") {
  const icon = ok ? "✓" : "✗";
  results.push({ label, ok });
  console.log(`  ${icon} ${label}${detail ? " — " + detail : ""}`);
}

console.log("\n=== Jira-Lark MCP 端到端验证 ===\n");

// 1. sync-server
console.log("[1] sync-server (localhost:8787)");
try {
  const resp = await fetch("http://127.0.0.1:8787/health", { signal: AbortSignal.timeout(5000) });
  const data = await resp.json();
  log("服务运行中", data.ok);
  log("事件监听器", Boolean(data.event?.listener_running), data.event?.listener_running ? "WebSocket 已连接" : "未运行");
  log("增量刷新启用", Boolean(data.incremental?.enabled));
} catch (err) {
  log("服务运行中", false, err.message);
}

// 2. Jira
console.log("\n[2] Jira 连通性");
try {
  const result = await checkJiraReachable(env, { enabled: true, timeoutMs: 10000 });
  log("Jira 可达", result.ok, result.ok ? `认证用户: ${result.authenticated_user}` : `HTTP ${result.status || result.error}`);
} catch (err) {
  log("Jira 可达", false, err.message);
}

// 3. Lark
console.log("\n[3] Lark 连通性 (lark-cli)");
try {
  const result = checkLarkReachable({ env, cwd: projectDir, timeout: 15000 });
  log("Lark 可达", result.ok, result.ok ? "table-list 成功" : result.error?.slice(0, 100));
} catch (err) {
  log("Lark 可达", false, err.message);
}

// Summary
const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n=== 结果: ${passed}/${total} 通过 ===\n`);
if (passed === total) {
  console.log("全部通过！可以把 MCP server 配到 Claude Desktop 了。");
} else {
  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  console.log("未通过项:", failed.join(", "));
}
process.exit(passed === total ? 0 : 1);
