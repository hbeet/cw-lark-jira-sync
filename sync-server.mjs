import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createConfig, publicConfigSummary } from "./lib/config.mjs";
import { configureDb, dbAll, dbExec, dbOne, dbRun } from "./lib/db.mjs";
import { jobErrorSummary, jobHistoryForJira, listJobErrors } from "./lib/diagnostics.mjs";
import { DEFAULT_FIELD_MAPPING, mappingForEnv } from "./lib/field-registry.mjs";
import {
  upsertCachedRecord, removeCachedRecord, cachedRecordsForJira,
  indexedJiraKeys, indexedRecordsForTable, clearIndexCache,
  indexRecordCount, indexJiraKeyCount, migrateJsonCacheToDb, rebuildIndexFromLark,
} from "./lib/index-cache.mjs";
import { chunkArray } from "./lib/incremental.mjs";
import { checkJiraReachable as checkJiraReachableApi, jiraSearchAll as jiraSearchAllApi } from "./lib/jira-client.mjs";
import { extractJiraKey } from "./lib/sync-utils.mjs";
import { checkLarkReachable as checkLarkReachableApi, discoverSyncTableConfigs as discoverSyncTableConfigsApi } from "./lib/lark-base-sync.mjs";
import { larkCliSync } from "./lib/lark-cli.mjs";
import { createDecipheriv } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = createConfig(process.env, __dirname);
const {
  port,
  syncSecret,
  scriptPath,
  logsDir,
  syncConfigCacheSeconds,
} = config;
const cachePath = config.cache.path;
const dbPath = config.cache.dbPath;
const eventEnabled = config.event.enabled;
const eventListenerPath = config.event.listenerPath;
const eventPython = config.event.python;
const eventAppId = config.event.appId;
const eventSecretFile = config.event.secretFile;
const eventEncryptedSecretFile = config.event.encryptedSecretFile;
const eventMasterKeyFile = config.event.masterKeyFile;
const incrementalEnabled = config.incremental.enabled;
const incrementalIntervalMs = config.incremental.intervalMs;
const incrementalWindow = config.incremental.window;
const incrementalRetryWhenUnreachableMs = config.incremental.retryWhenUnreachableMs;
const jiraReachabilityCheckEnabled = config.jira.reachabilityCheckEnabled;
const jiraReachabilityTimeoutMs = config.jira.reachabilityTimeoutMs;
const maxJobAttempts = config.jobs.maxAttempts;
const runningJobStaleSeconds = config.jobs.runningStaleSeconds;
const processTimeoutMs = config.jobs.processTimeoutMs;
const batchSyncEnabled = config.batch.enabled;
const batchSyncSize = config.batch.size;
const batchDispatchDelayMs = config.batch.dispatchDelayMs;
const logRetentionDays = config.logs.retentionDays;
const logRetentionMaxFiles = config.logs.retentionMaxFiles;
const launchdLogMaxBytes = config.logs.launchdMaxBytes;
const startupReadinessEnabled = config.startupReadiness.enabled;
const startupReadinessMaxSeconds = config.startupReadiness.maxSeconds;
const startupReadinessIntervalSeconds = config.startupReadiness.intervalSeconds;

configureDb(dbPath);

// --- mutable state ---
let running = false;
let lastRun = null;
const processedRecordVersions = new Map();
let eventListener = null;
let eventListenerConsecutiveFailures = 0;
const EVENT_LISTENER_MAX_BACKOFF_MS = 5 * 60 * 1000;
const EVENT_LISTENER_MAX_CONSECUTIVE_FAILURES = 20;
let lastEvent = null;
let incrementalRunning = false;
let lastIncremental = null;
let lastJiraReachability = null;
let incrementalRetryTimer = null;
let fieldCache = new Map();
let dispatchTimer = null;
let lastRecoveredRunningJobs = null;
let syncTableConfigCache = { loadedAt: 0, configs: [], error: "" };
let lastFullRefreshAll = null;
let lastLogRotation = null;
let lastStartupReadiness = null;

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required env: ${name}`);
  }
}

function initDb() {
  dbExec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      jira_key TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      options_json TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_next_run
      ON sync_jobs(status, next_run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_active_unique
      ON sync_jobs(table_id, record_id, jira_key)
      WHERE status IN ('pending', 'running', 'retry');
    CREATE TABLE IF NOT EXISTS jira_index (
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      jira_key TEXT NOT NULL,
      in_default_scope INTEGER,
      jira_updated TEXT,
      last_synced_at TEXT,
      source TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(table_id, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_jira_index_jira_key
      ON jira_index(jira_key);
  `);
}


function doRebuildIndex() {
  return rebuildIndexFromLark({ env: process.env, cwd: __dirname, loadSyncTableConfigs });
}

