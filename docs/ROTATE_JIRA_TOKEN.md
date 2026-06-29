# 更换 Jira API Token

这套流程用于更换本机 Jira -> Lark 同步服务使用的 Jira API Token。

## 安全原则

- 不要把 Jira Token 发给 AI、同事、群聊、文档或截图。
- 不要把 Jira Token 粘贴到聊天输入框。
- 请在自己的系统 Terminal 中运行脚本。
- 脚本会用星号掩码显示输入长度，并在写入前验证 token 是否可用。
- 脚本会自动备份原配置为 `.bak`。

## 操作步骤

进入同步服务目录：

```bash
cd /Users/bin/Projects/jira-lark-sync
```

运行向导：

```bash
node scripts/rotate-jira-token.mjs
```

看到提示后，粘贴新的 Jira API Token 并按回车。粘贴时会立即显示为同等长度的 `*`。

脚本会自动完成：

1. 从配置中读取 `JIRA_BASE_URL`
2. 以星号掩码读取新的 `JIRA_TOKEN`
3. 调用 Jira `/rest/api/2/serverInfo` 验证 token
4. 更新运行配置 `/Users/bin/.config/jira-lark-sync/env`
5. 更新项目配置 `.env`
6. 重启本机 LaunchAgent 服务

## 验证

```bash
curl -s http://127.0.0.1:8787/health | jq '.startup_readiness.jira, .incremental.jira_reachability'
```

看到 `ok: true` 和 `status: 200` 即表示新 token 生效。

## 演示模式

如果只是演示流程，不想写入配置：

```bash
node scripts/rotate-jira-token.mjs --dry-run
```

如果不想重启服务：

```bash
node scripts/rotate-jira-token.mjs --no-restart
```

如果暂时跳过 Jira 验证：

```bash
node scripts/rotate-jira-token.mjs --no-verify
```

## 常见问题

如果真实 token 显示在屏幕上，立刻按 `Control+C` 取消，不要继续。

如果脚本提示无法打开 `/dev/tty`，说明当前环境不是正常交互终端。请换到系统 Terminal 后重试。

如果验证失败，脚本不会写入配置。请确认：

- token 没有复制错
- Jira 地址正确
- 电脑已经连上公司 VPN 或内网
- 当前 Jira 账号仍有访问权限
