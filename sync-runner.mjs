#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { configureDb, dbExec, dbQuery, sqlString } from "./lib/db.mjs";
import { larkCliJson, larkCliSync } from "./lib/lark-cli.mjs";
import { delayStatusValue, jiraLinkCell, latestSprintName, parseJiraDate } from "./lib/sync-utils.mjs";

const required = ["JIRA_BASE_URL", "JIRA_TOKEN", "LARK_BASE_TOKEN", "LARK_TABLE_ID"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required env: ${name}`);
}

const jiraApi = `${process.env.JIRA_BASE_URL.replace(/\/$/, "")}/rest/api/2`;
const jiraBase = process.env.JIRA_BASE_URL.replace(/\/$/, "");
const larkAs = process.env.LARK_AS || "user";
const larkBaseToken = process.env.LARK_BASE_TOKEN;
const larkTableId = process.env.LARK_TABLE_ID;
const jiraJql = process.env.JIRA_JQL || "project = CW order by updated desc";
const jiraPageSize = Number(process.env.JIRA_PAGE_SIZE || 50);
const jiraMax = Number(process.env.JIRA_MAX || 200);
const larkUserMapFile = process.env.LARK_USER_MAP_FILE || "lark_user_map.tsv";
const targetRecordId = process.env.LARK_TARGET_RECORD_ID || "";
const targetRecordMapFile = process.env.LARK_TARGET_RECORD_MAP_FILE || "";
const nativeBatchUpdate = process.env.LARK_NATIVE_BATCH_UPDATE !== "0";
const diffWrite = process.env.LARK_DIFF_WRITE !== "0";
const createMissingRecords = process.env.LARK_CREATE_MISSING_RECORDS === "1";
const batchChunkSize = Number(process.env.LARK_NATIVE_BATCH_CHUNK_SIZE || 200);
const jiraFieldName = process.env.LARK_JIRA_FIELD_NAME || "jira号";
const fieldMappingStrict = process.env.LARK_FIELD_MAPPING_STRICT === "1";
const defaultFieldMapping = {
  "jira号": "jira号",
  "概要": "概要",
  "迭代": "迭代",
  "状态": "状态",
  "优先级": "优先级",
  "需求方": "需求方",
  "开始时间": "开始时间",
  "提测时间": "提测时间",
  "提交验收时间": "提交验收时间",
  "原提交验收时间": "原提交验收时间",
  "最新提交验收时间": "最新提交验收时间",
  "关闭时间": "关闭时间",
  "延期原因": "延期原因",
  "产品负责人": "产品负责人",
  "项目经理": "项目经理",
  "开发预估工期": "开发预估工期",
  "延期状态": "延期状态",
};

let fieldMapping = JSON.parse(process.env.LARK_FIELD_MAPPING_JSON || JSON.stringify(defaultFieldMapping));
const batchRecords = [];

if (process.env.LARK_SYNC_DB_PATH) {
  configureDb(process.env.LARK_SYNC_DB_PATH);
  mkdirSync(dirname(process.env.LARK_SYNC_DB_PATH), { recursive: true });
  dbExec(`
    CREATE TABLE IF NOT EXISTS jira_changelog_cache (
      jira_key TEXT PRIMARY KEY,
      original_acceptance_time TEXT,
      latest_acceptance_time TEXT,
      jira_updated TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  try {
    dbExec("ALTER TABLE jira_changelog_cache ADD COLUMN status_entered_json TEXT;");
  } catch {}
}

function jiraHeaders() {
  return {
    Authorization: `Bearer ${process.env.JIRA_TOKEN}`,
    Accept: "application/json",
  };
}

async function jiraGet(path, params = {}) {
  const url = new URL(`${jiraApi}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: jiraHeaders() });
  if (!response.ok) throw new Error(`Jira API failed ${response.status}: ${await response.text()}`);
  return response.json();
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(",");
  if (typeof value === "object") return value.text || value.link || value.url || value.value || value.name || value.displayName || "";
  return "";
}

function normalizeForCompare(field, value) {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (value && typeof value === "object" && "text" in value && "link" in value) {
    return `[${value.text}](${value.link})`;
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && "id" in item)) {
    return value.map((item) => item.id).sort();
  }
  return value;
}

function toLarkDateMs(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = text.length === 10 ? `${text} 00:00:00` : text;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return value;
  const [, y, m, d, hh, mm, ss] = match.map(Number);
  return Date.UTC(y, m - 1, d, hh - 8, mm, ss);
}

function mapPayloadFields(fields) {
  const mapped = {};
  for (const [key, value] of Object.entries(fields)) {
    const mappedKey = fieldMapping[key] || (fieldMappingStrict ? "" : key);
    if (mappedKey) mapped[mappedKey] = value === "" ? null : value;
  }
  return mapped;
}

function statusNameFromTimelineField(fieldName) {
  const match = String(fieldName || "").match(/^进入(.+)时间$/);
  return match?.[1] || "";
}

function statusTimelineFieldNames() {
  return Object.keys(fieldMapping).filter((field) => statusNameFromTimelineField(field));
}

function resolveEffectiveFieldMapping() {
  if (!JSON.stringify(fieldMapping).includes("fld")) return;
  const response = larkCliJson([
    "base", "+field-list",
    "--as", larkAs,
    "--base-token", larkBaseToken,
    "--table-id", larkTableId,
    "--format", "json",
  ]);
  const idToName = Object.fromEntries((response?.data?.fields || []).map((field) => [field.id, field.name]));
  fieldMapping = Object.fromEntries(Object.entries(fieldMapping).map(([key, value]) => [key, idToName[value] || value]));
}

function loadUserMap() {
  if (!existsSync(larkUserMapFile)) return new Map();
  const rows = readFileSync(larkUserMapFile, "utf8").split(/\r?\n/).filter(Boolean);
  return new Map(rows.map((line) => {
    const [jiraUser, larkUser] = line.split("\t");
    return [jiraUser, larkUser];
  }));
}

function loadTargetRecordMap() {
  const map = new Map();
  const addRecord = (key, recordId) => {
    if (!key || !recordId) return;
    const ids = map.get(key) || [];
    ids.push(recordId);
    map.set(key, ids);
  };
  if (targetRecordMapFile && existsSync(targetRecordMapFile)) {
    for (const line of readFileSync(targetRecordMapFile, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      const [key, recordId] = line.split("\t");
      addRecord(key, recordId);
    }
    return map;
  }

  let offset = 0;
  while (true) {
    const response = larkCliJson([
      "base", "+record-list",
      "--as", larkAs,
      "--base-token", larkBaseToken,
      "--table-id", larkTableId,
      "--field-id", jiraFieldName,
      "--offset", String(offset),
      "--limit", "200",
      "--format", "json",
    ]);
    const recordIds = response?.data?.record_id_list || [];
    const rows = response?.data?.data || [];
    for (let i = 0; i < rows.length; i += 1) {
      const key = cellText(rows[i]?.[0]).match(/[A-Z][A-Z0-9]+-\d+/)?.[0] || "";
      addRecord(key, recordIds[i]);
    }
    if (!response?.data?.has_more || rows.length === 0) break;
    offset += rows.length;
  }
  return map;
}

function parseStatusEnteredJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function changelogDataForIssue(issueKey, latestAcceptance, jiraUpdated) {
  if (process.env.LARK_SYNC_DB_PATH) {
    const cached = dbQuery(`
      SELECT original_acceptance_time, status_entered_json
      FROM jira_changelog_cache
      WHERE jira_key=${sqlString(issueKey)}
        AND jira_updated=${sqlString(jiraUpdated)}
      LIMIT 1;
    `)[0];
    if (cached && (statusTimelineFieldNames().length === 0 || cached.status_entered_json)) {
      console.error(`changelog_cache_hit ${issueKey}`);
      return {
        originalAcceptance: cached.original_acceptance_time || "",
        statusEntered: parseStatusEnteredJson(cached.status_entered_json),
      };
    }
    console.error(`changelog_cache_miss ${issueKey}`);
  }

  const issue = await jiraGet(`/issue/${issueKey}`, {
    expand: "changelog",
    fields: "customfield_12203,status,created",
  });
  const changes = [];
  const statusEntered = {};
  const statusHistories = [];
  for (const history of issue.changelog?.histories || []) {
    for (const item of history.items || []) {
      if ((item.field === "提交验收时间" || item.field === "customfield_12203") && item.to) {
        changes.push(item.to);
      }
      if (item.field === "status") {
        statusHistories.push({
          created: history.created,
          from: item.fromString || "",
          to: item.toString || "",
        });
      }
    }
  }
  statusHistories.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  if (statusHistories[0]?.from && issue.fields?.created) {
    statusEntered[statusHistories[0].from] = parseJiraDate(issue.fields.created);
  }
  for (const history of statusHistories) {
    if (history.to && !statusEntered[history.to]) {
      statusEntered[history.to] = parseJiraDate(history.created);
    }
  }
  if (Object.keys(statusEntered).length === 0 && issue.fields?.status?.name && issue.fields?.created) {
    statusEntered[issue.fields.status.name] = parseJiraDate(issue.fields.created);
  }
  const original = changes[0] || latestAcceptance || "";

  if (process.env.LARK_SYNC_DB_PATH) {
    const now = new Date().toISOString();
    dbExec(`
      INSERT INTO jira_changelog_cache (
        jira_key, original_acceptance_time, latest_acceptance_time, jira_updated, status_entered_json, updated_at
      ) VALUES (
        ${sqlString(issueKey)},
        ${sqlString(original)},
        ${sqlString(latestAcceptance)},
        ${sqlString(jiraUpdated)},
        ${sqlString(JSON.stringify(statusEntered))},
        ${sqlString(now)}
      )
      ON CONFLICT(jira_key) DO UPDATE SET
        original_acceptance_time=excluded.original_acceptance_time,
        latest_acceptance_time=excluded.latest_acceptance_time,
        jira_updated=excluded.jira_updated,
        status_entered_json=excluded.status_entered_json,
        updated_at=excluded.updated_at;
    `);
  }
  return { originalAcceptance: original, statusEntered };
}

function deptLabel(dept) {
  if (dept === "货推推") return "现货";
  if (dept === "蕃茄" || dept === "番茄") return "Web";
  if (dept === "白菜") return "App";
  if (dept === "小虫") return "测试";
  return dept || "未填";
}

function formatEstimate(seconds) {
  let sec = Number(seconds || 0);
  if (!sec) return "未预估";
  const days = Math.floor(sec / 28800);
  sec %= 28800;
  const hours = Math.floor(sec / 3600);
  sec %= 3600;
  const minutes = Math.floor(sec / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(" ") || "0m";
}

async function preloadDevEstimates(issueKeys) {
  const result = new Map();
  if (issueKeys.length === 0) return result;
  let startAt = 0;
  const pageSize = 200;
  const grouped = new Map();
  const jql = `parent in (${issueKeys.join(",")}) AND issuetype = "开发子任务" order by key asc`;
  while (true) {
    const page = await jiraGet("/search", {
      jql,
      startAt,
      maxResults: pageSize,
      fields: "parent,customfield_11300,aggregatetimeoriginalestimate",
    });
    for (const issue of page.issues || []) {
      const parent = issue.fields?.parent?.key;
      if (!parent) continue;
      const rawDept = issue.fields?.customfield_11300;
      const dept = deptLabel(Array.isArray(rawDept)
        ? (rawDept[0]?.value || rawDept[0]?.name || rawDept[0])
        : typeof rawDept === "object" && rawDept
          ? (rawDept.value || rawDept.name)
          : rawDept);
      const key = `${parent}\t${dept}`;
      const current = grouped.get(key) || { parent, dept, seconds: 0, missing: 0 };
      const seconds = issue.fields?.aggregatetimeoriginalestimate;
      if (seconds === null || seconds === undefined || seconds === "") current.missing += 1;
      else current.seconds += Number(seconds || 0);
      grouped.set(key, current);
    }
    const count = page.issues?.length || 0;
    startAt += count;
    if (count === 0 || startAt >= Number(page.total || 0)) break;
  }
  for (const item of grouped.values()) {
    const value = `${item.dept}：${formatEstimate(item.seconds)}${item.seconds > 0 && item.missing > 0 ? "（含未预估）" : ""}`;
    result.set(item.parent, [...(result.get(item.parent) || []), value]);
  }
  return new Map([...result.entries()].map(([key, values]) => [key, values.join("\n")]));
}

function larkUserCell(id) {
  return id ? [{ id }] : null;
}

function jiraOption(value) {
  if (!value) return "";
  if (typeof value === "object") return value.value || value.name || "";
  return String(value);
}

function jiraUser(value) {
  if (!value) return "";
  if (typeof value === "object") return value.name || value.displayName || "";
  return String(value);
}

async function buildRecord(issue, userMap, devEstimates, recordMap) {
  const key = issue.key;
  const fields = issue.fields || {};
  const latestAcceptance = parseJiraDate(fields.customfield_12203);
  const changelogData = await changelogDataForIssue(
    key,
    latestAcceptance.split(" ")[0] || "",
    fields.updated || "",
  );
  const originalAcceptance = parseJiraDate(changelogData.originalAcceptance);
  const productOwner = jiraUser(fields.customfield_11401);
  const projectManager = jiraUser(fields.customfield_12200);
  const sprint = latestSprintName(fields.customfield_10100);
  const preserveExistingSprint = Boolean(targetRecordId && !sprint);

  const payload = {
    "jira号": jiraLinkCell(key, jiraBase),
    "概要": fields.summary || "",
    "状态": fields.status?.name || "",
    "优先级": fields.priority?.name || "",
    "需求方": jiraOption(fields.customfield_10600),
    "开始时间": parseJiraDate(fields.customfield_10401),
    "提测时间": parseJiraDate(fields.customfield_12202),
    "提交验收时间": latestAcceptance,
    "原提交验收时间": originalAcceptance,
    "最新提交验收时间": latestAcceptance,
    "关闭时间": parseJiraDate(fields.customfield_11406),
    "延期原因": fields.customfield_12302 || "",
    "产品负责人": larkUserCell(userMap.get(productOwner) || ""),
    "项目经理": larkUserCell(userMap.get(projectManager) || ""),
    "开发预估工期": devEstimates.get(key) || "",
    "延期状态": delayStatusValue(originalAcceptance, latestAcceptance),
  };
  for (const fieldName of statusTimelineFieldNames()) {
    const statusName = statusNameFromTimelineField(fieldName);
    payload[fieldName] = changelogData.statusEntered[statusName] || "";
  }
  if (!preserveExistingSprint) payload["迭代"] = sprint;

  const recordIds = targetRecordId ? [targetRecordId] : (recordMap.get(key) || [""]);
  return recordIds.map((recordId) => ({
    record_id: recordId,
    fields: mapPayloadFields(payload),
    jira_key: key,
  }));
}

function currentRecords(recordIds, fields) {
  if (recordIds.length === 0 || fields.length === 0) return new Map();
  const args = [
    "base", "+record-get",
    "--as", larkAs,
    "--base-token", larkBaseToken,
    "--table-id", larkTableId,
    "--format", "json",
  ];
  for (const id of recordIds) args.push("--record-id", id);
  for (const field of fields) args.push("--field-id", field);
  const response = larkCliJson(args, { timeout: 60000 });
  const ids = response?.data?.record_id_list || [];
  const rows = response?.data?.data || [];
  const fieldNames = response?.data?.fields || [];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 1) {
    const values = {};
    for (let j = 0; j < fieldNames.length; j += 1) values[fieldNames[j]] = rows[i]?.[j];
    byId.set(ids[i], values);
  }
  return byId;
}

function filterChanged(records) {
  if (!diffWrite) return records;
  const existing = records.filter((record) => record.record_id);
  if (existing.length === 0) return records;
  const fields = [...new Set(existing.flatMap((record) => Object.keys(record.fields)))];
  const current = currentRecords(existing.map((record) => record.record_id), fields);
  let skipped = 0;
  const changed = records.filter((record) => {
    if (!record.record_id) return true;
    const actual = current.get(record.record_id);
    if (!actual) return true;
    const isSame = Object.entries(record.fields).every(([field, desired]) => {
      const left = normalizeForCompare(field, desired);
      const right = normalizeForCompare(field, actual[field]);
      return JSON.stringify(left) === JSON.stringify(right);
    });
    if (isSame) skipped += 1;
    return !isSame;
  });
  console.error(`diff_write skipped=${skipped} changed=${changed.length}`);
  return changed;
}

function normalizeBatchRecord(record) {
  return {
    record_id: record.record_id,
    fields: normalizeNativeFields(record.fields),
  };
}

function normalizeNativeFields(fields) {
  const dateFields = new Set(["开始时间", "提测时间", "提交验收时间", "原提交验收时间", "最新提交验收时间", "关闭时间"]
    .concat(statusTimelineFieldNames())
    .map((field) => fieldMapping[field] || field));
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => [
      field,
      dateFields.has(field) ? toLarkDateMs(value) : value,
  ]));
}

function upsertRecord(record) {
  const method = record.record_id ? "PUT" : "POST";
  const path = record.record_id
    ? `/open-apis/bitable/v1/apps/${larkBaseToken}/tables/${larkTableId}/records/${record.record_id}`
    : `/open-apis/bitable/v1/apps/${larkBaseToken}/tables/${larkTableId}/records`;
  const body = JSON.stringify({ fields: normalizeNativeFields(record.fields) });
  const result = larkCliSync([
    "api", method, path,
    "--as", larkAs,
    "--data", "-",
  ], { input: body, encoding: "utf8", timeout: 60000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "record upsert failed");
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    if (parsed.code && parsed.code !== 0) throw new Error(result.stdout);
  } catch (error) {
    if (error.message !== result.stdout) return;
    throw error;
  }
}

function batchUpdate(records) {
  const updateRecords = filterChanged(records.filter((record) => record.record_id)).map(normalizeBatchRecord);
  const createRecords = records.filter((record) => !record.record_id);
  if (createMissingRecords) {
    for (const record of createRecords) upsertRecord(record);
  } else if (createRecords.length > 0) {
    console.error(`skipped_missing_record_id ${createRecords.length} records; set LARK_CREATE_MISSING_RECORDS=1 to create new rows`);
  }
  if (updateRecords.length === 0) {
    console.error("batch_update skipped 0 changed records");
    return;
  }
  let chunks = 0;
  for (let i = 0; i < updateRecords.length; i += batchChunkSize) {
    const body = JSON.stringify({ records: updateRecords.slice(i, i + batchChunkSize) });
    const result = larkCliSync([
      "api", "POST",
      `/open-apis/bitable/v1/apps/${larkBaseToken}/tables/${larkTableId}/records/batch_update`,
      "--as", larkAs,
      "--params", "{\"ignore_consistency_check\":true}",
      "--data", "-",
    ], { input: body, encoding: "utf8", timeout: 60000 });
    if (result.status === 0) {
      try {
        const parsed = JSON.parse(result.stdout || "{}");
        if (parsed.code === 0) {
          chunks += 1;
          continue;
        }
      } catch {}
    }
    console.error("batch_update chunk failed, falling back to per-record upsert");
    if (result.stdout) console.error(result.stdout.slice(0, 2000));
    if (result.stderr) console.error(result.stderr.slice(0, 2000));
    for (const record of updateRecords.slice(i, i + batchChunkSize)) upsertRecord(record);
  }
  console.error(`batch_updated ${updateRecords.length} records in ${chunks} chunks`);
}

async function main() {
  resolveEffectiveFieldMapping();
  const userMap = loadUserMap();
  const recordMap = loadTargetRecordMap();
  let startAt = 0;
  let synced = 0;

  while (synced < jiraMax) {
    const maxResults = Math.min(jiraPageSize, jiraMax - synced);
    const page = await jiraGet("/search", {
      jql: jiraJql,
      startAt,
      maxResults,
      fields: "summary,status,priority,updated,customfield_10100,customfield_10600,customfield_10401,customfield_12202,customfield_12203,customfield_11406,customfield_12302,customfield_11401,customfield_12200",
    });
    const issues = page.issues || [];
    if (issues.length === 0) break;
    const devEstimates = await preloadDevEstimates([...new Set(issues.map((issue) => issue.key))]);
    for (const issue of issues) {
      const records = await buildRecord(issue, userMap, devEstimates, recordMap);
      if (nativeBatchUpdate) {
        batchRecords.push(...records);
        console.log(`queued ${issue.key} records=${records.length}`);
      } else {
        for (const record of records) {
          upsertRecord(record);
          console.log(`${record.record_id ? "updated" : "created"} ${record.jira_key}`);
        }
      }
    }
    synced += issues.length;
    startAt += issues.length;
    if (startAt >= Number(page.total || 0)) break;
  }

  if (nativeBatchUpdate) batchUpdate(batchRecords);
  console.log(`done, processed ${synced} Jira issues`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
