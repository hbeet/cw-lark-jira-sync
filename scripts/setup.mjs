#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ask, commandExists, confirm, createRl, openUrl,
  parseLarkUrl, readSecretFromTty, resolveLarkBaseToken, runCapture, verifyJira,
} from "../lib/cli-utils.mjs";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME;
const configDir = `${home}/.config/jira-lark-sync`;
const runtimeDir = `${home}/.local/share/jira-lark-sync`;
const envFile = `${configDir}/env`;
const plistLabel = "com.legend.jira-lark-sync";
const plistPath = `${home}/Library/LaunchAgents/${plistLabel}.plist`;
const defaultJiraUrl = "https://jira.legenddigital.work";

const rl = createRl();

function step(n, title) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  Step ${n}: ${title}`);
  console.log(`${"─".repeat(50)}\n`);
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function success(message) {
  console.log(`✅ ${message}`);
}

async function waitForEnter(message = "完成后按回车继续...") {
  await rl.question(message);
}

// ─── Step 1: Node.js ─────────────────────────────────────────
step(1, "检查 Node.js");
const nodeVersion = Number(process.version.match(/^v(\d+)/)?.[1] || 0);
if (nodeVersion < 22) {
  fail(`需要 Node.js >= 22，当前版本 ${process.version}\n  安装: https://nodejs.org/ 或 brew install node`);
}
success(`Node.js ${process.version}`);

// ─── Step 2: lark-cli ────────────────────────────────────────
step(2, "检查 lark-cli");
if (!commandExists("lark-cli")) {
  console.log("未检测到 lark-cli。请先安装：");
  console.log("  下载地址: https://github.com/anthropics/lark-cli/releases");
  console.log("  安装后确保 lark-cli 在 PATH 中");
  console.log("");
  await waitForEnter("安装完成后按回车继续...");
  if (!commandExists("lark-cli")) {
    fail("仍未检测到 lark-cli，请检查 PATH");
  }
}
const larkVersion = runCapture("lark-cli", ["--version"]);
success(`lark-cli ${larkVersion.stdout.trim()}`);

// ─── Step 3: lark-cli 登录 ──────────────────────────────────
step(3, "lark-cli 登录");
const whoami = runCapture("lark-cli", ["base", "+table-list", "--as", "user", "--base-token", "test", "--format", "json"], { timeout: 15000 });
const isLoggedIn = whoami.ok || !/(login|authen|unauthorized)/i.test(whoami.stderr + whoami.stdout);
if (!isLoggedIn) {
  console.log("需要登录 lark-cli，将打开浏览器进行扫码授权...");
  const login = spawnSync("lark-cli", ["login"], { stdio: "inherit", timeout: 120000 });
  if (login.status !== 0) {
    fail("lark-cli 登录失败");
  }
}
success("lark-cli 已登录");

// ─── Step 4: Jira 配置 ──────────────────────────────────────
step(4, "配置 Jira");
const jiraBaseUrl = await ask(rl, "Jira 地址", defaultJiraUrl);

console.log("\n正在打开 Jira 个人 Token 页面...");
console.log("请在页面中创建一个 Personal Access Token，然后复制回来。\n");
openUrl(`${jiraBaseUrl}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`);

let jiraToken = "";
let jiraUser = "";
while (true) {
  jiraToken = readSecretFromTty("粘贴 Jira Token（输入不可见）: ");
  if (!jiraToken) {
    fail("Token 为空，已取消");
  }
  process.stdout.write("验证中... ");
  const result = await verifyJira(jiraBaseUrl, jiraToken);
  if (result.ok) {
    jiraUser = result.displayName || result.name;
    success(`验证通过，用户: ${jiraUser}`);
    break;
  }
  console.log(`❌ 验证失败: ${result.error || `HTTP ${result.status}`}`);
  if (!(await confirm(rl, "是否重试？", true))) {
    fail("Jira Token 验证失败");
  }
}

const jiraJql = await ask(rl, "默认 JQL", "project = CW order by updated desc");

// ─── Step 5: Lark Base 配置 ─────────────────────────────────
step(5, "配置 Lark 多维表格");
console.log("请粘贴要同步的飞书多维表格链接（一行一个，空行结束）：");
console.log("  示例: https://xxx.larksuite.com/wiki/xxx?table=tblXXX&view=vewXXX\n");

