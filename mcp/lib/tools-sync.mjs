/**
 * Sync-server API tools — calls the running sync-server at localhost.
 * Reuses: env-file.mjs for loading config.
 */

export function createSyncTools(getEnv) {
  function serverUrl() {
    const env = getEnv();
    const port = env.PORT || "8787";
    return `http://127.0.0.1:${port}`;
  }

  function headers() {
    const env = getEnv();
    const h = { "Content-Type": "application/json" };
    if (env.SYNC_SECRET) h["X-Sync-Secret"] = env.SYNC_SECRET;
    return h;
  }

  async function apiGet(path) {
    const resp = await fetch(`${serverUrl()}${path}`, { headers: headers() });
    return resp.json();
  }

  async function apiPost(path, body = {}) {
    const resp = await fetch(`${serverUrl()}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  return [
    {
      name: "sync_health",
      description: "查看同步服务健康状态：是否运行中、队列数量、最近一次同步结果、增量刷新状态",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => apiGet("/health"),
    },
    {
      name: "sync_jobs",
      description: "查看同步任务列表。可按状态筛选（pending/running/success/failed/retry）",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "筛选状态: pending, running, success, failed, retry", default: "" },
          limit: { type: "number", description: "返回条数，默认 50", default: 50 },
        },
        additionalProperties: false,
      },
      handler: ({ status, limit }) => apiGet(`/api/jobs?status=${status || ""}&limit=${limit || 50}`),
    },
    {
      name: "sync_errors",
      description: "查看同步错误。可指定 jira_key 查看某个 issue 的历史",
      inputSchema: {
        type: "object",
        properties: {
          jira_key: { type: "string", description: "指定 Jira key（如 CW-12345）查看其错误历史" },
          limit: { type: "number", description: "返回条数", default: 50 },
        },
        additionalProperties: false,
      },
      handler: ({ jira_key, limit }) => apiGet(`/api/errors?jira_key=${jira_key || ""}&limit=${limit || 50}`),
    },
    {
      name: "sync_record",
      description: "触发同步单个 Jira issue 到 Lark 表。提供 jira_key 即可",
      inputSchema: {
        type: "object",
        properties: {
          jira_key: { type: "string", description: "Jira issue key，如 CW-12345" },
          table_id: { type: "string", description: "指定目标 Lark 表 ID（可选）" },
          record_id: { type: "string", description: "指定目标记录 ID（可选）" },
        },
        required: ["jira_key"],
        additionalProperties: false,
      },
      handler: ({ jira_key, table_id, record_id }) =>
        apiPost("/api/sync-jira-record", { jira_key, table_id: table_id || "", record_id: record_id || "" }),
    },
    {
      name: "sync_refresh_all",
      description: "全表刷新 — 重建索引并将所有已有 Lark 行的 Jira 数据全量同步",
      inputSchema: {
        type: "object",
        properties: {
          max: { type: "number", description: "每张表最多刷新条数（0=不限制）" },
        },
        additionalProperties: false,
      },
      handler: ({ max }) => apiPost("/api/full-refresh-all", { max: max || 0 }),
    },
    {
      name: "sync_refresh_table",
      description: "刷新指定表 — 对该表所有已有 Lark 行执行 Jira 数据同步",
      inputSchema: {
        type: "object",
        properties: {
          table_id: { type: "string", description: "Lark 表 ID" },
          max: { type: "number", description: "最多刷新条数（0=不限制）" },
        },
        required: ["table_id"],
        additionalProperties: false,
      },
      handler: ({ table_id, max }) =>
        apiPost("/api/sync-jira-to-lark", { table_id, max: max || 0 }),
    },
    {
      name: "sync_retry_failed",
      description: "重试失败的同步任务。可指定 IDs 只重试部分，或不传重试全部失败任务",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "number" }, description: "指定要重试的 job IDs（可选，不传则重试全部）" },
        },
        additionalProperties: false,
      },
      handler: ({ ids }) => apiPost("/api/jobs/retry-failed", { ids: ids || [] }),
    },
    {
      name: "sync_incremental",
      description: "手动触发一次增量刷新 — 检查最近更新的 Jira issues 并同步变化",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => apiPost("/api/jira-incremental", { source: "mcp_manual" }),
    },
    {
      name: "sync_rebuild_index",
      description: "重建 Lark→Jira 索引 — 扫描所有 Lark 表获取当前的 record→jira_key 映射",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => apiPost("/api/rebuild-index"),
    },
  ];
}
