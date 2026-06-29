/**
 * Lark table tools — reuses lib/lark-cli.mjs and lib/lark-base-sync.mjs.
 */
import { larkCliSync, larkCliJson } from "../../lib/lark-cli.mjs";
import { checkLarkReachable, listTableFields } from "../../lib/lark-base-sync.mjs";

export function createLarkTools(getEnv, getCwd) {
  function commonArgs() {
    const env = getEnv();
    return { as: env.LARK_AS || "user", baseToken: env.LARK_BASE_TOKEN };
  }

  return [
    {
      name: "lark_check",
      description: "检查 Lark 是否可达（测试 lark-cli 是否能访问 Base）",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => checkLarkReachable({ env: getEnv(), cwd: getCwd(), timeout: 15000 }),
    },
    {
      name: "lark_list_tables",
      description: "列出 Lark Base 中所有数据表",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => {
        const { as, baseToken } = commonArgs();
        const result = larkCliJson([
          "base", "+table-list",
          "--as", as,
          "--base-token", baseToken,
          "--format", "json",
        ], { cwd: getCwd(), env: getEnv(), encoding: "utf8" });
        return result?.data?.tables || [];
      },
    },
    {
      name: "lark_list_fields",
      description: "列出指定表的所有字段（名称、ID、类型）",
      inputSchema: {
        type: "object",
        properties: {
          table_id: { type: "string", description: "Lark 表 ID" },
        },
        required: ["table_id"],
        additionalProperties: false,
      },
      handler: ({ table_id }) => {
        const fields = listTableFields({
          env: getEnv(),
          cwd: getCwd(),
          tableId: table_id,
          fieldCache: new Map(),
        });
        return fields.map((f) => ({ id: f.id, name: f.name, type: f.type }));
      },
    },
    {
      name: "lark_list_records",
      description: "列出指定表的记录。可指定视图、分页",
      inputSchema: {
        type: "object",
        properties: {
          table_id: { type: "string", description: "Lark 表 ID" },
          view_id: { type: "string", description: "视图 ID（可选，不传则默认视图）" },
          offset: { type: "number", description: "偏移量", default: 0 },
          limit: { type: "number", description: "每页条数（最大 200）", default: 50 },
        },
        required: ["table_id"],
        additionalProperties: false,
      },
      handler: ({ table_id, view_id, offset, limit }) => {
        const { as, baseToken } = commonArgs();
        const args = [
          "base", "+record-list",
          "--as", as,
          "--base-token", baseToken,
          "--table-id", table_id,
          "--offset", String(offset || 0),
          "--limit", String(Math.min(limit || 50, 200)),
          "--format", "json",
        ];
        if (view_id) args.push("--view-id", view_id);
        const result = larkCliJson(args, { cwd: getCwd(), env: getEnv(), encoding: "utf8" });
        return result?.data || {};
      },
    },
    {
      name: "lark_get_record",
      description: "获取单条记录的完整字段数据",
      inputSchema: {
        type: "object",
        properties: {
          table_id: { type: "string", description: "Lark 表 ID" },
          record_id: { type: "string", description: "记录 ID" },
        },
        required: ["table_id", "record_id"],
        additionalProperties: false,
      },
      handler: ({ table_id, record_id }) => {
        const { as, baseToken } = commonArgs();
        const result = larkCliJson([
          "base", "+record-get",
          "--as", as,
          "--base-token", baseToken,
          "--table-id", table_id,
          "--record-id", record_id,
          "--format", "json",
        ], { cwd: getCwd(), env: getEnv(), encoding: "utf8" });
        return result?.data || {};
      },
    },
    {
      name: "lark_update_record",
      description: "更新 Lark 表中一条记录的字段值",
      inputSchema: {
        type: "object",
        properties: {
          table_id: { type: "string", description: "Lark 表 ID" },
          record_id: { type: "string", description: "记录 ID" },
          fields: {
            type: "object",
            description: "要更新的字段（字段名→新值）",
            additionalProperties: true,
          },
        },
        required: ["table_id", "record_id", "fields"],
        additionalProperties: false,
      },
      handler: ({ table_id, record_id, fields }) => {
        const { as, baseToken } = commonArgs();
        const result = larkCliSync([
          "base", "+record-update",
          "--as", as,
          "--base-token", baseToken,
          "--table-id", table_id,
          "--record-id", record_id,
          "--fields", JSON.stringify(fields),
          "--format", "json",
        ], { cwd: getCwd(), env: getEnv(), encoding: "utf8" });
        if (result.status !== 0) {
          throw new Error(result.stderr || result.stdout || `lark-cli exited ${result.status}`);
        }
        return JSON.parse(result.stdout || "{}");
      },
    },
    {
      name: "lark_create_record",
      description: "在 Lark 表中新建一条记录",
      inputSchema: {
        type: "object",
        properties: {
          table_id: { type: "string", description: "Lark 表 ID" },
          fields: {
            type: "object",
            description: "字段值（字段名→值）",
            additionalProperties: true,
          },
        },
        required: ["table_id", "fields"],
        additionalProperties: false,
      },
      handler: ({ table_id, fields }) => {
        const { as, baseToken } = commonArgs();
        const result = larkCliSync([
          "base", "+record-create",
          "--as", as,
          "--base-token", baseToken,
          "--table-id", table_id,
          "--fields", JSON.stringify(fields),
          "--format", "json",
        ], { cwd: getCwd(), env: getEnv(), encoding: "utf8" });
        if (result.status !== 0) {
          throw new Error(result.stderr || result.stdout || `lark-cli exited ${result.status}`);
        }
        return JSON.parse(result.stdout || "{}");
      },
    },
    {
      name: "lark_delete_record",
      description: "删除 Lark 表中的一条记录",
      inputSchema: {
        type: "object",
        properties: {
          table_id: { type: "string", description: "Lark 表 ID" },
          record_id: { type: "string", description: "记录 ID" },
        },
        required: ["table_id", "record_id"],
        additionalProperties: false,
      },
      handler: ({ table_id, record_id }) => {
        const { as, baseToken } = commonArgs();
        const result = larkCliSync([
          "base", "+record-delete",
          "--as", as,
          "--base-token", baseToken,
          "--table-id", table_id,
          "--record-id", record_id,
          "--format", "json",
        ], { cwd: getCwd(), env: getEnv(), encoding: "utf8" });
        if (result.status !== 0) {
          throw new Error(result.stderr || result.stdout || `lark-cli exited ${result.status}`);
        }
        return JSON.parse(result.stdout || "{}");
      },
    },
  ];
}
