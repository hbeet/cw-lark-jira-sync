#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.JIRA_LARK_ENV_FILE || `${process.env.HOME}/.config/jira-lark-sync/env`;
const mode = process.argv[2] || "all";

const baseToken = "GpJLbIuPWaT5wFs8eVhjvYCRpdH";
const tableConfigs = {
  spot: {
    name: "现货总表",
    baseToken,
    tableId: "tblXAEpyR8CBg4r2",
    viewId: "vewm4Z6sMK",
  },
  ui: {
    name: "迭代产品UI规划",
    baseToken,
    tableId: "tblzzkHyrY7TaGE0",
    viewId: "vewxCTMkfC",
  },
};

const syncFields = new Set([
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
]);

function loadEnv(path) {
  const env = {};
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceDir,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: "utf8",
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit",
    timeout: options.timeout || 0,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${details ? `\n${details}` : ""}`);
  }
  return result.stdout || "";
}

function larkJson(args) {
  return JSON.parse(run("lark-cli", args, { capture: true, timeout: 120000 }));
}

function extractJiraKey(value) {
  return JSON.stringify(value ?? "").match(/[A-Z][A-Z0-9]+-\d+/)?.[0] || "";
}

function listViewJiraRecords(config) {
  const rows = [];
  let offset = 0;
  while (true) {
    const page = larkJson([
      "base", "+record-list",
      "--as", "user",
      "--base-token", config.baseToken,
      "--table-id", config.tableId,
      "--view-id", config.viewId,
      "--field-id", "jira号",
      "--offset", String(offset),
      "--limit", "200",
      "--format", "json",
    ]);
    const recordIds = page.data?.record_id_list || [];
    const data = page.data?.data || [];
    for (let i = 0; i < data.length; i += 1) {
      const jiraKey = extractJiraKey(data[i]?.[0]);
      if (jiraKey && recordIds[i]) rows.push({ jiraKey, recordId: recordIds[i] });
    }
    if (!page.data?.has_more || data.length === 0) break;
    offset += data.length;
  }
  return rows;
}

function fieldMapping(config) {
  const fields = larkJson([
    "base", "+field-list",
    "--as", "user",
    "--base-token", config.baseToken,
    "--table-id", config.tableId,
    "--format", "json",
  ]).data?.fields || [];
  const mapping = {};
  for (const field of fields) {
    if (syncFields.has(field.name) || /^进入.+时间$/.test(field.name || "")) mapping[field.name] = field.id;
  }
  return mapping;
}

async function refreshTable(config, env) {
  const rows = listViewJiraRecords(config);
  const uniqueKeys = [...new Set(rows.map((row) => row.jiraKey))];
  console.log(`${config.name}: rows=${rows.length} unique=${uniqueKeys.length}`);
  if (uniqueKeys.length === 0) return;

  const tempDir = mkdtempSync(join(tmpdir(), "jira-lark-refresh-"));
  const mapFile = join(tempDir, "record-map.tsv");
  writeFileSync(mapFile, rows.map((row) => `${row.jiraKey}\t${row.recordId}`).join("\n") + "\n");
  try {
    run(process.execPath, ["sync-runner.mjs"], {
      env: {
        ...env,
        LARK_BASE_TOKEN: config.baseToken,
        LARK_TABLE_ID: config.tableId,
        LARK_TARGET_RECORD_MAP_FILE: mapFile,
        LARK_FIELD_MAPPING_JSON: JSON.stringify(fieldMapping(config)),
        LARK_FIELD_MAPPING_STRICT: "1",
        LARK_JIRA_FIELD_NAME: "jira号",
        JIRA_JQL: `key in (${uniqueKeys.join(",")})`,
        JIRA_MAX: String(uniqueKeys.length),
        JIRA_PAGE_SIZE: "50",
        LARK_NATIVE_BATCH_CHUNK_SIZE: "50",
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const selected = mode === "all" ? ["spot", "ui"] : [mode];
for (const key of selected) {
  if (!tableConfigs[key]) {
    console.error(`unknown refresh target: ${key}`);
    console.error(`available targets: all, ${Object.keys(tableConfigs).join(", ")}`);
    process.exit(1);
  }
}

const env = loadEnv(envFile);
for (const key of selected) await refreshTable(tableConfigs[key], env);
