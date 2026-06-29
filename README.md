# Jira Lark Sync

Local Jira to Lark Base sync service.

## Layout

- Source project: `~/Projects/jira-lark-sync`
- Runtime directory: `~/.local/share/jira-lark-sync`
- Private config: `~/.config/jira-lark-sync/env`
- LaunchAgent: `~/Library/LaunchAgents/com.legend.jira-lark-sync.plist`

Keep source, runtime data, and private config separate. Do not share `.env`, Jira tokens, Lark credentials, runtime cache, or logs.

## Common Commands

```bash
npm run check
npm test
npm run deploy
npm run doctor
npm run health
npm run refresh:all
npm run refresh:spot
npm run refresh:ui
```

Use `npm run deploy` after changing source code. It syncs source into the runtime directory and restarts the LaunchAgent service.

Run `npm run doctor` to produce a redacted diagnostic report.

Default refresh targets are configured in the private table config, usually `~/.config/jira-lark-sync/tables.json`. The shareable template is `config/tables.example.json`.
