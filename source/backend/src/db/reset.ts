import { existsSync, unlinkSync } from "node:fs";
import { env } from "../config/env.js";

for (const suffix of ["", "-wal", "-shm"]) {
  const p = env.DATABASE_FILE + suffix;
  if (existsSync(p)) { unlinkSync(p); console.log(`Removed ${p}`); }
}
console.log("Database reset. Run `npm run db:migrate && npm run db:seed`.");
