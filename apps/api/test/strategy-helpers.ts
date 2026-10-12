import { randomUUID } from "node:crypto";
import type { Db } from "../src/db/pool.js";
import { appendScriptedTicks } from "../src/market/market.js";
import { Money } from "../src/lib/money.js";
import { allocateCapital, createStrategy } from "../src/strategy/strategies.js";
import { key } from "./helpers.js";

/** A synthetic instrument whose prices the test scripts explicitly. */
export async function scriptedInstrument(
  db: Db,
  o: { kind?: "spot" | "staking" | "lending"; feeBps?: string; slippageBps?: string; startPrice?: string } = {},
) {
  const symbol = `SIM-T-${randomUUID().slice(0, 8).toUpperCase()}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO market_instruments
       (symbol, name, description, kind, quote_asset, data_source, fee_bps, slippage_bps, tick_interval_minutes, genesis_at)
     VALUES ($1, 'Scripted test instrument', 'Scripted synthetic prices for tests', $2, 'USDT', 'synthetic_scripted', $3, $4, 60,
             '2026-01-01T00:00:00Z') RETURNING id`,
    [symbol, o.kind ?? "spot", o.feeBps ?? "10", o.slippageBps ?? "0"],
  );
  const id = rows[0]!.id;
  await appendScriptedTicks(db, id, [o.startPrice ?? "100"]);
  return { id, symbol };
}

export const GENEROUS_LIMITS = {
  maxAllocation: "100000",
  maxPositionValue: "100000",
  maxExposureRatio: "1",
  dailyLossLimit: "100000",
  maxDrawdownRatio: "0.99",
};

export async function makeStrategy(
  db: Db,
  adminId: string,
  o: {
    type: "trading" | "staking" | "lending";
    instrumentSymbol: string;
    capital?: string;
    params?: Record<string, unknown>;
    limits?: Partial<typeof GENEROUS_LIMITS>;
  },
) {
  const id = await createStrategy(db, adminId, {
    code: `T-${randomUUID().slice(0, 8).toUpperCase()}`,
    name: "Test strategy",
    type: o.type,
    instrumentSymbol: o.instrumentSymbol,
    ...GENEROUS_LIMITS,
    ...o.limits,
    params: o.params ?? {},
  });
  if (o.capital) await allocateCapital(db, { actorUserId: adminId, strategyId: id, amount: o.capital, idempotencyKey: key() });
  return id;
}

/** Momentum rule that buys after a +1% move over one tick and exits after a -1% move. */
export const MOMENTUM_1 = { lookbackTicks: 1, entryThresholdBps: 100, exitThresholdBps: -100, targetExposure: "0.5", minTradeValue: "1" };

export async function trades(db: Db, strategyId: string) {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT tick_seq::text, side, reason, quantity::text, exec_price::text, notional::text, fee::text, realised_pnl::text,
            slippage_cost::text
       FROM strategy_trades t WHERE strategy_id = $1 ORDER BY t.tick_seq, t.seq_in_tick`,
    [strategyId],
  );
  // Normalise NUMERIC text (trailing zeros) so expectations read naturally.
  const numeric = ["quantity", "exec_price", "notional", "fee", "realised_pnl", "slippage_cost"];
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, numeric.includes(k) ? new Money(v).toFixed() : v])));
}

export async function strategyAccountBalances(db: Db, strategyId: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ purpose: string; balance: string }>(
    "SELECT purpose, balance::text FROM ledger_accounts WHERE owner_strategy_id = $1",
    [strategyId],
  );
  return Object.fromEntries(rows.map((r) => [r.purpose, new Money(r.balance).toFixed()]));
}

/**
 * LEGACY FIXTURE: a pool on the milestone-3 pool-wide loss model (pool_v1) with ad hoc
 * periods. Production never creates these any more (new pools are investment_v2); they
 * exist only for pools migrated with legacy balances, so their v1 behaviour stays tested.
 */
export async function registerLegacyV1Pool(db: Db, adminId: string, strategyId: string, customerCapacity: string) {
  await db.query(
    `INSERT INTO reward_pools (strategy_id, customer_capacity, created_by, period_mode, loss_model)
     VALUES ($1, $2, $3, 'ad_hoc', 'pool_v1')`,
    [strategyId, customerCapacity, adminId],
  );
  const { ensureAccount, ensureStrategyAccounts } = await import("../src/ledger/accounts.js");
  const { withTransaction } = await import("../src/db/pool.js");
  await withTransaction(db, async (tx) => {
    await ensureStrategyAccounts(tx, strategyId, "USDT");
    await ensureAccount(tx, "pool_reserve", "USDT", { strategyId });
  });
}
