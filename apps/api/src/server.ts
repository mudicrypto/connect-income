import { loadConfig } from "./config.js";
import { assertSchemaCurrent } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { advanceMarket } from "./market/market.js";
import { settleMaturedInvestments } from "./services/investments.js";
import { runEngine } from "./strategy/engine.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
// Never migrate implicitly: a pending migration (e.g. 0008) is applied only by `npm run migrate`.
await assertSchemaCurrent(db);

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

// Optional simulated market clock: append one synthetic tick per instrument
// and run the strategy engine. Disabled unless SIM_AUTOTICK_SECONDS > 0.
let simTimer: NodeJS.Timeout | undefined;
if (config.simAutoTickSeconds > 0) {
  let ticking = false;
  simTimer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await advanceMarket(db, 1);
      const run = await runEngine(db, { trigger: "scheduler" });
      if (run.status === "failed") app.log.error({ run }, "simulated strategy engine run failed");
    } catch (err) {
      app.log.error(err, "simulated market tick failed");
    } finally {
      ticking = false;
    }
  }, config.simAutoTickSeconds * 1000);
  app.log.info(`simulated market auto-tick every ${config.simAutoTickSeconds}s (SYNTHETIC DATA)`);
}

const shutdown = async () => {
  clearInterval(timer);
  if (simTimer) clearInterval(simTimer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "127.0.0.1" });
if (config.devMode) app.log.warn("DEV_MODE is on: development login is enabled. Never enable in production.");
