import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvText, redactValue } from "../lib/env-file.mjs";
import { resolveTableTargets } from "../lib/table-config.mjs";

test("env file parser handles export, quotes, and comments", () => {
  const env = parseEnvText(`
    # comment
    export A=1
    B="two words"
    C='three words'
  `);
  assert.deepEqual(env, { A: "1", B: "two words", C: "three words" });
});

test("redaction keeps diagnostics useful without exposing secrets", () => {
  assert.equal(redactValue("abcdef123456"), "abc****456");
  assert.equal(redactValue("short"), "****");
});

test("table targets resolve all and named targets", () => {
  const config = {
    defaultTargets: ["spot", "ui"],
    tables: {
      spot: { name: "现货总表" },
      ui: { name: "迭代产品UI规划" },
    },
  };
  assert.deepEqual(resolveTableTargets(config, "all").map((item) => item.key), ["spot", "ui"]);
  assert.deepEqual(resolveTableTargets(config, "ui").map((item) => item.key), ["ui"]);
  assert.throws(() => resolveTableTargets(config, "missing"), /unknown refresh target/);
});
