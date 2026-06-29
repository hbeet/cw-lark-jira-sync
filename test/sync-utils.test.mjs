import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, configureDb, dbExec, dbRun, dbAll } from "../lib/db.mjs";
import {
  delayStatusValue,
  extractJiraKey,
  jiraLinkCell,
  jiraMarkdownLink,
  latestSprintName,
  parseJiraDate,
} from "../lib/sync-utils.mjs";

test("extractJiraKey reads plain text, markdown links, plain Jira URLs, and link cells", () => {
  assert.equal(extractJiraKey("CW-41606"), "CW-41606");
  assert.equal(extractJiraKey("[CW-59338](https://jira/browse/CW-59338)"), "CW-59338");
  assert.equal(extractJiraKey("https://jira.example.com/browse/CW-55485"), "CW-55485");
  assert.equal(extractJiraKey({ text: "CW-55485", link: "https://jira.example.com/browse/CW-55485" }), "CW-55485");
});

test("jira link helpers keep display text as Jira key and click target as browse URL", () => {
  const base = "https://jira.example.com/";
  assert.deepEqual(jiraLinkCell("CW-55485", base), {
    text: "CW-55485",
    link: "https://jira.example.com/browse/CW-55485",
  });
  assert.equal(
    jiraMarkdownLink("CW-55485", base),
    "[CW-55485](https://jira.example.com/browse/CW-55485)",
  );
});

test("latestSprintName keeps the newest D sprint", () => {
  assert.equal(latestSprintName([
    "com.atlassian.greenhopper.service.sprint.Sprint@x[id=1,name=Sprint 11D Foo]",
    "com.atlassian.greenhopper.service.sprint.Sprint@x[id=2,name=Sprint 13D Bar]",
    "Sprint 12D Baz",
  ]), "Sprint 13D Bar");
});

test("date and delay helpers match Base display values", () => {
  assert.equal(parseJiraDate("2026-06-15T19:13:05.000+0800"), "2026-06-15 19:13:05");
  assert.equal(delayStatusValue("2026-06-15 00:00:00", "2026-06-16 00:00:00"), "已延期");
  assert.equal(delayStatusValue("2026-06-16 00:00:00", "2026-06-15 00:00:00"), "未延期");
  assert.equal(delayStatusValue("", "2026-06-15 00:00:00"), "无提交验收时间");
});

test("db module runs statements without spawning sqlite3", () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-lark-sync-"));
  try {
    closeDb();
    configureDb(join(dir, "test.db"));
    dbExec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT);");
    dbRun("INSERT INTO sample (name) VALUES (?);", ["O'Hara"]);
    assert.deepEqual(dbAll("SELECT name FROM sample;", []), [{ name: "O'Hara" }]);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
