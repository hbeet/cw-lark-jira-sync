import { spawn, spawnSync } from "node:child_process";

export function larkCliSync(args, options = {}) {
  return spawnSync("lark-cli", args, {
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
}

export function larkCliSpawn(args, options = {}) {
  return spawn("lark-cli", args, options);
}

export function larkCliJson(args, options = {}) {
  const result = larkCliSync(args, options);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `lark-cli exited with ${result.status}`);
  }
  if (!result.stdout) return null;
  return JSON.parse(result.stdout);
}
