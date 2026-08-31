import { Pool, PoolClient } from "pg";
import { env } from "../config/env.js";
import { AsyncLocalStorage } from "node:async_hooks";

let pool: Pool | null = null;
const txContext = new AsyncLocalStorage<PoolClient>();

export async function initDb(connectionString?: string): Promise<Pool> {
  if (pool) return pool;
  
  const connString = connectionString ?? env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connString) {
    throw new Error("DATABASE_URL environment variable is required.");
  }
  
  pool = new Pool({
    connectionString: connString,
    ssl: connString.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  
  return pool;
}

export function getDb(): Pool {
  if (!pool) throw new Error("Database not initialised. Call initDb() first.");
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

function toPgQuery(sql: string): string {
  let counter = 1;
  return sql.replace(/\?/g, () => `$${counter++}`);
}

function getRunner(): Pool | PoolClient {
  return txContext.getStore() ?? getDb();
}

export async function one<T = any>(sql: string, ...params: unknown[]): Promise<T | null> {
  const result = await getRunner().query(toPgQuery(sql), params);
  return (result.rows[0] as T) ?? null;
}

export async function many<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await getRunner().query(toPgQuery(sql), params);
  return result.rows as T[];
}

export async function run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
  const result = await getRunner().query(toPgQuery(sql), params);
  return { changes: result.rowCount ?? 0 };
}

export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txContext.getStore()) return fn();
  
  const client = await getDb().connect();
  return txContext.run(client, async () => {
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  });
}

export const j = {
  enc(value: unknown): string { return JSON.stringify(value ?? null); },
  dec<T>(value: string | null | undefined | object, fallback: T): T {
    if (value == null) return fallback;
    if (typeof value === "object") return value as T;
    try { return JSON.parse(value) as T; } catch { return fallback; }
  },
};
