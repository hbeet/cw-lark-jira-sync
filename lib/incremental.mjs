export function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export async function runIncrementalRefresh({
  incrementalWindow,
  incrementalIntervalMs,
  incrementalRetryWhenUnreachableMs,
  checkJiraReachable,
  indexedJiraKeys,
  jiraSearchAll,
  cachedRecordsForJira,
  enqueueRecordSync,
  scheduleIncrementalRetry,
  lastJiraReachability,
  options = {},
}) {
  const startedAt = new Date();
  const queued = [];
  const errors = [];
  const skippedFresh = [];

  const reachable = await checkJiraReachable();
  if (!reachable) {
    scheduleIncrementalRetry("jira_unreachable");
    return {
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
      jira_reachability: lastJiraReachability(),
    };
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

  return {
    ok: true,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    interval_seconds: incrementalIntervalMs / 1000,
    window: incrementalWindow,
    lark_key_count: keysInLark.length,
    queued: queued.length,
    skipped_fresh: skippedFresh.length,
    jira_reachability: lastJiraReachability(),
    errors,
  };
}