const larkTables = [];
let baseToken = "";
while (true) {
  const line = (await rl.question("链接: ")).trim();
  if (!line) break;
  try {
    const parsed = parseLarkUrl(line);
    if (!parsed.token) throw new Error("无法从 URL 解析出 token");

    let resolvedBaseToken = parsed.token;
    if (parsed.type === "wiki") {
      process.stdout.write("  解析 wiki token → base token... ");
      resolvedBaseToken = resolveLarkBaseToken(parsed.token);
      console.log(`${resolvedBaseToken.slice(0, 8)}...`);
    }

    if (!baseToken) baseToken = resolvedBaseToken;
    const tableId = parsed.tableId;
    if (tableId) {
      larkTables.push({ baseToken: resolvedBaseToken, tableId });
      success(`  表: ${tableId} (base: ${resolvedBaseToken.slice(0, 8)}...)`);
    } else {
      success(`  Base: ${resolvedBaseToken.slice(0, 8)}... (未指定表，将自动发现)`);
    }
  } catch (error) {
    console.log(`  ⚠️ 解析失败: ${error.message}，请重试`);
  }
}

if (!baseToken) {
  baseToken = await ask(rl, "Lark Base Token（手动输入）");
}

const defaultTableId = larkTables[0]?.tableId || "";
process.stdout.write("验证 Lark 访问权限... ");
const larkCheck = runCapture("lark-cli", ["base", "+table-list", "--as", "user", "--base-token", baseToken, "--format", "json"]);
if (larkCheck.ok) {
  success("Lark Base 可访问");
} else {
  console.log("⚠️ 访问失败（可能需要先被邀请到该 Base），继续配置...");
}

// ─── Step 6: 事件监听 ───────────────────────────────────────
step(6, "事件监听（实时推送）");
let eventEnabled = false;
let appId = "";
if (await confirm(rl, "是否启用 Lark 事件实时推送？", true)) {
  console.log("\n需要一个飞书开放平台应用的 App ID。");
  console.log("请在飞书开放平台 → 企业自建应用 → 勾选 Base 事件权限 → 发布。\n");
  appId = await ask(rl, "App ID");
  if (appId) {
    eventEnabled = true;
    console.log("正在创建 Python 环境...");
    const venvPath = `${runtimeDir}/.venv-lark-sdk`;
    if (!existsSync(`${venvPath}/bin/python`)) {
      spawnSync("python3", ["-m", "venv", venvPath], { stdio: "inherit" });
      spawnSync(`${venvPath}/bin/python`, ["-m", "pip", "install", "--upgrade", "pip", "lark-oapi"], { stdio: "inherit" });
    }
    success("事件监听环境就绪");
  } else {
    console.log("跳过事件监听配置");
  }
} else {
  console.log("跳过事件监听");
}

// ─── Step 7: 写入配置 ───────────────────────────────────────
step(7, "写入配置文件");
mkdirSync(configDir, { recursive: true });
mkdirSync(`${runtimeDir}/cache`, { recursive: true });
mkdirSync(`${runtimeDir}/logs`, { recursive: true });

const envContent = `# Auto-generated by setup.mjs at ${new Date().toISOString()}

# Local service
export PORT=8787
export SYNC_SECRET=${crypto.randomUUID()}

# Jira
export JIRA_BASE_URL=${jiraBaseUrl}
export JIRA_TOKEN='${jiraToken.replaceAll("'", "'\\''")}'
export JIRA_JQL='${jiraJql.replaceAll("'", "'\\''")}'
export JIRA_MAX=500
export JIRA_PAGE_SIZE=50
export JIRA_REACHABILITY_CHECK_ENABLED=1

# Lark Base
export LARK_BASE_TOKEN=${baseToken}
export LARK_TABLE_ID=${defaultTableId}
export LARK_AS=user

# Lark event listener
export LARK_EVENT_ENABLED=${eventEnabled ? "1" : "0"}
export LARK_APP_ID=${appId}
export LARK_EVENT_PYTHON=${runtimeDir}/.venv-lark-sdk/bin/python

# Incremental refresh
export LARK_INCREMENTAL_REFRESH_ENABLED=1
export LARK_INCREMENTAL_REFRESH_SECONDS=21600
export LARK_INCREMENTAL_JQL_WINDOW=-6h

# Runtime files
export LARK_SYNC_CACHE_PATH=${runtimeDir}/cache/index.json
export LARK_SYNC_DB_PATH=${runtimeDir}/cache/sync.db
export LARK_USER_MAP_FILE=${runtimeDir}/lark_user_map.tsv

# Queue settings
export LARK_BATCH_SYNC_ENABLED=1
export LARK_BATCH_SYNC_SIZE=50
export LARK_RUNNING_JOB_STALE_SECONDS=60
export STARTUP_READINESS_CHECK_ENABLED=1
`;

