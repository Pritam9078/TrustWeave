import { buildApp } from "./app.js";
import { initDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { env } from "./config/env.js";
import { syncCapabilityCatalog } from "./services/orgService.js";

async function main() {
  await initDb(env.DATABASE_URL);
  await migrate();
  // The capability catalog lives in code and is mirrored into the database on boot, so
  // a deployment can never run with a stale or hand-edited capability list.
  syncCapabilityCatalog();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  app.log.info(
    { port: env.PORT, db: env.DATABASE_FILE, nodeEnv: env.NODE_ENV },
    "TrustWeave v3.0 backend listening",
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info(`${signal} received, shutting down.`);
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
