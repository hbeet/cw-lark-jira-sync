# Operating Notes

## Local Layout

- Source project: `/Users/bin/Projects/jira-lark-sync`
- Runtime directory: `/Users/bin/.local/share/jira-lark-sync`
- Private config: `/Users/bin/.config/jira-lark-sync/env`
- LaunchAgent: `/Users/bin/Library/LaunchAgents/com.legend.jira-lark-sync.plist`

Keep source code, runtime data, and private config separate. Do not put Jira tokens, Lark credentials, cache files, or logs into the source project when sharing this setup.

After editing source code, deploy it to the runtime directory with:

```bash
npm run deploy
```

Common local commands:

```bash
npm run health
npm run refresh:all
npm run refresh:spot
npm run refresh:ui
npm run rotate:jira-token
```

## Default Full Refresh Scope

When the user asks for "全表更新" or "全表刷新" without specifying another table or view, refresh every Jira row in these Lark Base views:

- Base token: `GpJLbIuPWaT5wFs8eVhjvYCRpdH`
- `现货总表`
  - URL: `https://djp2z41iwqtc.jp.larksuite.com/wiki/WsYhwTavjigb9nkgY9Mjhi2tpCf?table=tblXAEpyR8CBg4r2&openInNewTab=true&view=vewm4Z6sMK`
  - Table: `tblXAEpyR8CBg4r2`
  - View: `vewm4Z6sMK`
- `迭代产品UI规划`
  - URL: `https://djp2z41iwqtc.jp.larksuite.com/wiki/WsYhwTavjigb9nkgY9Mjhi2tpCf?table=tblzzkHyrY7TaGE0&openInNewTab=true&view=vewxCTMkfC`
  - Table: `tblzzkHyrY7TaGE0`
  - View: `vewxCTMkfC`

The refresh scope is the Jira keys currently present in those views, not every Jira key in Jira and not another view of the same table.
