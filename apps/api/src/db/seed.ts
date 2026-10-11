import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { hashPassword } from "../lib/password.js";
import { ensureUserAccounts } from "../ledger/accounts.js";
import { migrate } from "./migrate.js";
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
  await migrate(db, console.log);
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
  }
} finally {
  await db.end();
}
