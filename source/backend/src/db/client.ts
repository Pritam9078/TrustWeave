import { openDatabase, type Db, type Stmt } from "./driver.js";
import { env } from "../config/env.js";

let db: Db | null = null;

export async function initDb(filename?: string): Promise<Db> {
  if (db) return db;
  db = await openDatabase(filename ?? env.DATABASE_FILE);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not initialised. Call initDb() first.");
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) { db.close(); db = null; }
}

/* --- Small query helpers. Everything is parameterised; no string interpolation
   of user input reaches SQL anywhere in this codebase. --- */

export function one<T = any>(sql: string, ...params: unknown[]): T | null {
  return (getDb().prepare(sql).get(...params) as T) ?? null;
}

export function many<T = any>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: unknown[]): { changes: number } {
  return getDb().prepare(sql).run(...params);
}

export function stmt(sql: string): Stmt {
  return getDb().prepare(sql);
}

/**
 * Synchronous transaction wrapper. node:sqlite has no `.transaction()` helper,
 * so this is explicit. Used by every multi-write operation (mint+event+audit,
 * approve+execute, etc.) so a partial write can never leave an asset owned by
 * nobody or an approval recorded without its audit event.
 */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec("BEGIN");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

export const j = {
  /** Encode for a JSON text column. */
  enc(value: unknown): string { return JSON.stringify(value ?? null); },
  /** Decode a JSON text column, tolerating null/garbage rather than throwing mid-request. */
  dec<T>(value: string | null | undefined, fallback: T): T {
    if (value == null) return fallback;
    try { return JSON.parse(value) as T; } catch { return fallback; }
  },
};
