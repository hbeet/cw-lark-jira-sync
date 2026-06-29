import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dbAll, dbExec, dbOne, dbRun } from "./db.mjs";

export function jobFromRow(row) {
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

export function queuedCount() {
  try {
    return Number(dbAll("SELECT count(*) AS count FROM sync_jobs WHERE status IN ('pending', 'retry', 'running');", [])[0]?.count || 0);
  } catch {
    return 0;
  }
}

export function jobStats() {
  try {
    const rows = dbAll("SELECT status, count(*) AS count FROM sync_jobs GROUP BY status ORDER BY status;", []);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
  } catch {
    return {};
  }
}

export function listJobs({ status = "", limit = 50 } = {}) {
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

export function retryFailedJobs({ ids = [] } = {}, scheduleDispatch) {
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

export function recoverStaleRunningJobs({ running, runningJobStaleSeconds, scheduleDispatch, reason = "periodic" }) {
  if (running || !runningJobStaleSeconds) return { ok: true, recovered: 0, reason };
  const cutoff = new Date(Date.now() - runningJobStaleSeconds * 1000).toISOString();
  const rows = dbAll("SELECT id, jira_key, updated_at FROM sync_jobs WHERE status='running' AND updated_at < ? ORDER BY id ASC LIMIT 200;", [cutoff]);
  if (rows.length === 0) {
    return {
      ok: true,
      recovered: 0,
      reason,
      checked_at: new Date().toISOString(),
      stale_seconds: runningJobStaleSeconds,
    };
  }

  const now = new Date().toISOString();
  const ids = rows.map((row) => Number(row.id));
  const placeholders = ids.map(() => "?").join(",");
  const errorMsg = `recovered stale running job after ${runningJobStaleSeconds}s`;
  dbRun(`UPDATE sync_jobs SET status='retry', next_run_at=?, last_error=?, updated_at=? WHERE id IN (${placeholders});`, [now, errorMsg, now, ...ids]);
  scheduleDispatch(0);
  return {
    ok: true,
    recovered: rows.length,
    reason,
    checked_at: now,
    stale_seconds: runningJobStaleSeconds,
    jobs: rows.map((row) => ({ id: row.id, jira_key: row.jira_key, updated_at: row.updated_at })),
  };
}

export function nextRetryDelaySeconds(attempts) {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 300;
  return 900;
}

export function finishJob(jobId, success, errorMessage, maxJobAttempts) {
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

export function isBatchableRecordJob(job) {
  return job.table_id !== "__manual__"
    && job.record_id
    && !String(job.record_id).startsWith("manual-")
    && /^[A-Z][A-Z0-9]+-\d+$/.test(job.jira_key || "");
}

export function selectBatchJobs(firstJob, now, { batchSyncEnabled, batchSyncSize }) {
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

export function writeBatchRecordMap(jobs, dbPath) {
  const dir = join(dirname(dbPath), "job-maps");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `batch-${Date.now()}-${Math.random().toString(16).slice(2)}.tsv`);
  const lines = jobs.map((job) => `${job.jira_key}\t${job.record_id}`).join("\n");
  writeFileSync(path, `${lines}\n`, { mode: 0o600 });
  return path;
}

export function enqueueJob(trigger, options, scheduleDispatch) {
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

export function isRunScheduled(recordId, jiraKey, tableId, { running, lastRun }) {
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

export function markJobsRunning(jobIds, now) {
  const placeholders = jobIds.map(() => "?").join(",");
  dbRun(`
    UPDATE sync_jobs
    SET status='running', attempts=attempts+1, updated_at=?
    WHERE id IN (${placeholders});
  `, [now, ...jobIds]);
}

export function nextPendingJob(now) {
  const row = dbOne("SELECT * FROM sync_jobs WHERE status IN ('pending', 'retry') AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT 1;", [now]);
  return row ? jobFromRow(row) : null;
}