function rotateLogs() {
  const startedAt = new Date();
  try {
    if (!existsSync(logsDir)) {
      lastLogRotation = { ok: true, checked_at: startedAt.toISOString(), deleted: 0, reason: "logs dir missing" };
      return lastLogRotation;
    }
    const cutoff = Date.now() - logRetentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(logsDir)
      .filter((name) => /^sync-.*\.log$/.test(name))
      .map((name) => {
        const path = join(logsDir, name);
        const stat = statSync(path);
        return { name, path, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const deleteSet = new Set();
    for (const file of files) {
      if (file.mtimeMs < cutoff) deleteSet.add(file.path);
    }
    for (const file of files.slice(Math.max(0, logRetentionMaxFiles))) {
      deleteSet.add(file.path);
    }
    let deleted = 0;
    for (const path of deleteSet) {
      try {
        unlinkSync(path);
        deleted += 1;
      } catch (error) {
        console.error(`[rotateLogs] failed to delete ${path}: ${error.message}`);
      }
    }
    let truncated = 0;
    for (const name of ["launchd-sync-server.out.log", "launchd-sync-server.err.log"]) {
      const path = join(logsDir, name);
      try {
        if (existsSync(path) && statSync(path).size > launchdLogMaxBytes) {
          truncateSync(path, 0);
          truncated += 1;
        }
      } catch (error) {
        console.error(`[rotateLogs] failed to truncate ${path}: ${error.message}`);
      }
    }
    lastLogRotation = {
      ok: true,
      checked_at: startedAt.toISOString(),
      deleted,
      truncated,
      kept: files.length - deleted,
      retention_days: logRetentionDays,
      max_files: logRetentionMaxFiles,
      launchd_log_max_bytes: launchdLogMaxBytes,
    };
    return lastLogRotation;
  } catch (error) {
    lastLogRotation = { ok: false, checked_at: startedAt.toISOString(), error: error.message };
    return lastLogRotation;
  }
}


function parseLarkEventFieldValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getTableFieldId(tableId, fieldName) {
  const cacheKey = `${tableId}:${fieldName}`;
  if (fieldCache.has(cacheKey)) return fieldCache.get(cacheKey);
  if (!process.env.LARK_BASE_TOKEN || !tableId) return "";

  const result = larkCliSync( [
    "base",
    "+field-list",
    "--as",
    process.env.LARK_AS || "user",
    "--base-token",
    process.env.LARK_BASE_TOKEN,
    "--table-id",
    tableId,
    "--format",
    "json",
  ], {
    cwd: __dirname,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout) return "";
  try {
    const fields = JSON.parse(result.stdout)?.data?.fields || [];
    for (const field of fields) {
      if (field.name && field.id) fieldCache.set(`${tableId}:${field.name}`, field.id);
      if (field.id) fieldCache.set(`${tableId}:${field.id}`, field.id);
    }
    return fieldCache.get(cacheKey) || "";
  } catch {
    return "";
  }
}

function discoverSyncTableConfigs() {
  return discoverSyncTableConfigsApi({
    env: process.env,
    cwd: __dirname,
    excluded: excludedTableIds(),
    fieldCache,
  });
}

function excludedTableIds() {
  return new Set(config.excludedTables);
}

function loadSyncTableConfigs({ force = false } = {}) {
  const now = Date.now();
  if (!force && syncTableConfigCache.loadedAt && now - syncTableConfigCache.loadedAt < syncConfigCacheSeconds * 1000) {
    return syncTableConfigCache.configs;
  }
  const configs = discoverSyncTableConfigs();
  syncTableConfigCache = { loadedAt: now, configs, error: "" };
  return configs;
}

function getSyncTableConfig(tableId) {
  if (!tableId) return null;
  return loadSyncTableConfigs().find((tc) => tc.id === tableId) || null;
}

function cachedSyncTableConfigs() {
  return syncTableConfigCache.configs || [];
}

function healthSyncTableConfigs() {
  return syncTableConfigCache.loadedAt ? cachedSyncTableConfigs() : loadSyncTableConfigs();
}

function envForTableConfig(tableConfig = {}) {
  return {
    LARK_JIRA_FIELD_NAME: tableConfig.jiraField || "jira号",
    ...mappingForEnv(tableConfig.fieldMapping || DEFAULT_FIELD_MAPPING),
  };
}

function validateTableConfig(tableConfig) {
  const required = [
    ["jiraField", tableConfig.jiraField],
    ["summaryField", tableConfig.summaryField],
    ["sprintField", tableConfig.sprintField],
    ["updatedAtField", tableConfig.updatedAtField],
  ].filter(([, field]) => field);
  const missing = [];
  for (const [key, field] of required) {
    if (!getTableFieldId(tableConfig.id, field)) missing.push({ key, field });
  }
  const mappedMissing = [];
  for (const [canonical, field] of Object.entries(tableConfig.fieldMapping || {})) {
    if (!field) continue;
    if (!getTableFieldId(tableConfig.id, field)) mappedMissing.push({ canonical, field });
  }
  return {
    ok: missing.length === 0 && mappedMissing.length === 0,
    missing,
    mapped_missing: mappedMissing,
  };
}

async function jiraSearchAll(jql, options = {}) {
  return jiraSearchAllApi(process.env, jql, options);
}

async function checkJiraReachable() {
  lastJiraReachability = await checkJiraReachableApi(process.env, {
    enabled: jiraReachabilityCheckEnabled,
    timeoutMs: jiraReachabilityTimeoutMs,
  });
  return lastJiraReachability.ok;
}

function checkLarkReachable() {
  return checkLarkReachableApi({ env: process.env, cwd: __dirname, timeout: 15000 });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStartupReadiness() {
  const startedAt = new Date();
  if (!startupReadinessEnabled) {
    lastStartupReadiness = { ok: true, skipped: true, started_at: startedAt.toISOString(), reason: "disabled" };
    return lastStartupReadiness;
  }
  const deadline = Date.now() + startupReadinessMaxSeconds * 1000;
  let attempts = 0;
  while (Date.now() <= deadline) {
    attempts += 1;
    const lark = checkLarkReachable();
    const jiraOk = await checkJiraReachable();
    lastStartupReadiness = {
      ok: lark.ok && jiraOk,
      attempts,
      started_at: startedAt.toISOString(),
      checked_at: new Date().toISOString(),
      lark,
      jira: lastJiraReachability,
    };
    if (lastStartupReadiness.ok) return lastStartupReadiness;
    await delay(startupReadinessIntervalSeconds * 1000);
  }
  lastStartupReadiness = {
    ...(lastStartupReadiness || {}),
    ok: false,
    timed_out: true,
    finished_at: new Date().toISOString(),
    max_seconds: startupReadinessMaxSeconds,
  };
  return lastStartupReadiness;
}

async function runStartupWork() {
  await waitForStartupReadiness();
  if (incrementalEnabled) runIncrementalRefresh({ reason: "startup" });
}

function scheduleIncrementalRetry(reason = "jira_unreachable") {
  if (!incrementalEnabled || incrementalRetryTimer || incrementalRetryWhenUnreachableMs <= 0) return;
  incrementalRetryTimer = setTimeout(() => {
    incrementalRetryTimer = null;
    runIncrementalRefresh({ reason: `${reason}_retry` }).catch((error) => {
      lastIncremental = {
        ok: false,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: error.message,
      };
      incrementalRunning = false;
    });
  }, incrementalRetryWhenUnreachableMs);
}

function tableEnv(tableId) {
  const config = getSyncTableConfig(tableId);
  return tableId ? { LARK_TABLE_ID: tableId, ...envForTableConfig(config || {}) } : {};
}

function runSync(trigger = {}, options = {}) {
  requireEnv("JIRA_BASE_URL");
  requireEnv("JIRA_TOKEN");
  requireEnv("LARK_BASE_TOKEN");
  requireEnv("LARK_TABLE_ID");
  if (!options.jiraJql) {
    requireEnv("JIRA_JQL");
  }

  mkdirSync(logsDir, { recursive: true });
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const logPath = join(logsDir, `sync-${runId}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  running = true;
  lastRun = {
    id: runId,
    status: "running",
    started_at: startedAt.toISOString(),
    finished_at: null,
    exit_code: null,
    log_path: logPath,
    trigger,
  };

  const runnerCommand = scriptPath.endsWith(".mjs") ? process.execPath : "bash";
  const runnerArgs = scriptPath.endsWith(".mjs") ? [scriptPath] : [scriptPath];
  const child = spawn(runnerCommand, runnerArgs, {
    cwd: __dirname,
    env: {
      ...process.env,
      JIRA_JQL: options.jiraJql || process.env.JIRA_JQL,
      JIRA_MAX: options.jiraMax || process.env.JIRA_MAX || "500",
      JIRA_PAGE_SIZE: process.env.JIRA_PAGE_SIZE || "50",
      ...tableEnv(options.tableId),
      ...(options.env || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  const processTimeout = setTimeout(() => {
    logStream.write(`\ntimeout: killing process after ${processTimeoutMs / 1000}s\n`);
    child.kill("SIGTERM");
    setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5000);
  }, processTimeoutMs);

  child.on("close", (code) => {
    clearTimeout(processTimeout);
    const finishedAt = new Date();
    running = false;
    lastRun = {
      ...lastRun,
      status: code === 0 ? "success" : "failed",
      finished_at: finishedAt.toISOString(),
      exit_code: code,
    };
    if (code === 0 && trigger.target_table_id && trigger.target_record_id && trigger.jira_key) {
      upsertCachedRecord({
        tableId: trigger.target_table_id,
        recordId: trigger.target_record_id,
        jiraKey: trigger.jira_key,
        inDefaultScope: options.cache?.inDefaultScope ?? null,
        jiraUpdated: options.cache?.jiraUpdated || "",
        source: trigger.source || "",
      });
    }
    if (code === 0 && options.batchJobs?.length) {
      for (const batchJob of options.batchJobs) {
        upsertCachedRecord({
          tableId: batchJob.table_id,
          recordId: batchJob.record_id,
          jiraKey: batchJob.jira_key,
          inDefaultScope: batchJob.in_default_scope ?? null,
          jiraUpdated: batchJob.jira_updated || "",
          source: trigger.source || "",
        });
      }
    }
    if (options.jobIds?.length) {
      for (const jobId of options.jobIds) {
        finishJob(jobId, code === 0, code === 0 ? "" : `sync exited with code ${code}`);
      }
    } else if (options.jobId) {
      finishJob(options.jobId, code === 0, code === 0 ? "" : `sync exited with code ${code}`);
    }
    logStream.write(`\nfinished_at=${finishedAt.toISOString()} exit_code=${code}\n`);
    logStream.end();
    setImmediate(startNextRun);
  });

  child.on("error", (error) => {
    clearTimeout(processTimeout);
    const finishedAt = new Date();
    running = false;
    lastRun = {
      ...lastRun,
      status: "failed",
      finished_at: finishedAt.toISOString(),
      exit_code: null,
      error: error.message,
    };
    if (options.jobIds?.length) {
      for (const jobId of options.jobIds) {
        finishJob(jobId, false, error.message);
      }
    } else if (options.jobId) {
      finishJob(options.jobId, false, error.message);
    }
    logStream.write(`\nerror=${error.message}\n`);
    logStream.end();
    setImmediate(startNextRun);
  });

  return lastRun;
}

function jobFromRow(row) {
  return {
    id: row.id,
    table_id: row.table_id,
    record_id: row.record_id,
    jira_key: row.jira_key,
    source: row.source,
    status: row.status,
    attempts: Number(row.attempts || 0),
    trigger: JSON.parse(row.trigger_json || "{}"),
    options: JSON.parse(row.options_json || "{}"),
  };
}

function queuedCount() {
  try {
    return Number(dbAll("SELECT count(*) AS count FROM sync_jobs WHERE status IN ('pending', 'retry', 'running');", [])[0]?.count || 0);
  } catch {
    return 0;
  }
}

function jobStats() {
  try {
    const rows = dbAll("SELECT status, count(*) AS count FROM sync_jobs GROUP BY status ORDER BY status;", []);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
  } catch {
    return {};
  }
}

function listJobs({ status = "", limit = 50 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (status) {
    return dbAll(`
      SELECT id, table_id, record_id, jira_key, source, status, attempts, next_run_at, last_error, created_at, updated_at
      FROM sync_jobs
      WHERE status=?
      ORDER BY id DESC
      LIMIT ?;
    `, [status, boundedLimit]);
  }
  return dbAll(`
    SELECT id, table_id, record_id, jira_key, source, status, attempts, next_run_at, last_error, created_at, updated_at
    FROM sync_jobs
    ORDER BY id DESC
    LIMIT ?;
  `, [boundedLimit]);
}

function retryFailedJobs({ ids = [] } = {}) {
  const now = new Date().toISOString();
  const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
  if (idList.length > 0) {
    const placeholders = idList.map(() => "?").join(",");
    const before = dbOne(`SELECT count(*) AS count FROM sync_jobs WHERE status='failed' AND id IN (${placeholders});`, idList)?.count || 0;
    dbRun(`UPDATE sync_jobs SET status='pending', next_run_at=?, last_error=NULL, updated_at=? WHERE status='failed' AND id IN (${placeholders});`, [now, now, ...idList]);
    scheduleDispatch(0);
    return { ok: true, retried: Number(before || 0) };
  }
  const before = dbOne("SELECT count(*) AS count FROM sync_jobs WHERE status='failed';")?.count || 0;
  dbRun("UPDATE sync_jobs SET status='pending', next_run_at=?, last_error=NULL, updated_at=? WHERE status='failed';", [now, now]);
  scheduleDispatch(0);
  return { ok: true, retried: Number(before || 0) };
}

function recoverStaleRunningJobs(reason = "periodic") {
  if (running || !runningJobStaleSeconds) return { ok: true, recovered: 0, reason };
  const cutoff = new Date(Date.now() - runningJobStaleSeconds * 1000).toISOString();
  const rows = dbAll("SELECT id, jira_key, updated_at FROM sync_jobs WHERE status='running' AND updated_at < ? ORDER BY id ASC LIMIT 200;", [cutoff]);
  if (rows.length === 0) {
    lastRecoveredRunningJobs = {
      ok: true,
      recovered: 0,
      reason,
      checked_at: new Date().toISOString(),
      stale_seconds: runningJobStaleSeconds,
    };
    return lastRecoveredRunningJobs;
  }

  const now = new Date().toISOString();
  const ids = rows.map((row) => Number(row.id));
  const placeholders = ids.map(() => "?").join(",");
  const errorMsg = `recovered stale running job after ${runningJobStaleSeconds}s`;
  dbRun(`UPDATE sync_jobs SET status='retry', next_run_at=?, last_error=?, updated_at=? WHERE id IN (${placeholders});`, [now, errorMsg, now, ...ids]);
  lastRecoveredRunningJobs = {
    ok: true,
    recovered: rows.length,
    reason,
    checked_at: now,
    stale_seconds: runningJobStaleSeconds,
    jobs: rows.map((row) => ({ id: row.id, jira_key: row.jira_key, updated_at: row.updated_at })),
  };
  scheduleDispatch(0);
  return lastRecoveredRunningJobs;
}

function nextRetryDelaySeconds(attempts) {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 300;
  return 900;
}

function scheduleDispatch(delayMs = batchDispatchDelayMs) {
  if (dispatchTimer) return;
  dispatchTimer = setTimeout(() => {
    dispatchTimer = null;
    startNextRun();
  }, delayMs);
}

function finishJob(jobId, success, errorMessage = "") {
  const now = new Date().toISOString();
  const id = Number(jobId);
  if (success) {
    dbRun("UPDATE sync_jobs SET status='success', last_error=NULL, updated_at=? WHERE id=?;", [now, id]);
    return;
  }
  const row = dbOne("SELECT attempts FROM sync_jobs WHERE id=?;", [id]);
  const attempts = Number(row?.attempts || 0);
  if (attempts >= maxJobAttempts) {
    dbRun("UPDATE sync_jobs SET status='failed', last_error=?, updated_at=? WHERE id=?;", [errorMessage, now, id]);
    return;
  }
  const nextRunAt = new Date(Date.now() + nextRetryDelaySeconds(attempts) * 1000).toISOString();
  dbRun("UPDATE sync_jobs SET status='retry', next_run_at=?, last_error=?, updated_at=? WHERE id=?;", [nextRunAt, errorMessage, now, id]);
}

function shellJqlKeyList(keys) {
  return keys.join(",");
}

function isBatchableRecordJob(job) {
  return job.table_id !== "__manual__"
    && job.record_id
    && !String(job.record_id).startsWith("manual-")
    && /^[A-Z][A-Z0-9]+-\d+$/.test(job.jira_key || "");
}

function selectBatchJobs(firstJob, now) {
  if (!batchSyncEnabled || !isBatchableRecordJob(firstJob)) {
    return [firstJob];
  }
  const rows = dbAll(`
    SELECT * FROM sync_jobs
    WHERE status IN ('pending', 'retry')
      AND next_run_at <= ?
      AND table_id=?
    ORDER BY next_run_at ASC, id ASC
    LIMIT ?;
  `, [now, firstJob.table_id, Math.max(1, batchSyncSize * 2)]);
  const selected = [];
  const seenKeys = new Set();
  for (const row of rows) {
    const rowJob = jobFromRow(row);
    if (!isBatchableRecordJob(rowJob)) continue;
    if (selected.length >= batchSyncSize) break;
    if (seenKeys.has(row.jira_key)) continue;
    seenKeys.add(row.jira_key);
    selected.push(rowJob);
  }
  return selected.length > 0 ? selected : [firstJob];
}

function writeBatchRecordMap(jobs) {
  const dir = join(dirname(dbPath), "job-maps");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `batch-${Date.now()}-${Math.random().toString(16).slice(2)}.tsv`);
  const lines = jobs.map((job) => `${job.jira_key}\t${job.record_id}`).join("\n");
  writeFileSync(path, `${lines}\n`, { mode: 0o600 });
  return path;
}

function enqueueJob(trigger = {}, options = {}) {
  const now = new Date().toISOString();
  const tableId = trigger.target_table_id || options.tableId || "__manual__";
  const recordId = trigger.target_record_id || `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jiraKey = trigger.jira_key || `manual-${recordId}`;
  const source = trigger.source || "unknown";

  dbRun(`
    INSERT OR IGNORE INTO sync_jobs (
      table_id, record_id, jira_key, source, status, attempts, next_run_at,
      trigger_json, options_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?);
  `, [tableId, recordId, jiraKey, source, now, JSON.stringify(trigger), JSON.stringify(options), now, now]);
  const row = dbOne(`
    SELECT * FROM sync_jobs
    WHERE table_id=?
      AND record_id=?
      AND jira_key=?
      AND status IN ('pending', 'running', 'retry')
    ORDER BY id DESC
    LIMIT 1;
  `, [tableId, recordId, jiraKey]);
  scheduleDispatch();
  return row ? { id: `job-${row.id}`, status: row.status, trigger } : { id: `job-skipped-${Date.now()}`, status: "duplicate", trigger };
}

function enqueueSync(trigger = {}, options = {}) {
  return enqueueJob(trigger, options);
}

function enqueueExistingRecordsForTable(config, options = {}) {
  const records = indexedRecordsForTable(config.id);
  const maxRecords = options.max ? Number(options.max) : records.length;
  const runs = [];
  for (const record of records.slice(0, maxRecords)) {
    const result = enqueueRecordSync({
      source: options.source || "refresh_existing_lark_rows",
      tableId: record.table_id,
      recordId: record.record_id,
      jiraKey: record.jira_key,
      inDefaultScope: record.in_default_scope ?? null,
      jiraUpdated: record.jira_updated || "",
      force: Boolean(options.force),
    });
    runs.push({ record_id: record.record_id, jira_key: record.jira_key, result });
  }
  return {
    table_id: config.id,
    table_name: config.name,
    records: records.length,
    queued: runs.filter((run) => run.result?.ok && !run.result?.skipped).length,
    skipped: runs.filter((run) => run.result?.skipped).length,
    run_ids: runs.map((run) => run.result?.run?.id).filter(Boolean).slice(0, 10),
  };
}

function enqueueFullRefreshAll(body = {}) {
  const startedAt = new Date();
  const rebuilt = doRebuildIndex();
  const configs = loadSyncTableConfigs({ force: true });
  const tables = [];
  for (const config of configs) {
    tables.push(enqueueExistingRecordsForTable(config, {
      source: body.source || "full_refresh_existing_lark_rows",
      max: body.max || body.jira_max || 0,
      force: true,
    }));
  }
  lastFullRefreshAll = {
    ok: true,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    table_count: tables.length,
    indexed: rebuilt.indexed,
    queued: tables.reduce((sum, table) => sum + Number(table.queued || 0), 0),
    tables,
  };
  return lastFullRefreshAll;
}

function enqueueRecordSync({ source, tableId, recordId, jiraKey, inDefaultScope = null, jiraUpdated = "", force = false }) {
  if (!jiraKey || !tableId || !recordId) {
    return { ok: false, skipped: true, reason: "missing table_id/record_id/jira_key" };
  }
  const config = getSyncTableConfig(tableId);
  if (!config) {
    return { ok: true, skipped: true, reason: "table not enabled in Jira sync config" };
  }
  const dedupeTimestamp = processedRecordVersions.get(processedKey(tableId, recordId, jiraKey));
  if (!force && dedupeTimestamp && Date.now() - dedupeTimestamp < Number(process.env.LARK_EVENT_DEDUPE_SECONDS || 300) * 1000) {
    return { ok: true, skipped: true, reason: "recently processed" };
  }
  if (isRunScheduled(recordId, jiraKey, tableId)) {
    return { ok: true, skipped: true, reason: "already scheduled" };
  }
  rememberProcessed(tableId, recordId, jiraKey, Date.now());
  upsertCachedRecord({
    tableId,
    recordId,
    jiraKey,
    inDefaultScope,
    jiraUpdated,
    source,
  });
  const run = enqueueSync({
    source,
    control_record_id: "",
    target_table_id: tableId,
    target_record_id: recordId,
    jira_key: jiraKey,
  }, {
    jiraJql: `key = ${jiraKey}`,
    jiraMax: "1",
    updateControl: false,
    tableId,
    env: { LARK_TARGET_RECORD_ID: recordId, ...envForTableConfig(config) },
    cache: { inDefaultScope, jiraUpdated },
  });
  return { ok: true, run };
}

function isRunScheduled(recordId, jiraKey, tableId = "") {
  if (running && lastRun?.trigger) {
    if (recordId && lastRun.trigger.target_record_id === recordId && (!tableId || lastRun.trigger.target_table_id === tableId)) return true;
  }
  try {
    const row = tableId
      ? dbOne("SELECT id FROM sync_jobs WHERE record_id=? AND table_id=? AND status IN ('pending', 'running', 'retry') LIMIT 1;", [recordId, tableId])
      : dbOne("SELECT id FROM sync_jobs WHERE record_id=? AND status IN ('pending', 'running', 'retry') LIMIT 1;", [recordId]);
    return Boolean(row);
  } catch (error) {
    console.error("[isRunScheduled] error:", error.message);
    return false;
  }
}

function handleLarkRecordEvent(eventBody) {
  // Successfully received event — reset reconnect backoff
  eventListenerConsecutiveFailures = 0;
  const event = eventBody?.event || eventBody?.data?.event || eventBody;
  if (!event || event.file_token !== process.env.LARK_BASE_TOKEN) {
    return { ok: true, ignored: true, reason: "different base" };
  }

  const tableId = event.table_id || "";
  const config = getSyncTableConfig(tableId);
  const queued = [];
  const ignored = [];
  if (!config) {
    lastEvent = {
      ok: true,
      received_at: new Date().toISOString(),
      table_id: tableId,
      queued: 0,
      ignored: 1,
      reason: "table not enabled in Jira sync config",
    };
    return { ok: true, queued, ignored: [{ table_id: tableId, reason: "table not enabled in Jira sync config" }] };
  }
  const jiraField = getTableFieldId(tableId, config.jiraField || "jira号");
  if (!jiraField) {
    return { ok: false, queued, ignored: [{ table_id: tableId, reason: "jira field not found" }] };
  }

  for (const action of event.action_list || []) {
    const recordId = action.record_id || "";
    if (!recordId) continue;
    if (action.action === "record_deleted") {
      removeCachedRecord(tableId, recordId);
      ignored.push({ record_id: recordId, reason: "deleted" });
      continue;
    }
    const values = [...(action.after_value || []), ...(action.before_value || [])];
    const jiraFieldChange = values.find((field) => field.field_id === jiraField);
    if (!jiraFieldChange) {
      ignored.push({ record_id: recordId, reason: "jira field unchanged" });
      continue;
    }
    const jiraKey = extractJiraKey(parseLarkEventFieldValue(jiraFieldChange.field_value));
    if (!jiraKey) {
      removeCachedRecord(tableId, recordId);
      ignored.push({ record_id: recordId, reason: "jira key empty" });
      continue;
    }
    queued.push({
      record_id: recordId,
      jira_key: jiraKey,
      result: enqueueRecordSync({
        source: "lark_event",
        tableId,
        recordId,
        jiraKey,
      }),
    });
  }

  lastEvent = {
    ok: true,
    received_at: new Date().toISOString(),
    table_id: tableId,
    queued: queued.length,
    ignored: ignored.length,
  };
  return { ok: true, queued, ignored };
}

function processedKey(tableId, recordId, jiraKey) {
  return `${tableId}:${recordId}:${jiraKey}`;
}

const PROCESSED_MAX_SIZE = 2000;

function rememberProcessed(tableId, recordId, jiraKey, updatedAt) {
  const key = processedKey(tableId, recordId, jiraKey);
  // Delete and re-set to move key to end (Map insertion order = LRU order)
  processedRecordVersions.delete(key);
  processedRecordVersions.set(key, updatedAt || Date.now());
  // Evict oldest entries when over capacity
  if (processedRecordVersions.size > PROCESSED_MAX_SIZE) {
    const excess = processedRecordVersions.size - PROCESSED_MAX_SIZE;
    let removed = 0;
    for (const k of processedRecordVersions.keys()) {
      if (removed >= excess) break;
      processedRecordVersions.delete(k);
      removed += 1;
    }
  }
}


async function runIncrementalRefresh(options = {}) {
  if (!incrementalEnabled || incrementalRunning) return;
  incrementalRunning = true;
  const startedAt = new Date();
  const queued = [];
  const errors = [];
  const skippedFresh = [];

  try {
    const reachable = await checkJiraReachable();
    if (!reachable) {
      lastIncremental = {
        ok: true,
        skipped: true,
        reason: "jira_unreachable_waiting_for_vpn",
        trigger_reason: options.reason || "scheduled",
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        interval_seconds: incrementalIntervalMs / 1000,
        retry_after_seconds: incrementalRetryWhenUnreachableMs / 1000,
        window: incrementalWindow,
        queued: 0,
        jira_reachability: lastJiraReachability,
      };
      scheduleIncrementalRetry("jira_unreachable");
      return;
    }

    const keysInLark = indexedJiraKeys();

    for (const keys of chunkArray(keysInLark, 80)) {
      if (keys.length === 0) continue;
      const issues = await jiraSearchAll(`key in (${keys.join(",")}) AND updated >= ${incrementalWindow} order by updated desc`, {
        fields: "updated",
        pageSize: 100,
        max: keys.length,
      });
      for (const issue of issues) {
        for (const record of cachedRecordsForJira(issue.key)) {
          if (record.jira_updated && issue.fields?.updated && record.jira_updated === issue.fields.updated) {
            skippedFresh.push({ jira_key: issue.key, table_id: record.table_id, record_id: record.record_id });
            continue;
          }
          const result = enqueueRecordSync({
            source: "jira_incremental_existing_lark_rows",
            tableId: record.table_id,
            recordId: record.record_id,
            jiraKey: issue.key,
            inDefaultScope: record.in_default_scope ?? null,
            jiraUpdated: issue.fields?.updated || "",
          });
          queued.push({ jira_key: issue.key, table_id: record.table_id, record_id: record.record_id, result });
        }
      }
    }

    lastIncremental = {
      ok: true,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      interval_seconds: incrementalIntervalMs / 1000,
      window: incrementalWindow,
      lark_key_count: keysInLark.length,
      queued: queued.length,
      skipped_fresh: skippedFresh.length,
      jira_reachability: lastJiraReachability,
      errors,
    };
  } catch (error) {
    if (/fetch failed|network|timeout|terminated|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message || "")) {
      scheduleIncrementalRetry("jira_network_error");
    }
    lastIncremental = {
      ok: false,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      interval_seconds: incrementalIntervalMs / 1000,
      window: incrementalWindow,
      queued: queued.length,
      skipped_fresh: skippedFresh.length,
      error: error.message,
      jira_reachability: lastJiraReachability,
      errors,
    };
  } finally {
    incrementalRunning = false;
  }
}

function decryptLarkAppSecret() {
  if (process.env.LARK_APP_SECRET) return process.env.LARK_APP_SECRET;
  if (eventSecretFile && existsSync(eventSecretFile)) {
    return readFileSync(eventSecretFile, "utf8").trim();
  }
  if (!eventAppId || !existsSync(eventEncryptedSecretFile) || !existsSync(eventMasterKeyFile)) {
    return "";
  }
  const key = readFileSync(eventMasterKeyFile);
  const encrypted = readFileSync(eventEncryptedSecretFile);
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(12, encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function startEventListener() {
  if (!eventEnabled || eventListener) return;
  if (!existsSync(eventListenerPath) || !existsSync(eventPython)) {
    lastEvent = {
      ok: false,
      started_at: new Date().toISOString(),
      error: `missing listener or python: ${eventListenerPath}, ${eventPython}`,
    };
    return;
  }
  const appSecret = decryptLarkAppSecret();
  if (!eventAppId || !appSecret) {
    lastEvent = {
      ok: false,
      started_at: new Date().toISOString(),
      error: "missing LARK_APP_ID or app secret",
    };
    return;
  }

  eventListener = spawn(eventPython, [eventListenerPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      LARK_APP_ID: eventAppId,
      LARK_APP_SECRET: appSecret,
      LARK_EVENT_CALLBACK_URL: `http://127.0.0.1:${port}/api/lark-event`,
      LARK_EVENT_CALLBACK_SECRET: syncSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  eventListener.stdout.on("data", (chunk) => {
    process.stdout.write(`[lark-event] ${chunk}`);
  });
  eventListener.stderr.on("data", (chunk) => {
    process.stderr.write(`[lark-event] ${chunk}`);
  });
  eventListener.on("close", (code) => {
    eventListener = null;
    if (code === 0) {
      eventListenerConsecutiveFailures = 0;
    } else {
      eventListenerConsecutiveFailures += 1;
    }
    lastEvent = {
      ...(lastEvent || {}),
      listener_running: false,
      listener_exit_code: code,
      listener_exited_at: new Date().toISOString(),
      consecutive_failures: eventListenerConsecutiveFailures,
    };
    if (eventEnabled) {
      if (eventListenerConsecutiveFailures >= EVENT_LISTENER_MAX_CONSECUTIVE_FAILURES) {
        console.error(`[lark-event] stopped reconnecting after ${eventListenerConsecutiveFailures} consecutive failures`);
        lastEvent.reconnect_stopped = true;
        return;
      }
      const backoffMs = Math.min(15000 * Math.pow(2, eventListenerConsecutiveFailures - 1), EVENT_LISTENER_MAX_BACKOFF_MS);
      console.error(`[lark-event] reconnecting in ${Math.round(backoffMs / 1000)}s (failure #${eventListenerConsecutiveFailures})`);
      setTimeout(startEventListener, backoffMs);
    }
  });
  eventListener.on("error", (error) => {
    eventListenerConsecutiveFailures += 1;
    lastEvent = {
      ok: false,
      listener_running: false,
      error: error.message,
      listener_failed_at: new Date().toISOString(),
      consecutive_failures: eventListenerConsecutiveFailures,
    };
    eventListener = null;
  });
  lastEvent = {
    ok: true,
    listener_running: true,
    started_at: new Date().toISOString(),
  };
}

function startNextRun() {
  if (running) {
    return;
  }
  const now = new Date().toISOString();
  const row = dbOne("SELECT * FROM sync_jobs WHERE status IN ('pending', 'retry') AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT 1;", [now]);
  if (!row) return;
  const job = jobFromRow(row);
  const jobs = selectBatchJobs(job, now);
  const jobIds = jobs.map((item) => Number(item.id));
  const placeholders = jobIds.map(() => "?").join(",");
  dbRun(`
    UPDATE sync_jobs
    SET status='running', attempts=attempts+1, updated_at=?
    WHERE id IN (${placeholders});
  `, [now, ...jobIds]);
  if (jobs.length === 1) {
    runSync(job.trigger, { ...job.options, jobId: job.id });
    return;
  }
  const keys = jobs.map((item) => item.jira_key);
  const recordMapPath = writeBatchRecordMap(jobs);
  runSync({
    source: "sqlite_batch",
    control_record_id: "",
    target_table_id: job.table_id,
    target_record_id: "",
    jira_key: keys.join(","),
    batch_size: jobs.length,
  }, {
    ...job.options,
    jiraJql: `key in (${shellJqlKeyList(keys)})`,
    jiraMax: String(jobs.length),
    updateControl: false,
    tableId: job.table_id,
    env: {
      ...(job.options.env || {}),
      LARK_TARGET_RECORD_ID: "",
      LARK_TARGET_RECORD_MAP_FILE: recordMapPath,
    },
    jobIds,
    batchJobs: jobs.map((item) => ({
      table_id: item.table_id,
      record_id: item.record_id,
      jira_key: item.jira_key,
      in_default_scope: item.options?.cache?.inDefaultScope ?? null,
      jira_updated: item.options?.cache?.jiraUpdated || "",
    })),
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const enabledTableConfigs = healthSyncTableConfigs();
    sendJson(res, 200, {
      ok: true,
      running,
      queued: queuedCount(),
      last_run: lastRun,
      event: {
        enabled: eventEnabled,
        listener_running: Boolean(eventListener),
        last_event: lastEvent,
      },
      incremental: {
        enabled: incrementalEnabled,
        interval_seconds: incrementalIntervalMs / 1000,
        window: incrementalWindow,
        running: incrementalRunning,
        retry_when_unreachable_seconds: incrementalRetryWhenUnreachableMs / 1000,
        retry_scheduled: Boolean(incrementalRetryTimer),
        last_incremental: lastIncremental,
        jira_reachability: lastJiraReachability,
      },
      cache: {
        db_path: dbPath,
        records: indexRecordCount(),
        jira_keys: indexJiraKeyCount(),
      },
      config: {
        runtime: publicConfigSummary(config),
        loaded_at: syncTableConfigCache.loadedAt ? new Date(syncTableConfigCache.loadedAt).toISOString() : "",
        discovery: "auto_jira_field",
        enabled_tables: enabledTableConfigs.map((config) => ({
          table_id: config.id,
          table_name: config.name,
          jira_field: config.jiraField,
          source: config.source,
        })),
        last_error: syncTableConfigCache.error,
      },
      jobs: jobStats(),
      job_errors: jobErrorSummary(),
      batch: {
        enabled: batchSyncEnabled,
        size: batchSyncSize,
        dispatch_delay_ms: batchDispatchDelayMs,
      },
      recovery: {
        running_job_stale_seconds: runningJobStaleSeconds,
        last_recovered_running_jobs: lastRecoveredRunningJobs,
      },
      startup_readiness: lastStartupReadiness,
      log_rotation: lastLogRotation,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/errors") {
    if (syncSecret && req.headers["x-sync-secret"] !== syncSecret) {
      sendJson(res, 401, { ok: false, message: "unauthorized" });
      return;
    }
    const jiraKey = extractJiraKey(url.searchParams.get("jira") || url.searchParams.get("jira_key") || "");
    sendJson(res, 200, {
      ok: true,
      summary: jobErrorSummary(),
      errors: jiraKey
        ? jobHistoryForJira(jiraKey, { limit: Number(url.searchParams.get("limit") || 20) })
        : listJobErrors({ limit: Number(url.searchParams.get("limit") || 50) }),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    if (syncSecret && req.headers["x-sync-secret"] !== syncSecret) {
      sendJson(res, 401, { ok: false, message: "unauthorized" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      stats: jobStats(),
      jobs: listJobs({
        status: url.searchParams.get("status") || "",
        limit: Number(url.searchParams.get("limit") || 50),
      }),
    });
    return;
  }

  if (req.method !== "POST" || !["/api/sync-jira-to-lark", "/api/full-refresh-all", "/api/sync-jira-record", "/api/lark-event", "/api/jira-incremental", "/api/rebuild-index", "/api/jobs/retry-failed"].includes(url.pathname)) {
    sendJson(res, 404, { ok: false, message: "not found" });
    return;
  }

  if (syncSecret && req.headers["x-sync-secret"] !== syncSecret) {
    sendJson(res, 401, { ok: false, message: "unauthorized" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message });
    return;
  }

  try {
    if (url.pathname === "/api/lark-event") {
      const result = handleLarkRecordEvent(body);
      sendJson(res, 202, result);
      return;
    }

    if (url.pathname === "/api/jira-incremental") {
      runIncrementalRefresh({ reason: body.source || "manual_api" }).catch((error) => {
        lastIncremental = {
          ok: false,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: error.message,
        };
        incrementalRunning = false;
      });
      sendJson(res, 202, { ok: true, message: "incremental refresh started" });
      return;
    }

    if (url.pathname === "/api/rebuild-index") {
      const result = doRebuildIndex();
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/jobs/retry-failed") {
      const result = retryFailedJobs({ ids: body.ids || [] });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/full-refresh-all") {
      const result = enqueueFullRefreshAll(body);
      sendJson(res, 202, { ok: true, message: "full refresh queued for all discovered tables", result });
      return;
    }

    if (url.pathname === "/api/sync-jira-record") {
      const rawJiraKey = body.jira_key || body.key || body.jira || "";
      const jiraKey = extractJiraKey(rawJiraKey);
      if (!jiraKey) {
        sendJson(res, 400, { ok: false, message: "missing jira key" });
        return;
      }
      const run = enqueueSync({
        source: body.source || "lark_base_jira_key",
        control_record_id: body.control_record_id || "",
        target_table_id: body.table_id || "",
        target_record_id: body.record_id || "",
        jira_key: jiraKey,
      }, {
        tableId: body.table_id || "",
        jiraJql: `key = ${jiraKey}`,
        jiraMax: "1",
        updateControl: false,
        env: {
          ...(body.record_id ? { LARK_TARGET_RECORD_ID: body.record_id } : {}),
          ...envForTableConfig(getSyncTableConfig(body.table_id || "") || {}),
        },
      });
      sendJson(res, 202, { ok: true, message: "record sync started", jira_key: jiraKey, run });
      return;
    }

    if (url.pathname === "/api/sync-jira-to-lark") {
      if (!body.jql && !body.jira_jql) {
        const rebuilt = doRebuildIndex();
        const configs = body.table_id
          ? loadSyncTableConfigs({ force: true }).filter((config) => config.id === body.table_id)
          : loadSyncTableConfigs({ force: true });
        const tables = configs.map((config) => enqueueExistingRecordsForTable(config, {
          source: body.source || "full_table_existing_lark_rows",
          max: body.max || body.jira_max || 0,
          force: true,
        }));
        sendJson(res, 202, {
          ok: true,
          message: "existing Lark Jira rows queued",
          indexed: rebuilt.indexed,
          queued: tables.reduce((sum, table) => sum + Number(table.queued || 0), 0),
          tables,
        });
        return;
      }
      const run = enqueueSync({
        source: body.source || "full_table_refresh",
        control_record_id: body.control_record_id || "",
        target_table_id: body.table_id || "",
        triggered_by: body.triggered_by || "",
        mode: body.mode || "full",
      }, {
        jiraJql: body.jql || body.jira_jql || process.env.JIRA_JQL,
        jiraMax: String(body.max || body.jira_max || process.env.JIRA_MAX || "500"),
        updateControl: body.update_control !== false,
        tableId: body.table_id || "",
        env: {
          ...(body.page_size || body.jira_page_size
            ? { JIRA_PAGE_SIZE: String(body.page_size || body.jira_page_size) }
            : {}),
          ...envForTableConfig(getSyncTableConfig(body.table_id || "") || {}),
        },
      });
      sendJson(res, 202, { ok: true, message: "full table sync started", run });
      return;
    }

    const run = enqueueSync({
      source: body.source || "unknown",
      control_record_id: body.control_record_id || "",
      triggered_by: body.triggered_by || "",
    });
    sendJson(res, 202, { ok: true, message: "sync started", run });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message });
  }
});

initDb();
migrateJsonCacheToDb(cachePath);

server.listen(port, "0.0.0.0", () => {
  console.log(`sync server listening on http://127.0.0.1:${port}`);
  startEventListener();
  setTimeout(rotateLogs, 1000);
  setInterval(rotateLogs, 24 * 60 * 60 * 1000);
  setTimeout(() => recoverStaleRunningJobs("startup"), 500);
  setInterval(() => recoverStaleRunningJobs("periodic"), 60000);
  setTimeout(startNextRun, 1000);
  setInterval(startNextRun, 10000);
  setTimeout(() => {
    runStartupWork().catch((error) => {
      lastStartupReadiness = {
        ...(lastStartupReadiness || {}),
        ok: false,
        finished_at: new Date().toISOString(),
        error: error.message,
      };
    });
  }, 3000);
  if (incrementalEnabled) {
    setInterval(() => {
      runIncrementalRefresh({ reason: "scheduled" });
    }, incrementalIntervalMs);
  }
});
