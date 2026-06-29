import { buildAutoFieldMapping, findJiraFieldName } from "./field-registry.mjs";
import { larkCliSync } from "./lark-cli.mjs";

export function listTableFields({ env = process.env, cwd = process.cwd(), tableId, fieldCache = new Map() }) {
  if (!env.LARK_BASE_TOKEN || !tableId) return [];
  const result = larkCliSync([
    "base",
    "+field-list",
    "--as",
    env.LARK_AS || "user",
    "--base-token",
    env.LARK_BASE_TOKEN,
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

export function discoverSyncTableConfigs({ env = process.env, cwd = process.cwd(), excluded = new Set(), fieldCache = new Map() }) {
  if (!env.LARK_BASE_TOKEN) return [];
  const result = larkCliSync([
    "base",
    "+table-list",
    "--as",
    env.LARK_AS || "user",
    "--base-token",
    env.LARK_BASE_TOKEN,
    "--format",
    "json",
  ], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const tables = JSON.parse(result.stdout)?.data?.tables || [];
    const configs = [];
    for (const table of tables) {
      if (!table?.id || excluded.has(table.id)) continue;
      const fields = listTableFields({ env, cwd, tableId: table.id, fieldCache });
      const byName = new Map(fields.filter((field) => field?.name && field?.id).map((field) => [field.name, field.id]));
      const jiraFieldName = findJiraFieldName(fields);
      if (!jiraFieldName) continue;
      configs.push({
        id: table.id,
        name: table.name || table.id,
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
    return configs;
  } catch {
    return [];
  }
}

export function checkLarkReachable({ env = process.env, cwd = process.cwd(), timeout = 15000 } = {}) {
  const startedAt = new Date();
  if (!env.LARK_BASE_TOKEN) {
    return { ok: false, checked_at: startedAt.toISOString(), error: "missing LARK_BASE_TOKEN" };
  }
  const result = larkCliSync([
    "base",
    "+table-list",
    "--as",
    env.LARK_AS || "user",
    "--base-token",
    env.LARK_BASE_TOKEN,
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
