import { openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export function createRl() {
  return createInterface({ input, output });
}

export async function confirm(rl, question, fallback = false) {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} (${suffix}) `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

export async function ask(rl, question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

export function openUrl(url) {
  spawnSync("open", [url], { stdio: "ignore" });
}

export function commandExists(command) {
  const result = spawnSync("which", [command], { encoding: "utf8", stdio: "pipe" });
  return result.status === 0;
}

export function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout || 30000,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export function readSecretFromTty(prompt) {
  let ttyFd;
  try {
    ttyFd = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("无法打开 /dev/tty。请在终端中运行本脚本。");
  }

  process.stdout.write(prompt);
  spawnSync("stty", ["-echo", "-icanon", "min", "1", "time", "0"], { stdio: [ttyFd, ttyFd, ttyFd] });

  let token = "";
  const buffer = Buffer.alloc(1);
  try {
    while (true) {
      const bytes = readSync(ttyFd, buffer, 0, 1, null);
      if (bytes === 0) break;
      const char = buffer.toString("utf8", 0, bytes);
      if (char === "\n" || char === "\r") break;
      if (char === "") {
        process.stdout.write("\n");
        throw new Error("已取消。");
      }
      if (char === "" || char === "\b") {
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

export async function verifyJira(baseUrl, token) {
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/2/myself`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
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
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function parseLarkUrl(url) {
  const parsed = new URL(url.trim());
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  const tableId = parsed.searchParams.get("table") || "";
  let type = "";
  let token = "";

  for (let i = 0; i < pathParts.length; i++) {
    if (pathParts[i] === "wiki" || pathParts[i] === "base") {
      type = pathParts[i];
      token = pathParts[i + 1] || "";
      break;
    }
  }

  return { type, token, tableId, host: parsed.host };
}

export function resolveLarkBaseToken(wikiToken, options = {}) {
  const result = spawnSync("lark-cli", [
    "wiki", "+node-get",
    "--as", options.as || "user",
    "--node-token", wikiToken,
    "--format", "json",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    env: options.env || process.env,
  });
  if (result.status !== 0) {
    throw new Error(`无法解析 wiki token: ${(result.stderr || result.stdout || "").slice(0, 200)}`);
  }
  const data = JSON.parse(result.stdout);
  const objToken = data?.data?.node?.obj_token || data?.data?.obj_token || "";
  if (!objToken) throw new Error("wiki +node-get 未返回 obj_token");
  return objToken;
}
