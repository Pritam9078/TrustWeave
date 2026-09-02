import { initDb, getDb, closeDb } from "./client.js";

async function main() {
  await initDb();
  const db = getDb();
  await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres; GRANT ALL ON SCHEMA public TO public;`);
  console.log("Dropped schema public");
  await closeDb();
}

main().catch(console.error);
