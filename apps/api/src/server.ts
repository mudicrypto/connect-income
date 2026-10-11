import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { settleMaturedInvestments } from "./services/investments.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db, (m) => console.log(`[migrate] ${m}`));

const app = await buildApp({ db, config }, { logger: true });

// Background maturity sweep. Settlement is idempotent per investment, so
// overlapping runs or multiple API instances are safe.
let sweeping = false;
const timer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const { settled } = await settleMaturedInvestments(db);
    if (settled.length) app.log.info({ settled: settled.length }, "settled matured investments");
  } catch (err) {
    app.log.error(err, "maturity sweep failed");
  } finally {
    sweeping = false;
  }
}, config.maturitySweepIntervalMs);

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "127.0.0.1" });
if (config.devMode) app.log.warn("DEV_MODE is on: development login is enabled. Never enable in production.");
