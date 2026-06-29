# Operating Notes

## Local Layout

- Source project: `~/Projects/jira-lark-sync`
- Runtime directory: `~/.local/share/jira-lark-sync`
- Private config: `~/.config/jira-lark-sync/env`
- LaunchAgent: `~/Library/LaunchAgents/com.legend.jira-lark-sync.plist`

Keep source code, runtime data, and private config separate. Do not put Jira tokens, Lark credentials, cache files, or logs into the source project when sharing this setup.

After editing source code, deploy it to the runtime directory with:

```bash
npm run deploy
```

Common local commands:

```bash
npm run health
npm run doctor
npm run refresh:all
npm run refresh:spot
npm run refresh:ui
npm run rotate:jira-token
npm run setup
```

Default refresh targets live in the private table config, usually `~/.config/jira-lark-sync/tables.json`. Add future business tables there instead of editing refresh script code. The shareable template is `config/tables.example.json`.

## Default Full Refresh Scope

When the user asks for "全表更新" or "全表刷新" without specifying another table or view, refresh every Jira row in the private table config default targets.

For the current local setup, those targets are:

- `spot`: 现货总表
- `ui`: 迭代产品UI规划

The refresh scope is the Jira keys currently present in those views, not every Jira key in Jira and not another view of the same table.
