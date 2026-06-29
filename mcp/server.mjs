#!/usr/bin/env node
/**
 * Jira-Lark Sync MCP Server
 *
 * Provides tools for:
 * - Querying Jira issues (via REST API)
 * - Operating Lark Base tables (via lark-cli)
 * - Controlling the sync service (via localhost HTTP API)
 *
 * Usage:
 *   node mcp/server.mjs
 *
 * Env / config:
 *   Reads from JIRA_LARK_ENV_FILE (default: ~/.config/jira-lark-sync/env)
 *   Project root auto-detected from this file's location.
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadEnvFile } from "../lib/env-file.mjs";
import { createStdioTransport } from "./lib/mcp-transport.mjs";
import { createSyncTools } from "./lib/tools-sync.mjs";
import { createJiraTools } from "./lib/tools-jira.mjs";
import { createLarkTools } from "./lib/tools-lark.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(__dirname);

// Load env
const envFilePath = process.env.JIRA_LARK_ENV_FILE
  || join(homedir(), ".config", "jira-lark-sync", "env");

let env = {};
if (existsSync(envFilePath)) {
  env = loadEnvFile(envFilePath);
} else {
  process.stderr.write(`[jira-lark-mcp] Warning: env file not found at ${envFilePath}\n`);
}

// Merge process.env so PATH etc. are available for lark-cli
const mergedEnv = { ...process.env, ...env };

function getEnv() {
  return mergedEnv;
}

function getCwd() {
  return projectDir;
}

// Collect all tools
const syncTools = createSyncTools(getEnv);
const jiraTools = createJiraTools(getEnv);
const larkTools = createLarkTools(getEnv, getCwd);

const allTools = [...syncTools, ...jiraTools, ...larkTools];

// Build handler map
const handlers = new Map();
for (const tool of allTools) {
  handlers.set(tool.name, tool.handler);
}

// Start MCP server
createStdioTransport({
  serverInfo: {
    name: "jira-lark-sync",
    version: "1.0.0",
  },
  tools: allTools,
  onToolCall: (name, args) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(args);
  },
});

process.stderr.write(`[jira-lark-mcp] Server started (${allTools.length} tools)\n`);
