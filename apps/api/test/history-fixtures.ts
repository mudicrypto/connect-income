import { randomUUID } from "node:crypto";
import type { Db } from "../src/db/pool.js";
import { withTransaction } from "../src/db/pool.js";
import { ensureAccount, ensureStrategyAccounts, ensureUserAccounts } from "../src/ledger/accounts.js";
import { Money } from "../src/lib/money.js";

/**
 * TEST-ONLY history builder. Daily UTC periods can only be calculated once a day
 * has closed, so these helpers write balanced, integrity-consistent rows dated in
 * the PAST (journal entries with explicit created_at). Production code never sets
 * created_at; everything here mirrors what the real services would have written.
 */

export const utcMidnight = (daysFromToday: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + daysFromToday * 86400_000);
};
export const at = (day: number, hours: number) => new Date(utcMidnight(day).getTime() + hours * 3600_000);

async function entry(
  tx: import("../src/db/pool.js").Tx,
  type: string,
  createdAt: Date,
  postings: Array<{ account: string; direction: "debit" | "credit"; amount: string }>,
) {
  const e = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries (entry_type, idempotency_key, description, created_at, effective_at)
     VALUES ($1, $2, 'test history fixture', $3, $3) RETURNING id`,
    [type, `fixture:${randomUUID()}`, createdAt],
  );
  for (const p of [...postings].sort((a, b) => (a.account < b.account ? -1 : 1))) {
    await tx.query(
      `INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after, created_at)
       VALUES ($1, $2, 'USDT', $3, $4, 0, $5)`,
      [e.rows[0]!.id, p.account, p.direction, p.amount, createdAt],
    );
  }
  return e.rows[0]!.id;
}

/** A v2 pool whose reward periods start at `startAt` (in the past). */
export async function backdatedPool(db: Db, adminId: string, strategyId: string, o: { startAt: Date; capacity: string; periodMode: "daily_utc" | "ad_hoc" }) {
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO reward_pools (strategy_id, customer_capacity, created_by, period_mode, loss_model, rewards_start_at)
       VALUES ($1, $2, $3, $4, 'investment_v2', $5)`,
      [strategyId, o.capacity, adminId, o.periodMode, o.startAt],
    );
    await ensureStrategyAccounts(tx, strategyId, "USDT");
    await ensureAccount(tx, "pool_reserve", "USDT", { strategyId });
  });
}

/** Paper capital allocated at a past time (Dr strategy_cash / Cr strategy_capital). */
export async function backdatedCapital(db: Db, strategyId: string, amount: string, createdAt: Date) {
  await withTransaction(db, async (tx) => {
    const a = await ensureStrategyAccounts(tx, strategyId, "USDT");
    await entry(tx, "strategy_capital_allocation", createdAt, [
      { account: a.cash, direction: "debit", amount },
      { account: a.capital, direction: "credit", amount },
    ]);
    await tx.query(
      `UPDATE strategies SET last_equity = last_equity + $2, peak_equity = peak_equity + $2, day_start_equity = day_start_equity + $2
        WHERE id = $1`,
      [strategyId, amount],
    );
  });
}

/**
 * A realised round trip at a past time: buy 1 unit for `buy`, sell it for `sell`, `fee` on each leg.
 * Booked exactly like the engine books trades (separate ledger entry per fill).
 */
