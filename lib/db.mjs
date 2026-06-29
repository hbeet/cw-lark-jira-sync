import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

let dbPath = "";
let db = null;
const stmtCache = new Map();
const STMT_CACHE_MAX = 128;

export function configureDb(path) {
  if (db) closeDb();
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

/** @deprecated Use dbRun/dbAll with params instead */
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

/**
 * Execute a parameterized statement (INSERT/UPDATE/DELETE).
 * Returns { changes, lastInsertRowid }.
 */
export function dbRun(sql, params = []) {
  const stmt = getOrPrepare(sql);
  return stmt.run(...params);
}

/**
 * Query with parameters. Returns array of row objects.
 */
export function dbAll(sql, params = []) {
  const stmt = getOrPrepare(sql);
  return stmt.all(...params).map((row) => ({ ...row }));
}

/**
 * Query single row with parameters. Returns row object or undefined.
 */
export function dbOne(sql, params = []) {
  const stmt = getOrPrepare(sql);
  const row = stmt.get(...params);
  return row ? { ...row } : undefined;
}

function getOrPrepare(sql) {
  let stmt = stmtCache.get(sql);
  if (stmt) {
    stmtCache.delete(sql);
    stmtCache.set(sql, stmt);
    return stmt;
  }
  stmt = database().prepare(sql);
  stmtCache.set(sql, stmt);
  if (stmtCache.size > STMT_CACHE_MAX) {
    const oldest = stmtCache.keys().next().value;
    stmtCache.delete(oldest);
  }
  return stmt;
}

export function closeDb() {
  stmtCache.clear();
  if (db) db.close();
  db = null;
}
