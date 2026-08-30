/**
 * Database driver shim.
 *
 * The baseline used `better-sqlite3`, which requires node-gyp compilation and is a
 * frequent "npm install fails on a clean machine" source (it fails outright in this
 * build environment: no prebuilt binary for Node 22.22, and the fallback source
 * build needs a headers download). Node 22.5+ ships `node:sqlite` in core with the
 * same synchronous prepare/run/all/get shape, so the whole project now installs
 * with zero native compilation.
 *
 * `better-sqlite3` is still preferred if it happens to be present, so an existing
 * deployment that already has it built keeps using it. The two APIs are close
 * enough that a ~20-line adapter covers everything this codebase does.
 */

import { createRequire } from "node:module";

/**
 * `node:sqlite` is loaded through createRequire rather than a bare `import`. Bundlers
 * (Vite, which vitest runs on) resolve `node:sqlite` against their built-in module list;
 * because SQLite is still flagged experimental it is absent from that list, so a static
 * import gets rewritten to a bare "sqlite" specifier and fails to resolve. createRequire
 * hands the specifier straight to Node at runtime, bypassing the bundler entirely.
 */
const nodeRequire = createRequire(import.meta.url);

export interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
  readonly driver: "node:sqlite" | "better-sqlite3";
}

export async function openDatabase(filename: string): Promise<Db> {
  try {
    // Optional dependency; absent by default and resolved at runtime only.
    const mod: any = nodeRequire("better-sqlite3");
    const BetterSqlite = mod.default ?? mod;
    const raw = new BetterSqlite(filename);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    return {
      prepare: (sql: string) => raw.prepare(sql) as Stmt,
      exec: (sql: string) => raw.exec(sql),
      close: () => raw.close(),
      driver: "better-sqlite3",
    };
  } catch {
    // Fall through to the built-in.
  }

  const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: any };
  const raw = new DatabaseSync(filename);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");

  return {
    prepare(sql: string): Stmt {
      const st = raw.prepare(sql);
      // node:sqlite rejects `undefined` and booleans as bound values, and returns
      // null-prototype row objects that break `{...row}` spreads downstream.
      // Normalise both directions here so no call site has to remember.
      const norm = (params: unknown[]) =>
        params.map((p) => {
          if (p === undefined) return null;
          if (typeof p === "boolean") return p ? 1 : 0;
          return p;
        }) as any[];
      const plain = (row: any) => (row == null ? row : Object.assign({}, row));
      return {
        run: (...p: unknown[]) => {
          const r = st.run(...norm(p));
          return { changes: Number(r.changes ?? 0) };
        },
        get: (...p: unknown[]) => plain(st.get(...norm(p))),
        all: (...p: unknown[]) => (st.all(...norm(p)) as any[]).map(plain),
      };
    },
    exec: (sql: string) => raw.exec(sql),
    close: () => raw.close(),
    driver: "node:sqlite",
  };
}
