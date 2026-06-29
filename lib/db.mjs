import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

let dbPath = "";
let db = null;

export function configureDb(path) {
  dbPath = path;
}

function database() {
  if (!dbPath) throw new Error("SQLite db path is not configured");
  if (!db) {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
  }
  return db;
}

export function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function dbExec(sql) {
  database().exec(sql);
  return "";
}

export function dbQuery(sql) {
  return database().prepare(sql).all().map((row) => ({ ...row }));
}

export function dbGet(sql) {
  const row = database().prepare(sql).get();
  return row ? { ...row } : row;
}

export function closeDb() {
  if (db) db.close();
  db = null;
}
