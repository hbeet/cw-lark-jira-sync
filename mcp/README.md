# Jira-Lark Sync MCP Server

让 Claude 直接操作你的 Jira 和 Lark 多维表格。

## 快速开始

```bash
git clone <repo> ~/Projects/jira-lark-sync
cd ~/Projects/jira-lark-sync
node scripts/setup.mjs
```

setup wizard 会引导你完成所有配置（约 3 分钟）：
1. 检查 Node.js 和 lark-cli
2. lark-cli 扫码登录
3. 配置 Jira Token（自动打开浏览器）
4. 粘贴飞书表格链接
5. 自动部署服务 + 生成 MCP 配置

## 验证

setup 完成后在 Claude 中试试：
- "检查 Jira 连通性"
- "列出 Lark 表"
- "查看同步服务状态"

## 提供的工具（20 个）

### 同步操作

| 工具 | 说明 |
|------|------|
| `sync_health` | 查看同步服务状态 |
| `sync_jobs` | 查看任务列表 |
| `sync_errors` | 查看错误详情 |
| `sync_record` | 同步单个 Jira issue |
| `sync_refresh_all` | 全表刷新 |
| `sync_refresh_table` | 刷新指定表 |
| `sync_retry_failed` | 重试失败任务 |
| `sync_incremental` | 触发增量刷新 |
| `sync_rebuild_index` | 重建索引 |

### Jira 查询

| 工具 | 说明 |
|------|------|
| `jira_check` | 检查 Jira 可达性 |
| `jira_get_issue` | 查询 issue 详情 |
| `jira_search` | JQL 搜索 |

### Lark 表操作

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

## 日常维护

```bash
# 检查服务
curl -s http://127.0.0.1:8787/health | jq .ok

# 查看日志
tail -f ~/.local/share/jira-lark-sync/logs/launchd-sync-server.err.log

# 更换 Jira Token（过期时）
node scripts/rotate-jira-token.mjs

# 全面诊断
node scripts/doctor.mjs

# 更新代码后重新部署
git pull && node scripts/deploy-local.mjs
```

## 常见问题

| 问题 | 解决 |
|------|------|
| sync_* 工具报 connection refused | 服务未启动：`launchctl kickstart gui/$(id -u)/com.legend.jira-lark-sync` |
| Jira 401 | Token 过期，运行 `node scripts/rotate-jira-token.mjs` |
| Lark 无数据 | 确认已被邀请到对应 Base |
| VPN 相关 | Jira 需要公司网络/VPN |
