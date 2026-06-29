#!/usr/bin/env node
import { existsSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const noRestart = args.has("--no-restart");
const noVerify = args.has("--no-verify");

const runtimeEnvPath = process.env.JIRA_LARK_RUNTIME_ENV || `${process.env.HOME}/.config/jira-lark-sync/env`;
const projectEnvPath = process.env.JIRA_LARK_PROJECT_ENV || new URL("../.env", import.meta.url).pathname;
const launchAgentLabel = process.env.JIRA_LARK_LAUNCH_AGENT_LABEL || "com.legend.jira-lark-sync";

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function readEnvFile(path) {
  if (!existsSync(path)) throw new Error(`配置文件不存在：${path}`);
  return readFileSync(path, "utf8");
}

function readOptionalEnvFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function envValue(content, name) {
  const match = content.match(new RegExp(`^export\\s+${name}=(.*)$`, "m"));
  if (!match) return "";
  let value = match[1].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\""))) {
    value = value.slice(1, -1);
  }
  return value;
}

function replaceExport(content, name, value) {
  const line = `export ${name}=${quoteShell(value)}`;
  if (new RegExp(`^export\\s+${name}=`, "m").test(content)) {
    return content.replace(new RegExp(`^export\\s+${name}=.*$`, "m"), line);
  }
  return `${content.replace(/\s*$/, "\n")}${line}\n`;
}

function readSecretFromTty(prompt) {
  if (process.env.NEW_JIRA_TOKEN) return process.env.NEW_JIRA_TOKEN;
  let ttyFd;
  try {
    ttyFd = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("无法打开 /dev/tty。请在系统 Terminal 中运行本脚本，不要在聊天框或非交互环境里输入 token。");
  }

  process.stdout.write(prompt);
  const disableEcho = spawnSync("stty", ["-echo", "-icanon", "min", "1", "time", "0"], { stdio: [ttyFd, ttyFd, ttyFd] });
  if (disableEcho.status !== 0) {
    throw new Error("无法隐藏终端输入。为避免泄露 token，脚本已停止。");
  }

  let token = "";
  const buffer = Buffer.alloc(1);
  try {
    while (true) {
      const bytes = readSyncByte(ttyFd, buffer);
      if (bytes === 0) break;
      const char = buffer.toString("utf8", 0, bytes);
      if (char === "\n" || char === "\r") break;
      if (char === "\u0003") {
        process.stdout.write("\n");
        throw new Error("已取消。");
      }
      if (char === "\u007f" || char === "\b") {
        if (token.length > 0) {
          token = token.slice(0, -1);
          process.stdout.write("\b \b");
        }
        continue;
      }
      token += char;
      process.stdout.write("*");
    }
  } finally {
    spawnSync("stty", ["echo", "icanon"], { stdio: [ttyFd, ttyFd, ttyFd] });
    process.stdout.write("\n");
  }
  return token.trim();
}

function readSyncByte(fd, buffer) {
  return readSync(fd, buffer, 0, 1, null);
}

async function verifyJira(baseUrl, token) {
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/2/myself`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  const body = response.headers.get("content-type")?.includes("json")
    ? await response.json().catch(() => ({}))
    : {};
  return {
    ok: response.ok,
    status: response.status,
    name: body.name || body.key || "",
    displayName: body.displayName || "",
  };
}

function restartService() {
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  const result = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${launchAgentLabel}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "launchctl kickstart failed");
  }
}

async function main() {
  console.log("Jira API Token 更换向导");
  console.log("请只在系统 Terminal 中运行本脚本。不要把 token 发到聊天、文档或截图里。");
  console.log("");

  const runtimeEnv = readEnvFile(runtimeEnvPath);
  const projectEnv = readOptionalEnvFile(projectEnvPath);
  const jiraBaseUrl = envValue(runtimeEnv, "JIRA_BASE_URL") || envValue(projectEnv, "JIRA_BASE_URL");
  if (!jiraBaseUrl) throw new Error("没有找到 JIRA_BASE_URL，请先完成基础配置。");

  const token = readSecretFromTty("请粘贴新的 Jira API Token，然后按回车。输入会显示为星号：");
  if (!token) throw new Error("token 为空，已停止。");
  if (/[\r\n]/.test(token)) throw new Error("token 不能包含换行，已停止。");

  if (!noVerify) {
    process.stdout.write("正在验证 Jira token... ");
    const result = await verifyJira(jiraBaseUrl, token);
    console.log(result.ok
      ? `成功 status=${result.status} user=${result.name || result.displayName || "unknown"}`
      : `失败 status=${result.status}`);
    if (!result.ok) throw new Error("Jira token 验证失败，配置未写入。");
  }

  if (dryRun) {
    console.log("dry-run：验证完成，但不会写入配置或重启服务。");
    return;
  }

  writeFileSync(`${runtimeEnvPath}.bak`, runtimeEnv, { mode: 0o600 });
  writeFileSync(runtimeEnvPath, replaceExport(runtimeEnv, "JIRA_TOKEN", token), { mode: 0o600 });
  if (projectEnv) {
    writeFileSync(`${projectEnvPath}.bak`, projectEnv, { mode: 0o600 });
    writeFileSync(projectEnvPath, replaceExport(projectEnv, "JIRA_TOKEN", token), { mode: 0o600 });
    console.log("运行配置和项目 .env 已写入，并已生成 .bak 备份。");
  } else {
    console.log("运行配置已写入，并已生成 .bak 备份。项目 .env 不存在，已跳过。");
  }

  if (!noRestart) {
    restartService();
    console.log("同步服务已重启。");
  }

  console.log("完成。可以用下面命令检查服务：");
  console.log("curl -s http://127.0.0.1:8787/health | jq '.startup_readiness.jira, .incremental.jira_reachability'");
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
