import { existsSync, readFileSync, renameSync } from "node:fs";
import { dbAll, dbExec, dbRun } from "./db.mjs";
import { extractJiraKey } from "./sync-utils.mjs";
import { larkCliSync } from "./lark-cli.mjs";

function cacheRecordKey(tableId, recordId) {
  return `${tableId}:${recordId}`;
}

export function upsertCachedRecord({ tableId, recordId, jiraKey, inDefaultScope = null, jiraUpdated = "", source = "" }) {
  if (!tableId || !recordId || !jiraKey) return;
  const now = new Date().toISOString();
  dbRun(`
    INSERT INTO jira_index (
      table_id, record_id, jira_key, in_default_scope, jira_updated, last_synced_at, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(table_id, record_id) DO UPDATE SET
      jira_key=excluded.jira_key,
      in_default_scope=COALESCE(excluded.in_default_scope, jira_index.in_default_scope),
      jira_updated=COALESCE(NULLIF(excluded.jira_updated, ''), jira_index.jira_updated),
      last_synced_at=excluded.last_synced_at,
      source=COALESCE(NULLIF(excluded.source, ''), jira_index.source),
      updated_at=excluded.updated_at;
  `, [tableId, recordId, jiraKey, inDefaultScope === null ? null : (inDefaultScope ? 1 : 0), jiraUpdated || "", now, source || "", now]);
}

export function removeCachedRecord(tableId, recordId) {
  if (!tableId || !recordId) return;
  dbRun("DELETE FROM jira_index WHERE table_id=? AND record_id=?;", [tableId, recordId]);
}

export function cachedRecordsForJira(jiraKey) {
  return dbAll("SELECT table_id, record_id, jira_key, in_default_scope, jira_updated, last_synced_at, source FROM jira_index WHERE jira_key=?;", [jiraKey])
    .map((row) => ({
      table_id: row.table_id,
      record_id: row.record_id,
      jira_key: row.jira_key,
      in_default_scope: row.in_default_scope === null ? null : Boolean(row.in_default_scope),
      jira_updated: row.jira_updated || "",
      last_synced_at: row.last_synced_at || "",
      source: row.source || "",
    }));
}

export function indexedJiraKeys() {
  return dbAll("SELECT DISTINCT jira_key FROM jira_index WHERE jira_key <> '' ORDER BY jira_key;", [])
    .map((row) => row.jira_key)
    .filter(Boolean);
}

export function indexedRecordsForTable(tableId) {
  return dbAll(`
    SELECT table_id, record_id, jira_key, in_default_scope, jira_updated
    FROM jira_index
    WHERE table_id=?
      AND jira_key <> ''
      AND record_id <> ''
    ORDER BY jira_key, record_id;
  `, [tableId]).map((row) => ({
    table_id: row.table_id,
    record_id: row.record_id,
    jira_key: row.jira_key,
    in_default_scope: row.in_default_scope === null ? null : Boolean(row.in_default_scope),
    jira_updated: row.jira_updated || "",
  }));
}

export function clearIndexCache() {
  dbExec("DELETE FROM jira_index;");
}

export function indexRecordCount() {
  return Number(dbAll("SELECT count(*) AS count FROM jira_index;", [])[0]?.count || 0);
}

export function indexJiraKeyCount() {
  return Number(dbAll("SELECT count(DISTINCT jira_key) AS count FROM jira_index WHERE jira_key <> '';", [])[0]?.count || 0);
}

export function migrateJsonCacheToDb(cachePath) {
  if (!existsSync(cachePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    const records = parsed?.records || {};
    for (const record of Object.values(records)) {
      if (!record?.table_id || !record?.record_id || !record?.jira_key) continue;
      upsertCachedRecord({
        tableId: record.table_id,
        recordId: record.record_id,
        jiraKey: record.jira_key,
        inDefaultScope: record.in_default_scope ?? null,
        jiraUpdated: record.jira_updated || "",
        source: record.source || "json_cache_import",
      });
    }
    renameSync(cachePath, `${cachePath}.migrated`);
    console.log(`[migration] JSON cache migrated to SQLite and renamed to ${cachePath}.migrated`);
  } catch (error) {
    console.error(`[migration] failed to migrate JSON cache: ${error.message}`);
  }
}

export function rebuildIndexFromLark({ env = process.env, cwd = process.cwd(), loadSyncTableConfigs }) {
  if (!env.LARK_BASE_TOKEN) {
    throw new Error("missing LARK_BASE_TOKEN");
  }
  const startedAt = new Date();
  const scanned = [];
  let indexed = 0;
  const previous = new Map();
  try {
    for (const row of dbAll("SELECT table_id, record_id, in_default_scope, jira_updated, source FROM jira_index;", [])) {
      previous.set(cacheRecordKey(row.table_id, row.record_id), {
        in_default_scope: row.in_default_scope === null ? null : Boolean(row.in_default_scope),
        jira_updated: row.jira_updated || "",
        source: row.source || "",
      });
    }
  } catch (error) {
    console.error("[rebuildIndexFromLark] failed to load previous index:", error.message);
  }
  clearIndexCache();

  for (const table of loadSyncTableConfigs()) {
    let offset = 0;
    let tableIndexed = 0;
    const jiraField = table.jiraField || "jira号";
    while (true) {
      const result = larkCliSync([
        "base",
        "+record-list",
        "--as",
        env.LARK_AS || "user",
        "--base-token",
        env.LARK_BASE_TOKEN,
        "--table-id",
        table.id,
        "--field-id",
        jiraField,
        "--offset",
        String(offset),
        "--limit",
        "200",
        "--format",
        "json",
      ], {
        cwd,
        env,
        encoding: "utf8",
      });
      if (result.status !== 0 || !result.stdout) {
        scanned.push({ table_id: table.id, table_name: table.name, indexed: tableIndexed, error: result.stderr || "record-list failed" });
        break;
      }
      const records = JSON.parse(result.stdout);
      const recordIds = records?.data?.record_id_list || [];
      const rows = records?.data?.data || [];
      for (let i = 0; i < rows.length; i += 1) {
        const recordId = recordIds[i];
        const jiraKey = extractJiraKey(rows[i]?.[0] ?? "");
        if (!recordId || !jiraKey) continue;
        const previousRecord = previous.get(cacheRecordKey(table.id, recordId)) || {};
        upsertCachedRecord({
          tableId: table.id,
          recordId,
          jiraKey,
          inDefaultScope: previousRecord.in_default_scope ?? null,
          jiraUpdated: previousRecord.jira_updated || "",
          source: "rebuild_index",
        });
        indexed += 1;
        tableIndexed += 1;
      }
      if (!records?.data?.has_more || rows.length === 0) break;
      offset += rows.length;
    }
    scanned.push({ table_id: table.id, table_name: table.name, indexed: tableIndexed });
  }

  return {
    ok: true,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    indexed,
    scanned,
  };
}
