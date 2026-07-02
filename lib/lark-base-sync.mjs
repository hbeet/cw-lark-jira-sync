import { buildAutoFieldMapping, findJiraFieldName } from "./field-registry.mjs";
import { larkCliSync } from "./lark-cli.mjs";

export function listTableFields({ env = process.env, cwd = process.cwd(), tableId, fieldCache = new Map(), baseToken = "" }) {
  const token = baseToken || env.LARK_BASE_TOKEN;
  if (!token || !tableId) return [];
  const result = larkCliSync([
    "base",
    "+field-list",
    "--as",
    env.LARK_AS || "user",
    "--base-token",
    token,
    "--table-id",
    tableId,
    "--format",
    "json",
  ], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const fields = JSON.parse(result.stdout)?.data?.fields || [];
    for (const field of fields) {
      if (field.name && field.id) fieldCache.set(`${tableId}:${field.name}`, field.id);
      if (field.id) fieldCache.set(`${tableId}:${field.id}`, field.id);
    }
    return fields;
  } catch {
    return [];
  }
}

export function discoverSyncTableConfigs({ env = process.env, cwd = process.cwd(), excluded = new Set(), fieldCache = new Map(), baseTokens = [] }) {
  const tokens = baseTokens.length > 0 ? baseTokens : [env.LARK_BASE_TOKEN].filter(Boolean);
  if (tokens.length === 0) return [];
  const configs = [];
  for (const baseToken of tokens) {
    const result = larkCliSync([
      "base",
      "+table-list",
      "--as",
      env.LARK_AS || "user",
      "--base-token",
      baseToken,
      "--format",
      "json",
    ], {
      cwd,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0 || !result.stdout) continue;
    try {
      const tables = JSON.parse(result.stdout)?.data?.tables || [];
      for (const table of tables) {
        if (!table?.id || excluded.has(table.id)) continue;
        const fields = listTableFields({ env, cwd, tableId: table.id, fieldCache, baseToken });
        const byName = new Map(fields.filter((field) => field?.name && field?.id).map((field) => [field.name, field.id]));
        const jiraFieldName = findJiraFieldName(fields);
        if (!jiraFieldName) continue;
        configs.push({
          id: table.id,
          name: table.name || table.id,
          baseToken,
          enabled: true,
          jiraField: byName.get(jiraFieldName),
          summaryField: byName.get("概要") || "",
          sprintField: byName.get("迭代") || "",
          updatedAtField: byName.get("最近修改时间") || "",
          fieldMapping: buildAutoFieldMapping(fields),
          incremental: true,
          source: "auto_discover",
        });
      }
    } catch {}
  }
  return configs;
}

export function checkLarkReachable({ env = process.env, cwd = process.cwd(), timeout = 15000, baseTokens = [] } = {}) {
  const startedAt = new Date();
  const token = (baseTokens.length > 0 ? baseTokens[0] : env.LARK_BASE_TOKEN) || "";
  if (!token) {
    return { ok: false, checked_at: startedAt.toISOString(), error: "missing LARK_BASE_TOKEN" };
  }
  const result = larkCliSync([
    "base",
    "+table-list",
    "--as",
    env.LARK_AS || "user",
    "--base-token",
    token,
    "--format",
    "json",
  ], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
  });
  return {
    ok: result.status === 0,
    checked_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    error: result.status === 0 ? "" : (result.stderr || result.stdout || "lark check failed").slice(0, 1000),
  };
}
