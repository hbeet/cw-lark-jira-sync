import { dbAll } from "./db.mjs";

export function listJobErrors({ limit = 50 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return dbAll(`
    SELECT id, table_id, record_id, jira_key, source, status, attempts, next_run_at, last_error, created_at, updated_at
    FROM sync_jobs
    WHERE status IN ('failed', 'retry')
       OR (last_error IS NOT NULL AND last_error <> '')
    ORDER BY updated_at DESC, id DESC
    LIMIT ?;
  `, [boundedLimit]);
}

export function jobErrorSummary() {
  const rows = dbAll(`
    SELECT status, count(*) AS count
    FROM sync_jobs
    WHERE status IN ('failed', 'retry')
       OR (last_error IS NOT NULL AND last_error <> '')
    GROUP BY status
    ORDER BY status;
  `, []);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
}

export function jobHistoryForJira(jiraKey, { limit = 20 } = {}) {
  if (!jiraKey) return [];
  const boundedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return dbAll(`
    SELECT id, table_id, record_id, jira_key, source, status, attempts, next_run_at, last_error, created_at, updated_at
    FROM sync_jobs
    WHERE jira_key=?
    ORDER BY id DESC
    LIMIT ?;
  `, [jiraKey, boundedLimit]);
}
