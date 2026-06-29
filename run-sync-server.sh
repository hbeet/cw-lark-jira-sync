#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)"
set -a
source "${JIRA_LARK_ENV_FILE:-$HOME/.config/jira-lark-sync/env}"
set +a

exec "${JIRA_LARK_NODE:-$(command -v node)}" sync-server.mjs
