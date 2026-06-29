#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, redactValue } from "../lib/env-file.mjs";
import { loadTableConfig, resolveTableTargets } from "../lib/table-config.mjs";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.JIRA_LARK_ENV_FILE || `${process.env.HOME}/.config/jira-lark-sync/env`;
const tableConfigPath = process.env.JIRA_LARK_TABLE_CONFIG || "config/tables.json";
const healthUrl = process.env.JIRA_LARK_HEALTH_URL || "http://127.0.0.1:8787/health";
const runtimeDir = process.env.JIRA_LARK_RUNTIME_DIR || `${process.env.HOME}/.local/share/jira-lark-sync`;

const requiredEnv = [
  "JIRA_BASE_URL",
  "JIRA_TOKEN",
  "LARK_BASE_TOKEN",
  "LARK_TABLE_ID",
  "LARK_APP_ID",
  "LARK_SYNC_DB_PATH",
];

const expectedFields = [
  "jira号",
  "概要",
  "迭代",
  "状态",
  "优先级",
  "需求方",
  "开始时间",
  "提测时间",
  "提交验收时间",
  "原提交验收时间",
  "最新提交验收时间",
  "关闭时间",
  "延期原因",
  "产品负责人",
  "项目经理",
  "开发预估工期",
  "延期状态",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceDir,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: options.timeout || 0,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function larkJson(args) {
  const result = run("lark-cli", args, { capture: true, timeout: 60000 });
  if (!result.ok) throw new Error((result.stderr || result.stdout || "lark-cli failed").slice(0, 500));
  return JSON.parse(result.stdout);
}

function fileInfo(path) {
  if (!path || !existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
}

async function health() {
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) throw new Error(`status=${response.status}`);
    const status = await response.json();
    return {
      ok: true,
      running: Boolean(status.running),
      queued: Number(status.queued || 0),
      event_listener: Boolean(status.event?.listener_running),
      startup_ok: Boolean(status.startup_readiness?.ok),
      jira_ok: Boolean(status.startup_readiness?.jira?.ok),
      jira_user: status.startup_readiness?.jira?.authenticated_user || "",
      incremental_enabled: Boolean(status.incremental?.enabled),
      incremental_window: status.incremental?.window || "",
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function checkTables(tableConfig) {
  const results = [];
  for (const table of resolveTableTargets(tableConfig, "all")) {
    try {
      const fields = larkJson([
        "base", "+field-list",
        "--as", "user",
        "--base-token", table.baseToken,
        "--table-id", table.tableId,
        "--format", "json",
      ]).data?.fields || [];
      const names = new Set(fields.map((field) => field.name));
      const missing = expectedFields.filter((field) => !names.has(field));
      const statusTimelineCount = fields.filter((field) => /^进入.+时间$/.test(field.name || "")).length;
      results.push({
        key: table.key,
        name: table.name,
        table_id: table.tableId,
        view_id: table.viewId,
        jira_field: table.jiraField || "jira号",
        ok: missing.length === 0 && names.has(table.jiraField || "jira号"),
        field_count: fields.length,
        status_timeline_fields: statusTimelineCount,
        missing,
      });
    } catch (error) {
      results.push({
        key: table.key,
        name: table.name,
        table_id: table.tableId,
        ok: false,
        error: error.message,
      });
    }
  }
  return results;
}

const env = existsSync(envFile) ? loadEnvFile(envFile) : {};
const tableConfig = loadTableConfig(tableConfigPath, sourceDir);
const larkCli = run("lark-cli", ["--version"], { capture: true, timeout: 10000 });
const report = {
  generated_at: new Date().toISOString(),
  source_dir: sourceDir,
  env_file: {
    path: envFile,
    exists: existsSync(envFile),
    missing_required: requiredEnv.filter((key) => !env[key]),
    configured: Object.fromEntries(requiredEnv.map((key) => [key, Boolean(env[key])])),
    jira_base_url: env.JIRA_BASE_URL || "",
    jira_token: redactValue(env.JIRA_TOKEN),
    lark_base_token: redactValue(env.LARK_BASE_TOKEN),
    lark_app_id: redactValue(env.LARK_APP_ID),
  },
  runtime_files: {
    db: fileInfo(env.LARK_SYNC_DB_PATH),
    cache: fileInfo(env.LARK_SYNC_CACHE_PATH),
    user_map: fileInfo(env.LARK_USER_MAP_FILE || `${runtimeDir}/lark_user_map.tsv`),
    event_python: fileInfo(env.LARK_EVENT_PYTHON),
  },
  lark_cli: {
    ok: larkCli.ok,
    version: (larkCli.stdout || larkCli.stderr).trim(),
  },
  service: await health(),
  tables: checkTables(tableConfig),
};

console.log(JSON.stringify(report, null, 2));

const hasTableError = report.tables.some((table) => !table.ok);
if (!report.env_file.exists || report.env_file.missing_required.length || !report.lark_cli.ok || !report.service.ok || hasTableError) {
  process.exitCode = 2;
}
