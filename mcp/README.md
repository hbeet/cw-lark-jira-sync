# Jira-Lark Sync MCP Server

让 AI 助手（Claude Desktop / Cowork）直接操作你的 Jira 和 Lark 多维表格。

## 前置条件

1. 本项目已配好并运行中（`npm run health` 通过）
2. `lark-cli` 已安装且在 PATH 中
3. 私有配置已就位：`~/.config/jira-lark-sync/env`

## 接入方法

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "jira-lark-sync": {
      "command": "node",
      "args": ["/path/to/jira-lark-sync/mcp/server.mjs"],
      "env": {
        "JIRA_LARK_ENV_FILE": "/path/to/.config/jira-lark-sync/env"
      }
    }
  }
}
```

### Cowork

在 Cowork 设置中添加 MCP server，command 填：

```
node /path/to/jira-lark-sync/mcp/server.mjs
```

环境变量 `JIRA_LARK_ENV_FILE` 指向你的私有配置文件。

## 提供的工具（20 个）

### 同步操作（9 个）

| 工具 | 说明 |
|------|------|
| `sync_health` | 查看同步服务状态 |
| `sync_jobs` | 查看任务列表（可按状态筛选） |
| `sync_errors` | 查看错误详情 |
| `sync_record` | 同步单个 Jira issue |
| `sync_refresh_all` | 全表刷新 |
| `sync_refresh_table` | 刷新指定表 |
| `sync_retry_failed` | 重试失败任务 |
| `sync_incremental` | 触发增量刷新 |
| `sync_rebuild_index` | 重建索引 |

### Jira 查询（3 个）

| 工具 | 说明 |
|------|------|
| `jira_check` | 检查 Jira 可达性 |
| `jira_get_issue` | 查询单个 issue 详情 |
| `jira_search` | JQL 搜索 |

### Lark 表操作（8 个）

| 工具 | 说明 |
|------|------|
| `lark_check` | 检查 Lark 可达性 |
| `lark_list_tables` | 列出所有表 |
| `lark_list_fields` | 列出表字段 |
| `lark_list_records` | 列出记录 |
| `lark_get_record` | 获取单条记录 |
| `lark_update_record` | 更新记录 |
| `lark_create_record` | 新建记录 |
| `lark_delete_record` | 删除记录 |

## 分享给别人

别人使用只需要：

1. 克隆本项目
2. 安装 `lark-cli`
3. 创建自己的 `~/.config/jira-lark-sync/env`（参考 `.env.example`）
4. 确保同步服务跑起来（`npm run setup && npm run deploy`）
5. 在 Claude Desktop / Cowork 中配置 MCP server 指向 `mcp/server.mjs`

## 私有配置模板

`env` 文件至少需要：

```
JIRA_BASE_URL=https://your-jira.example.com
JIRA_TOKEN=your-jira-pat
LARK_BASE_TOKEN=your-lark-base-token
LARK_TABLE_ID=default-table-id
LARK_APP_ID=your-app-id
LARK_SYNC_DB_PATH=/path/to/sync.db
```

## 开发

```bash
# 语法检查
cd mcp && npm run check

# 手动测试（发送 JSON-RPC）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node server.mjs
```