writeFileSync(envFile, envContent, { mode: 0o600 });
success(`配置已写入: ${envFile}`);

// ─── Step 8: 部署服务 ───────────────────────────────────────
step(8, "部署服务");

// rsync source to runtime
spawnSync("rsync", [
  "-a", "--delete",
  "--exclude", ".env", "--exclude", ".env.*",
  "--exclude", ".venv-lark-sdk", "--exclude", "cache",
  "--exclude", "logs", "--exclude", "node_modules",
  "--exclude", ".git", "--exclude", ".claude",
  `${sourceDir}/`, `${runtimeDir}/`,
], { stdio: "inherit" });

spawnSync("chmod", ["700", `${runtimeDir}/run-sync-server.sh`], { stdio: "ignore" });

// Generate launchd plist
if (!existsSync(plistPath)) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${runtimeDir}/run-sync-server.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${runtimeDir}/logs/launchd-sync-server.out.log</string>
  <key>StandardErrorPath</key>
  <string>${runtimeDir}/logs/launchd-sync-server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JIRA_LARK_ENV_FILE</key>
    <string>${envFile}</string>
  </dict>
</dict>
</plist>`;
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  success(`launchd plist 已创建: ${plistPath}`);
}

// Start service
const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
spawnSync("launchctl", ["bootout", `gui/${uid}/${plistLabel}`], { stdio: "ignore" });
const boot = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
if (boot.status !== 0) {
  spawnSync("launchctl", ["load", plistPath], { stdio: "inherit" });
}
console.log("服务启动中...");

// Wait for health
const deadline = Date.now() + 60000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const resp = await fetch("http://127.0.0.1:8787/health", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) { healthy = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 2000));
}

if (healthy) {
  success("同步服务已启动");
} else {
  console.log("⚠️ 服务尚未就绪，可稍后用 curl http://127.0.0.1:8787/health 检查");
}

// ─── Step 9: MCP 配置 ───────────────────────────────────────
step(9, "Claude MCP 配置");
const mcpConfig = {
  mcpServers: {
    "jira-lark-sync": {
      command: "node",
      args: [`${runtimeDir}/mcp/server.mjs`],
      env: { JIRA_LARK_ENV_FILE: envFile },
    },
  },
};

console.log("将以下配置添加到你的 Claude 客户端：\n");
console.log("── Claude Desktop ──");
console.log(`文件: ~/Library/Application Support/Claude/claude_desktop_config.json\n`);
console.log(JSON.stringify(mcpConfig, null, 2));
console.log("\n── Claude Code (.mcp.json) ──");
console.log(`文件: ~/.claude/.mcp.json\n`);
console.log(JSON.stringify(mcpConfig, null, 2));

// ─── Step 10: 完成 ──────────────────────────────────────────
step(10, "完成");
console.log(`  Jira 用户:    ${jiraUser}`);
console.log(`  Lark Base:    ${baseToken.slice(0, 8)}...`);
console.log(`  默认表:       ${defaultTableId || "(自动发现)"}`);
console.log(`  服务状态:     ${healthy ? "✅ 运行中" : "⏳ 启动中"}`);
console.log(`  配置文件:     ${envFile}`);
console.log(`  运行目录:     ${runtimeDir}`);
console.log("");
console.log("后续操作：");
console.log("  检查服务:  curl -s http://127.0.0.1:8787/health | node -e \"process.stdin.on('data',d=>console.log(JSON.parse(d).ok))\"");
console.log("  查看日志:  tail -f ~/.local/share/jira-lark-sync/logs/launchd-sync-server.err.log");
console.log("  更换Token: node scripts/rotate-jira-token.mjs");
console.log("  诊断:      node scripts/doctor.mjs");

rl.close();
