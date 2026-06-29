#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)"
set -a
source /Users/bin/.config/jira-lark-sync/env
set +a

exec /Users/bin/.local/bin/node sync-server.mjs
