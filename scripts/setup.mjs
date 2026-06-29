#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.JIRA_LARK_ENV_FILE || `${process.env.HOME}/.config/jira-lark-sync/env`;
const tableConfigFile = process.env.JIRA_LARK_TABLE_CONFIG || `${process.env.HOME}/.config/jira-lark-sync/tables.json`;
const runtimeDir = process.env.JIRA_LARK_RUNTIME_DIR || `${process.env.HOME}/.local/share/jira-lark-sync`;
const eventPython = `${runtimeDir}/.venv-lark-sdk/bin/python`;
const rl = createInterface({ input, output });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceDir,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

function commandOk(command, args) {
  return run(command, args, { capture: true }).ok;
}

function writeTemplate(source, target) {
  const text = readFileSync(source, "utf8").replaceAll("/Users/you", process.env.HOME);
  writeFileSync(target, text, { mode: 0o600 });
}

function ensureEventPython() {
  if (existsSync(eventPython) && commandOk(eventPython, ["-c", "import lark_oapi"])) {
    console.log("event python: ready");
    return;
  }
  console.log("event python: creating venv and installing lark-oapi");
  const venv = run("python3", ["-m", "venv", `${runtimeDir}/.venv-lark-sdk`]);
  if (!venv.ok) {
    console.log("event python: python3 venv failed; install Python 3 first");
    return;
  }
  const pip = run(eventPython, ["-m", "pip", "install", "--upgrade", "pip", "lark-oapi"]);
  console.log(`event python: ${pip.ok ? "ready" : "pip install failed"}`);
}

async function confirm(question, fallback = false) {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} (${suffix}) `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

console.log("Jira Lark Sync setup");
console.log(`source: ${sourceDir}`);
console.log(`runtime: ${runtimeDir}`);
console.log(`env: ${envFile}`);

mkdirSync(dirname(envFile), { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(`${runtimeDir}/cache`, { recursive: true });
mkdirSync(`${runtimeDir}/logs`, { recursive: true });

if (!existsSync(envFile)) {
  writeTemplate(`${sourceDir}/.env.example`, envFile);
  console.log("created env template; edit it before starting the service");
} else {
  console.log("env file already exists; keeping it unchanged");
}

if (!existsSync(tableConfigFile)) {
  copyFileSync(`${sourceDir}/config/tables.example.json`, tableConfigFile);
  console.log("created table config template; edit Base/table/view IDs before refreshing");
} else {
  console.log("table config already exists; keeping it unchanged");
}

ensureEventPython();

const larkCli = run("lark-cli", ["--version"], { capture: true });
console.log(`lark-cli: ${larkCli.ok ? larkCli.output : "missing or unavailable"}`);

console.log("\nRequired Lark app capabilities:");
console.log("- Base/Bitable read and write permissions");
console.log("- Drive/Wiki document access if the Base is under Wiki");
console.log("- Cloud document / Bitable record change event subscription");
console.log("- User auth for lark-cli, or bot access to the target Base");

console.log("\nRequired Jira token capabilities:");
console.log("- Read issues, custom fields, changelog, subtasks, and estimates");
console.log("- Access to the configured Jira base URL from the current network/VPN");

if (await confirm("Run Jira token rotation wizard now?", false)) {
  const result = run(process.execPath, ["scripts/rotate-jira-token.mjs"]);
  if (!result.ok) process.exitCode = 1;
}

if (await confirm("Run doctor now?", true)) {
  const result = run(process.execPath, ["scripts/doctor.mjs"]);
  if (!result.ok) process.exitCode = 2;
}

rl.close();
