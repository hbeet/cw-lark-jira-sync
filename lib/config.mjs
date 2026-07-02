import { dirname, join } from "node:path";
import { homedir } from "node:os";

function intEnv(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(env, name, enabledValue = "1") {
  return env[name] === enabledValue;
}

function notZeroEnv(env, name) {
  return env[name] !== "0";
}

export function createConfig(env = process.env, baseDir = process.cwd()) {
  const port = intEnv(env, "PORT", 8787);
  const eventAppId = env.LARK_APP_ID || "";
  const cachePath = env.LARK_SYNC_CACHE_PATH || join(baseDir, "cache", "index.json");
  const baseTokens = (env.LARK_BASE_TOKENS || env.LARK_BASE_TOKEN || "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    port,
    syncSecret: env.SYNC_SECRET || "",
    scriptPath: env.SYNC_SCRIPT || join(baseDir, "sync-runner.mjs"),
    logsDir: env.SYNC_LOG_DIR || join(baseDir, "logs"),
    baseTokens,
    excludedTables: (env.LARK_EXCLUDED_TABLE_IDS || "").split(",").map((id) => id.trim()).filter(Boolean),
    syncConfigCacheSeconds: 300,
    event: {
      enabled: boolEnv(env, "LARK_EVENT_ENABLED"),
      listenerPath: env.LARK_EVENT_LISTENER || join(baseDir, "lark_event_listener.py"),
      python: env.LARK_EVENT_PYTHON || join(baseDir, ".venv-lark-sdk/bin/python"),
      appId: eventAppId,
      secretFile: env.LARK_APP_SECRET_FILE || "",
      encryptedSecretFile: env.LARK_APP_SECRET_ENC_FILE || join(homedir(), "Library/Application Support/lark-cli", `appsecret_${eventAppId || "missing-app-id"}.enc`),
      masterKeyFile: env.LARK_MASTER_KEY_FILE || join(homedir(), "Library/Application Support/lark-cli/master.key.file"),
    },
    incremental: {
      enabled: boolEnv(env, "LARK_INCREMENTAL_REFRESH_ENABLED"),
      intervalMs: intEnv(env, "LARK_INCREMENTAL_REFRESH_SECONDS", 21600) * 1000,
      window: env.LARK_INCREMENTAL_JQL_WINDOW || "-6h",
      project: env.LARK_INCREMENTAL_JQL_PROJECT || "",
      retryWhenUnreachableMs: intEnv(env, "LARK_INCREMENTAL_RETRY_WHEN_UNREACHABLE_SECONDS", 300) * 1000,
    },
    jira: {
      reachabilityCheckEnabled: notZeroEnv(env, "JIRA_REACHABILITY_CHECK_ENABLED"),
      reachabilityTimeoutMs: intEnv(env, "JIRA_REACHABILITY_TIMEOUT_MS", 5000),
    },
    cache: {
      path: cachePath,
      dbPath: env.LARK_SYNC_DB_PATH || join(dirname(cachePath), "sync.db"),
    },
    jobs: {
      maxAttempts: intEnv(env, "LARK_JOB_MAX_ATTEMPTS", 4),
      runningStaleSeconds: intEnv(env, "LARK_RUNNING_JOB_STALE_SECONDS", 120),
      processTimeoutMs: intEnv(env, "LARK_SYNC_PROCESS_TIMEOUT_SECONDS", 300) * 1000,
    },
    batch: {
      enabled: notZeroEnv(env, "LARK_BATCH_SYNC_ENABLED"),
      size: intEnv(env, "LARK_BATCH_SYNC_SIZE", 50),
      dispatchDelayMs: intEnv(env, "LARK_BATCH_DISPATCH_DELAY_MS", 1500),
    },
    logs: {
      retentionDays: intEnv(env, "SYNC_LOG_RETENTION_DAYS", 14),
      retentionMaxFiles: intEnv(env, "SYNC_LOG_RETENTION_MAX_FILES", 300),
      launchdMaxBytes: intEnv(env, "SYNC_LAUNCHD_LOG_MAX_BYTES", 1024 * 1024),
    },
    startupReadiness: {
      enabled: notZeroEnv(env, "STARTUP_READINESS_CHECK_ENABLED"),
      maxSeconds: intEnv(env, "STARTUP_READINESS_MAX_SECONDS", 120),
      intervalSeconds: intEnv(env, "STARTUP_READINESS_INTERVAL_SECONDS", 15),
    },
  };
}

export function publicConfigSummary(config) {
  return {
    port: config.port,
    sync_secret_set: Boolean(config.syncSecret),
    logs_dir: config.logsDir,
    cache_path: config.cache.path,
    db_path: config.cache.dbPath,
    event_enabled: config.event.enabled,
    incremental_enabled: config.incremental.enabled,
    incremental_interval_seconds: config.incremental.intervalMs / 1000,
    incremental_window: config.incremental.window,
    batch_enabled: config.batch.enabled,
    batch_size: config.batch.size,
  };
}
