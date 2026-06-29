#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../lib/env-file.mjs";
import { loadTableConfig, resolveTableTargets } from "../lib/table-config.mjs";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.JIRA_LARK_ENV_FILE || `${process.env.HOME}/.config/jira-lark-sync/env`;
const tableConfigPath = process.env.JIRA_LARK_TABLE_CONFIG || "config/tables.json";
const mode = process.argv[2] || "all";

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
      "--field-id", config.jiraField || "jira号",
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
        LARK_JIRA_FIELD_NAME: config.jiraField || "jira号",
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

const env = loadEnvFile(envFile);
const tableConfig = loadTableConfig(tableConfigPath, sourceDir);
for (const config of resolveTableTargets(tableConfig, mode)) await refreshTable(config, env);
