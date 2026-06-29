/**
 * Jira query tools — reuses lib/jira-client.mjs from the parent project.
 */
import { jiraSearch, jiraSearchAll, checkJiraReachable } from "../../lib/jira-client.mjs";

export function createJiraTools(getEnv) {
  return [
    {
      name: "jira_check",
      description: "检查 Jira 是否可达，返回认证用户信息",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => checkJiraReachable(getEnv(), { enabled: true, timeoutMs: 10000 }),
    },
    {
      name: "jira_get_issue",
      description: "查询单个 Jira issue 的详情（状态、优先级、经办人、Sprint 等）",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Jira issue key，如 CW-12345" },
          fields: { type: "string", description: "返回字段（逗号分隔），默认全量", default: "" },
        },
        required: ["key"],
        additionalProperties: false,
      },
      handler: async ({ key, fields }) => {
        const env = getEnv();
        const baseUrl = env.JIRA_BASE_URL.replace(/\/$/, "");
        const url = `${baseUrl}/rest/api/2/issue/${key}`;
        const params = fields ? `?fields=${fields}` : "";
        const resp = await fetch(`${url}${params}`, {
          headers: { Authorization: `Bearer ${env.JIRA_TOKEN}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          return { ok: false, status: resp.status, message: await resp.text().catch(() => "") };
        }
        return resp.json();
      },
    },
    {
      name: "jira_search",
      description: "使用 JQL 搜索 Jira issues。返回匹配的 issue 列表",
      inputSchema: {
        type: "object",
        properties: {
          jql: { type: "string", description: "JQL 查询语句" },
          fields: { type: "string", description: "返回字段（逗号分隔）", default: "summary,status,priority,assignee,updated" },
          max: { type: "number", description: "最多返回条数", default: 50 },
        },
        required: ["jql"],
        additionalProperties: false,
      },
      handler: async ({ jql, fields, max }) => {
        const env = getEnv();
        const issues = await jiraSearchAll(env, jql, {
          fields: fields || "summary,status,priority,assignee,updated",
          max: max || 50,
          pageSize: Math.min(max || 50, 100),
        });
        return { total: issues.length, issues };
      },
    },
  ];
}
