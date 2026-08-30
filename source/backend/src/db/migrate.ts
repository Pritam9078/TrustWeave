import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, getDb, one, run, closeDb } from "./client.js";
import { nowIso } from "../core/time.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(file?: string): Promise<string[]> {
  await initDb(file);
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const dir = resolve(here, "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const name of files) {
    const already = one<{ name: string }>(`SELECT name FROM schema_migrations WHERE name = ?`, name);
    if (already) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.exec(sql);
    run(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, name, nowIso());
    applied.push(name);
  }
  return applied;
}

if (process.argv[1]?.includes("migrate")) {
  migrate()
    .then((a) => { console.log(a.length ? `Applied: ${a.join(", ")}` : "Schema already up to date."); return closeDb(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
