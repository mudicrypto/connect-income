import type { Db, Tx } from "../db/pool.js";
import { Money } from "../lib/money.js";
import { rewardIntegrityProblems } from "../rewards/integrity.js";

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  problems: string[];
  trialBalance: Array<{ asset: string; debitNormalTotal: string; creditNormalTotal: string }>;
}

/**
 * Independently re-derive ledger state from raw postings and compare it with
 * cached balances and business tables. Used by tests and the admin endpoint.
 */
export async function checkLedgerIntegrity(db: Db | Tx): Promise<IntegrityReport> {
  const problems: string[] = [];

  const unbalanced = await db.query<{ entry_id: string; asset: string; diff: string }>(`
    SELECT entry_id, asset, sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END)::text AS diff
      FROM ledger_postings GROUP BY entry_id, asset
    HAVING sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`);
  for (const r of unbalanced.rows) problems.push(`entry ${r.entry_id} unbalanced for ${r.asset} by ${r.diff}`);

  const thin = await db.query<{ id: string }>(`
    SELECT e.id FROM journal_entries e LEFT JOIN ledger_postings p ON p.entry_id = e.id
     GROUP BY e.id HAVING count(p.id) < 2`);
  for (const r of thin.rows) problems.push(`entry ${r.id} has fewer than two postings`);

  const drift = await db.query<{ code: string; cached: string; derived: string }>(`
    SELECT a.code, a.balance::text AS cached,
           COALESCE(sum(CASE WHEN p.direction = a.normal_balance THEN p.amount ELSE -p.amount END), 0)::text AS derived
      FROM ledger_accounts a LEFT JOIN ledger_postings p ON p.account_id = a.id
     GROUP BY a.id
    HAVING a.balance <> COALESCE(sum(CASE WHEN p.direction = a.normal_balance THEN p.amount ELSE -p.amount END), 0)`);
  for (const r of drift.rows) problems.push(`account ${r.code} cached balance ${r.cached} != derived ${r.derived}`);

  const lastAfter = await db.query<{ code: string }>(`
    SELECT a.code FROM ledger_accounts a
      JOIN LATERAL (SELECT balance_after FROM ledger_postings WHERE account_id = a.id ORDER BY id DESC LIMIT 1) l ON TRUE
     WHERE l.balance_after <> a.balance`);
  for (const r of lastAfter.rows) problems.push(`account ${r.code} last running balance disagrees with cached balance`);

  const negative = await db.query<{ code: string }>(
    "SELECT code FROM ledger_accounts WHERE NOT allow_negative AND balance < 0",
  );
  for (const r of negative.rows) problems.push(`account ${r.code} is negative`);

  const principal = await db.query<{ user_id: string; asset: string; ledger: string; positions: string }>(`
    SELECT a.owner_user_id AS user_id, a.asset, a.balance::text AS ledger,
           COALESCE((SELECT sum(principal) FROM investments i
                      WHERE i.user_id = a.owner_user_id AND i.asset = a.asset AND i.status = 'active'), 0)::text AS positions
      FROM ledger_accounts a
     WHERE a.purpose = 'user_invested'
       AND a.balance <> COALESCE((SELECT sum(principal) FROM investments i
                                   WHERE i.user_id = a.owner_user_id AND i.asset = a.asset AND i.status = 'active'), 0)`);
  for (const r of principal.rows) {
    problems.push(`user ${r.user_id} invested ledger ${r.ledger} != active principal ${r.positions} (${r.asset})`);
  }

  // --- Strategy sub-ledgers -------------------------------------------------
  // Position cost basis in the ledger must equal the position table; position
  // quantity must equal net traded quantity; realised P&L and fees must equal
  // the sum over individual trades; each strategy sub-ledger must balance.
  const strat = await db.query<{
    code: string;
    ledger_cost: string;
    table_cost: string;
    table_qty: string;
    traded_qty: string;
    ledger_pnl: string;
    trade_pnl: string;
    ledger_fees: string;
    trade_fees: string;
    debit_side: string;
    credit_side: string;
    cursor: string;
    last_result: string | null;
  }>(`
    SELECT s.code,
           COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_position'), 0)::text AS ledger_cost,
           COALESCE((SELECT sum(cost_basis) FROM strategy_positions p WHERE p.strategy_id = s.id), 0)::text AS table_cost,
           COALESCE((SELECT sum(quantity) FROM strategy_positions p WHERE p.strategy_id = s.id), 0)::text AS table_qty,
           COALESCE((SELECT sum(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END) FROM strategy_trades t WHERE t.strategy_id = s.id), 0)::text AS traded_qty,
           (COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_realised_gain'), 0)
             - COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_realised_loss'), 0))::text AS ledger_pnl,
           COALESCE((SELECT sum(realised_pnl) FROM strategy_trades t WHERE t.strategy_id = s.id), 0)::text AS trade_pnl,
           COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_fees'), 0)::text AS ledger_fees,
           COALESCE((SELECT sum(fee) FROM strategy_trades t WHERE t.strategy_id = s.id), 0)::text AS trade_fees,
           COALESCE(sum(la.balance) FILTER (WHERE la.normal_balance = 'debit'), 0)::text AS debit_side,
           COALESCE(sum(la.balance) FILTER (WHERE la.normal_balance = 'credit'), 0)::text AS credit_side,
           s.last_tick_seq::text AS cursor,
           (SELECT max(tick_seq) FROM strategy_tick_results r WHERE r.strategy_id = s.id)::text AS last_result
      FROM strategies s
      LEFT JOIN ledger_accounts la ON la.owner_strategy_id = s.id AND la.purpose LIKE 'strategy\\_%'
     GROUP BY s.id`);
  for (const r of strat.rows) {
    const eq = (a: string, b: string) => new Money(a).eq(b);
    if (!eq(r.ledger_cost, r.table_cost)) problems.push(`strategy ${r.code}: ledger cost basis ${r.ledger_cost} != positions ${r.table_cost}`);
    if (!eq(r.table_qty, r.traded_qty)) problems.push(`strategy ${r.code}: position qty ${r.table_qty} != net traded ${r.traded_qty}`);
    if (!eq(r.ledger_pnl, r.trade_pnl)) problems.push(`strategy ${r.code}: ledger realised P&L ${r.ledger_pnl} != trades ${r.trade_pnl}`);
    if (!eq(r.ledger_fees, r.trade_fees)) problems.push(`strategy ${r.code}: ledger fees ${r.ledger_fees} != trades ${r.trade_fees}`);
    if (!eq(r.debit_side, r.credit_side)) problems.push(`strategy ${r.code}: sub-ledger does not balance (${r.debit_side} vs ${r.credit_side})`);
    if (r.last_result !== null && r.last_result !== r.cursor) problems.push(`strategy ${r.code}: cursor ${r.cursor} != last tick result ${r.last_result}`);
  }

  // Strategy sub-ledger postings must never be mixed with other accounts,
  // except in the two reward entry types, whose strategy half and customer
  // half must each balance on their own (docs/rewards-accounting.md section 4).
  const crossed = await db.query<{ entry_id: string; entry_type: string; strat_net: string; other_net: string }>(`
    SELECT p.entry_id, e.entry_type,
           sum(CASE WHEN a.purpose LIKE 'strategy\\_%' THEN (CASE WHEN p.direction = 'debit' THEN p.amount ELSE -p.amount END) ELSE 0 END)::text AS strat_net,
           sum(CASE WHEN a.purpose NOT LIKE 'strategy\\_%' THEN (CASE WHEN p.direction = 'debit' THEN p.amount ELSE -p.amount END) ELSE 0 END)::text AS other_net
      FROM ledger_postings p
      JOIN journal_entries e ON e.id = p.entry_id
      JOIN ledger_accounts a ON a.id = p.account_id
     GROUP BY p.entry_id, e.entry_type
    HAVING bool_or(a.purpose LIKE 'strategy\\_%') AND bool_or(a.purpose NOT LIKE 'strategy\\_%')`);
  for (const r of crossed.rows) {
    if (r.entry_type !== "reward_distribution" && r.entry_type !== "reward_reserve_release") {
      problems.push(`entry ${r.entry_id} (${r.entry_type}) mixes strategy and non-strategy accounts`);
    } else if (!new Money(r.strat_net).isZero() || !new Money(r.other_net).isZero()) {
      problems.push(`reward entry ${r.entry_id}: strategy half (${r.strat_net}) or customer half (${r.other_net}) is unbalanced`);
    }
  }

  problems.push(...(await rewardIntegrityProblems(db)));

  const tb = await db.query<{ asset: string; debit_total: string; credit_total: string }>(`
    SELECT asset,
           COALESCE(sum(balance) FILTER (WHERE normal_balance = 'debit'), 0)::text AS debit_total,
           COALESCE(sum(balance) FILTER (WHERE normal_balance = 'credit'), 0)::text AS credit_total
      FROM ledger_accounts GROUP BY asset ORDER BY asset`);
  const trialBalance = tb.rows.map((r) => ({
    asset: r.asset,
    debitNormalTotal: r.debit_total,
    creditNormalTotal: r.credit_total,
  }));
  for (const r of tb.rows) {
    // Compare numerically: an empty sum renders as "0", a zero NUMERIC(38,18) sum as "0.000…".
    if (!new Money(r.debit_total).eq(r.credit_total)) {
      problems.push(`trial balance for ${r.asset} does not balance: ${r.debit_total} vs ${r.credit_total}`);
    }
  }

  return { ok: problems.length === 0, checkedAt: new Date().toISOString(), problems, trialBalance };
}
