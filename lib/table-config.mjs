import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const DEFAULT_TABLE_CONFIG_PATH = "config/tables.example.json";

export function loadTableConfig(path = DEFAULT_TABLE_CONFIG_PATH, baseDir = process.cwd()) {
  const configPath = isAbsolute(path) ? path : join(baseDir, path);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const tables = config.tables || {};
  const defaultTargets = Array.isArray(config.defaultTargets) ? config.defaultTargets : Object.keys(tables);
  return { ...config, tables, defaultTargets };
}

export function resolveTableTargets(config, target = "all") {
  const targets = target === "all" ? config.defaultTargets : [target];
  for (const key of targets) {
    if (!config.tables[key]) {
      throw new Error(`unknown refresh target: ${key}; available targets: all, ${Object.keys(config.tables).join(", ")}`);
    }
  }
  return targets.map((key) => ({ key, ...config.tables[key] }));
}
