import test from "node:test";
import assert from "node:assert/strict";
import { createConfig, publicConfigSummary } from "../lib/config.mjs";
import { buildAutoFieldMapping, findJiraFieldName } from "../lib/field-registry.mjs";

test("config summary omits secrets and exposes runtime shape", () => {
  const config = createConfig({
    PORT: "9999",
    SYNC_SECRET: "secret-value",
    LARK_SYNC_CACHE_PATH: "/tmp/jira-lark/index.json",
    LARK_EVENT_ENABLED: "1",
    LARK_INCREMENTAL_REFRESH_ENABLED: "1",
    LARK_INCREMENTAL_REFRESH_SECONDS: "60",
    LARK_BATCH_SYNC_SIZE: "12",
  }, "/app");
  assert.equal(config.cache.dbPath, "/tmp/jira-lark/sync.db");
  assert.deepEqual(publicConfigSummary(config), {
    port: 9999,
    sync_secret_set: true,
    logs_dir: "/app/logs",
    cache_path: "/tmp/jira-lark/index.json",
    db_path: "/tmp/jira-lark/sync.db",
    event_enabled: true,
    incremental_enabled: true,
    incremental_interval_seconds: 60,
    incremental_window: "-6h",
    batch_enabled: true,
    batch_size: 12,
  });
});

test("field registry maps known fields and dynamic status timeline fields", () => {
  const fields = [
    { id: "fld1", name: "Jira号" },
    { id: "fld2", name: "概要" },
    { id: "fld3", name: "进入开发中时间" },
    { id: "fld4", name: "备注" },
  ];
  assert.equal(findJiraFieldName(fields), "Jira号");
  assert.deepEqual(buildAutoFieldMapping(fields), {
    "概要": "fld2",
    "进入开发中时间": "fld3",
  });
});
