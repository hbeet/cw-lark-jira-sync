#!/usr/bin/env bash
set -euo pipefail

cd /Users/bin/Documents/Codex/2026-06-15/jira-api-key
set -a
source /Users/bin/.config/jira-lark-sync/env
set +a

exec /Users/bin/.local/bin/node sync-server.mjs
