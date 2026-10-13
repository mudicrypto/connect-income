import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { hashPassword } from "../lib/password.js";
import { ensureUserAccounts } from "../ledger/accounts.js";
import { advanceMarket, latestTick } from "../market/market.js";
import { runEngine } from "../strategy/engine.js";
import { allocateCapital, createStrategy } from "../strategy/strategies.js";
import { assignProductToPool, registerPool } from "../rewards/pools.js";
import { assertSchemaCurrent } from "./migrate.js";
import { createPool, withTransaction } from "./pool.js";

/**
 * Synthetic development data only. Safe to run repeatedly.
 * No product carries a promised rate: returns will come from simulated
 * strategy performance in a later milestone.
 */
const RISK =
  "Simulated product for development. No return is guaranteed. Future rewards will depend entirely on " +
  "simulated strategy performance and may be zero. Principal is locked until the maturity date.";

const PRODUCTS = [
  {
    code: "FT-30D",
    name: "Fixed Term 30 days",
    description: "Lock simulated USDT for 30 days.",
    termMinutes: 30 * 1440,
    min: "10",
    max: "100000",
    strategy: "Diversified basket (strategy engine pending): staking, lending and market-neutral trading.",
    devOnly: false,
  },
  {
    code: "FT-90D",
    name: "Fixed Term 90 days",
    description: "Lock simulated USDT for 90 days.",
    termMinutes: 90 * 1440,
    min: "50",
    max: "250000",
    strategy: "Diversified basket (strategy engine pending) with a larger lending allocation.",
    devOnly: false,
  },
  {
    code: "FT-180D",
    name: "Fixed Term 180 days",
    description: "Lock simulated USDT for 180 days.",
    termMinutes: 180 * 1440,
    min: "100",
    max: "500000",
    strategy: "Diversified basket (strategy engine pending) including discretionary trader allocations.",
    devOnly: false,
  },
  {
    code: "DEV-5MIN",
    name: "Dev: 5-minute term",
    description: "Development-only product that matures after 5 minutes, for testing settlement.",
    termMinutes: 5,
    min: "1",
    max: null,
    strategy: "None. Principal is returned at maturity.",
    devOnly: true,
  },
];

const ADMIN_EMAIL = "admin@connect-income.local";