export async function backdatedRoundTrip(db: Db, strategyId: string, instrumentId: string, createdAt: Date, buy: string, sell: string, fee = "0") {
  await withTransaction(db, async (tx) => {
    const a = await ensureStrategyAccounts(tx, strategyId, "USDT");
    const tick = await tx.query<{ id: string }>("SELECT id::text FROM market_ticks WHERE instrument_id = $1 ORDER BY seq LIMIT 1", [instrumentId]);
    const seq = await tx.query<{ n: number }>("SELECT COALESCE(max(seq_in_tick) + 1, 0)::int AS n FROM strategy_trades WHERE strategy_id = $1", [strategyId]);
    const pnl = new Money(sell).minus(buy);
    const buyPostings = [
      { account: a.position, direction: "debit" as const, amount: buy },
      { account: a.cash, direction: "credit" as const, amount: (await tx.query<{ v: string }>("SELECT ($1::numeric + $2::numeric)::text AS v", [buy, fee])).rows[0]!.v },
    ];
    if (fee !== "0") buyPostings.push({ account: a.fees, direction: "debit", amount: fee });
    const buyEntry = await entry(tx, "strategy_trade", createdAt, buyPostings);
    const sellNet = (await tx.query<{ v: string }>("SELECT ($1::numeric - $2::numeric)::text AS v", [sell, fee])).rows[0]!.v;
    const diff = (await tx.query<{ v: string }>("SELECT abs($1::numeric - $2::numeric)::text AS v", [sell, buy])).rows[0]!.v;
    const sellPostings: Array<{ account: string; direction: "debit" | "credit"; amount: string }> = [
      { account: a.cash, direction: "debit", amount: sellNet },
      { account: a.position, direction: "credit", amount: buy },
    ];
    if (fee !== "0") sellPostings.push({ account: a.fees, direction: "debit", amount: fee });
    if (pnl.gt(0)) sellPostings.push({ account: a.gain, direction: "credit", amount: diff });
    if (pnl.lt(0)) sellPostings.push({ account: a.loss, direction: "debit", amount: diff });
    const sellEntry = await entry(tx, "strategy_trade", createdAt, sellPostings);
    const ins = (side: string, n: number, notional: string, released: string, realised: string, after: string, entryId: string) =>
      tx.query(
        `INSERT INTO strategy_trades (strategy_id, instrument_id, tick_id, tick_seq, seq_in_tick, side, reason, quantity, mid_price,
           exec_price, notional, fee, slippage_cost, cost_basis_released, realised_pnl, position_qty_after, entry_id, created_at)
         VALUES ($1, $2, $3, 0, $4, $5, 'signal', 1, $6, $6, $6, $7, 0, $8, $9, $10, $11, $12)`,
        [strategyId, instrumentId, tick.rows[0]!.id, n, side, notional, fee, released, realised, after, entryId, createdAt],
      );
    await ins("buy", seq.rows[0]!.n, buy, "0", "0", "1", buyEntry);
    const realised = (await tx.query<{ v: string }>("SELECT ($1::numeric - $2::numeric)::text AS v", [sell, buy])).rows[0]!.v;
    await ins("sell", seq.rows[0]!.n + 1, sell, buy, realised, "0", sellEntry);
  });
}

/** A funded investor's investment that started (and possibly matured) in the past, with its pool allocation. */
export async function backdatedInvestment(
  db: Db,
  o: { userId: string; productId: string; poolId: string; amount: string; startAt: Date; maturityAt: Date },
) {
  return withTransaction(db, async (tx) => {
    const u = await ensureUserAccounts(tx, o.userId, "USDT");
    const id = randomUUID();
    const open = await entry(tx, "investment_open", o.startAt, [
      { account: u.available, direction: "debit", amount: o.amount },
      { account: u.invested, direction: "credit", amount: o.amount },
    ]);
    await tx.query(
      `INSERT INTO investments (id, user_id, product_id, asset, principal, start_at, maturity_at, open_entry_id, created_at)
       VALUES ($1, $2, $3, 'USDT', $4, $5, $6, $7, $5)`,
      [id, o.userId, o.productId, o.amount, o.startAt, o.maturityAt, open],
    );
    const assignment = await tx.query<{ id: string }>(
      "SELECT a.id::text AS id FROM product_pool_assignments a WHERE a.product_id = $1 ORDER BY a.id DESC LIMIT 1",
      [o.productId],
    );
    await tx.query(
      `INSERT INTO pool_allocations (investment_id, user_id, pool_strategy_id, assignment_id, weight, amount, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7)`,
      [id, o.userId, o.poolId, assignment.rows[0]!.id, o.amount, o.startAt, o.maturityAt],
    );
    return id;
  });
}
