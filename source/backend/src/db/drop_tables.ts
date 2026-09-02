import { initDb, getDb, closeDb, many, run, tx } from "./client.js";

async function main() {
  await initDb();
  const tables = many<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
  
  if (tables.length > 0) {
    tx(() => {
      run(`PRAGMA foreign_keys = OFF`);
      for (const table of tables) {
        run(`DROP TABLE IF EXISTS ${table.name}`);
      }
      run(`PRAGMA foreign_keys = ON`);
    });
    console.log("Dropped all tables");
  } else {
    console.log("No tables to drop");
  }
  
  await closeDb();
}

main().catch(console.error);
