import { readFileSync } from "node:fs";

export function parseEnvText(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadEnvFile(path) {
  return parseEnvText(readFileSync(path, "utf8"));
}

export function redactValue(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 8) return "****";
  return `${text.slice(0, 3)}****${text.slice(-3)}`;
}