const config = loadConfig();
const db = createPool(config.databaseUrl);
try {
  await assertSchemaCurrent(db); // never migrates implicitly; run `npm run migrate` first
  await withTransaction(db, async (tx) => {
    for (const p of PRODUCTS) {
      await tx.query(
        `INSERT INTO investment_products
           (code, name, description, asset, term_minutes, min_amount, max_amount, strategy_description, risk_disclosure, dev_only)
         VALUES ($1, $2, $3, 'USDT', $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code) DO NOTHING`,
        [p.code, p.name, p.description, p.termMinutes, p.min, p.max, p.strategy, RISK, p.devOnly],
      );
    }
  });
  console.log(`seeded ${PRODUCTS.length} investment products`);

  if (config.devMode) {
    const existing = await db.query("SELECT 1 FROM users WHERE lower(email) = $1", [ADMIN_EMAIL]);
    if (!existing.rowCount) {
      const password = process.env.SEED_ADMIN_PASSWORD || randomBytes(12).toString("base64url");
      await withTransaction(db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, 'Dev Admin', $2, 'admin') RETURNING id`,
          [ADMIN_EMAIL, await hashPassword(password)],
        );
        await ensureUserAccounts(tx, rows[0]!.id, "USDT");
      });
      console.log(`created dev admin ${ADMIN_EMAIL} with password: ${password}  (shown once; not stored anywhere)`);
    } else {
      console.log(`dev admin ${ADMIN_EMAIL} already exists`);
    }
    await seedStrategies();
    await seedRewardPools();
  }
} finally {
  await db.end();
}

/**
 * Demo strategies on SYNTHETIC market data with simulated paper capital.
 * Created once; then the market is advanced and the engine run so the admin
 * dashboard has history to show.
 */
async function seedStrategies() {
  const existing = await db.query("SELECT count(*)::int AS n FROM strategies");
  if (existing.rows[0].n > 0) {
    console.log("demo strategies already exist");
    return;
  }
  const admin = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [ADMIN_EMAIL]);
  const adminId = admin.rows[0]!.id;
  const btc = await db.query<{ id: string }>("SELECT id FROM market_instruments WHERE symbol = 'SIM-BTC-USDT'");
  if (!(await latestTick(db, btc.rows[0]!.id))) await advanceMarket(db, 48); // history for lookbacks

  const demos = [
    {
      code: "MOMO-BTC",
      name: "Momentum trader (simulated)",
      description: "Rules-based momentum: enters after a 24-tick rise above 1.5%, exits after a 1% decline. Paper trading on synthetic data.",
      type: "trading",
      instrumentSymbol: "SIM-BTC-USDT",
      maxAllocation: "100000",
      maxPositionValue: "40000",
      maxExposureRatio: "0.6",
      dailyLossLimit: "2500",
      maxDrawdownRatio: "0.15",
      params: { lookbackTicks: 24, entryThresholdBps: 150, exitThresholdBps: -100, targetExposure: "0.5", minTradeValue: "50" },
      capital: "50000",
    },
    {
      code: "STAKE-ETH",
      name: "Staking allocator (simulated)",
      description: "Holds ~80% in a synthetic staked-asset index and rebalances outside a 5% band.",
      type: "staking",
      instrumentSymbol: "SIM-ETH-STAKED",
      maxAllocation: "100000",
      maxPositionValue: "50000",
      maxExposureRatio: "0.9",
      dailyLossLimit: "3000",
      maxDrawdownRatio: "0.2",
      params: { targetExposure: "0.8", rebalanceBand: "0.05", minTradeValue: "50" },
      capital: "50000",
    },
    {
      code: "LEND-USDT",
      name: "Lending allocator (simulated)",
      description: "Supplies ~90% to a synthetic lending pool whose index accrues simulated interest, with rare default haircuts.",
      type: "lending",
      instrumentSymbol: "SIM-USDT-LENDING",
      maxAllocation: "100000",
      maxPositionValue: "60000",
      maxExposureRatio: "0.95",
      dailyLossLimit: "1500",
      maxDrawdownRatio: "0.05",
      params: { targetExposure: "0.9", rebalanceBand: "0.02", minTradeValue: "50" },
      capital: "50000",
    },
  ];
  for (const { capital, ...d } of demos) {
    const id = await createStrategy(db, adminId, d);
    await allocateCapital(db, { actorUserId: adminId, strategyId: id, amount: capital, idempotencyKey: `seed-allocation-${d.code}` });
  }
  await advanceMarket(db, 168); // one simulated week of hourly ticks
  const run = await runEngine(db, { trigger: "seed", actorUserId: adminId });
  console.log(`seeded ${demos.length} demo strategies on synthetic data; engine run ${run.status}, ${run.trades} simulated trades`);
}

/**
 * Demo reward pools (SIMULATED): products participate in strategy pools;
 * FT-180D stays principal-only to show the contrast.
 */
async function seedRewardPools() {
  const existing = await db.query("SELECT count(*)::int AS n FROM reward_pools");
  if (existing.rows[0].n > 0) {
    console.log("reward pools already exist");
    return;
  }
  const admin = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [ADMIN_EMAIL]);
  const adminId = admin.rows[0]!.id;
  const ids = async (table: string, codes: string[]) =>
    new Map((await db.query<{ id: string; code: string }>(`SELECT id, code FROM ${table} WHERE code = ANY($1)`, [codes])).rows.map((r) => [r.code, r.id]));
  const strategies = await ids("strategies", ["MOMO-BTC", "STAKE-ETH"]);
  const products = await ids("investment_products", ["FT-30D", "FT-90D", "DEV-5MIN"]);
  if (strategies.size < 2 || products.size < 3) {
    console.log("skipping reward pools: demo strategies/products missing");
    return;
  }
  await registerPool(db, adminId, { strategyId: strategies.get("MOMO-BTC")!, customerCapacity: "25000" });
  await registerPool(db, adminId, { strategyId: strategies.get("STAKE-ETH")!, customerCapacity: "25000" });
  for (const [product, strategy] of [["FT-30D", "MOMO-BTC"], ["DEV-5MIN", "MOMO-BTC"], ["FT-90D", "STAKE-ETH"]] as const) {
    await assignProductToPool(db, adminId, { productId: products.get(product)!, poolStrategyId: strategies.get(strategy)!, reason: "seed" });
  }
  console.log("seeded 2 simulated reward pools (MOMO-BTC: FT-30D, DEV-5MIN; STAKE-ETH: FT-90D); FT-180D is principal-only");
}
