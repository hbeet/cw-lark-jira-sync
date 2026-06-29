#!/usr/bin/env node
const healthUrl = process.env.JIRA_LARK_HEALTH_URL || "http://127.0.0.1:8787/health";

function startupSummary(status) {
  const startup = status.startup_readiness || {};
  return {
    ok: Boolean(startup.ok),
    lark: Boolean(startup.lark?.ok),
    jira: Boolean(startup.jira?.ok),
    jira_user: startup.jira?.authenticated_user || "",
  };
}

try {
  const response = await fetch(healthUrl);
  if (!response.ok) throw new Error(`health failed status=${response.status}`);
  const status = await response.json();
  const summary = {
    running: Boolean(status.running),
    queued: Number(status.queued || 0),
    event_listener: Boolean(status.event?.listener_running),
    incremental_enabled: Boolean(status.incremental?.enabled),
    incremental_window: status.incremental?.window || "",
    startup: startupSummary(status),
    last_run: {
      status: status.last_run?.status || null,
      trigger: status.last_run?.trigger || null,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.event_listener || !summary.startup.ok) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
