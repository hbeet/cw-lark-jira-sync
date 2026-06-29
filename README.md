# Jira Lark Sync

Local Jira to Lark Base sync service.

## Layout

- Source project: `/Users/bin/Projects/jira-lark-sync`
- Runtime directory: `/Users/bin/.local/share/jira-lark-sync`
- Private config: `/Users/bin/.config/jira-lark-sync/env`
- LaunchAgent: `/Users/bin/Library/LaunchAgents/com.legend.jira-lark-sync.plist`

Keep source, runtime data, and private config separate. Do not share `.env`, Jira tokens, Lark credentials, runtime cache, or logs.

## Common Commands

```bash
npm run check
npm test
npm run deploy
npm run health
npm run refresh:all
npm run refresh:spot
npm run refresh:ui
```

Use `npm run deploy` after changing source code. It syncs source into the runtime directory and restarts the LaunchAgent service.
