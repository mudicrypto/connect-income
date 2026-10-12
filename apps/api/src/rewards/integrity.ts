import type { Db, Tx } from "../db/pool.js";
import { Money } from "../lib/money.js";

/** Reward invariants (docs/rewards-accounting.md section 6). */
export async function rewardIntegrityProblems(db: Db | Tx): Promise<string[]> {
  const problems: string[] = [];

  const pending = await db.query<{ user_id: string; ledger: string; lines: string }>(`
    SELECT a.owner_user_id AS user_id, a.balance::text AS ledger,
           COALESCE((SELECT sum(l.reward) FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
                      WHERE l.user_id = a.owner_user_id AND r.status = 'posted' AND l.released_entry_id IS NULL), 0)::text AS lines
      FROM ledger_accounts a WHERE a.purpose = 'user_reward_pending'
     GROUP BY a.id
    HAVING a.balance <> COALESCE((SELECT sum(l.reward) FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
                      WHERE l.user_id = a.owner_user_id AND r.status = 'posted' AND l.released_entry_id IS NULL), 0)`);
  for (const r of pending.rows) problems.push(`user ${r.user_id}: pending rewards ledger ${r.ledger} != unreleased lines ${r.lines}`);

  const unbacked = await db.query<{ id: string }>(`
    SELECT l.id::text FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
     WHERE l.released_entry_id IS NOT NULL AND r.status <> 'posted'`);
  for (const r of unbacked.rows) problems.push(`reward line ${r.id} released from a run that is not posted`);

  const reserveBad = await db.query<{ pool: string }>(`
    SELECT rp.strategy_id AS pool FROM reward_pools rp
     WHERE COALESCE((SELECT sum(balance) FROM ledger_accounts WHERE owner_strategy_id = rp.strategy_id AND purpose = 'pool_reserve'), 0)
        <> COALESCE((SELECT sum(reserve_contribution - reserve_applied) FROM reward_runs WHERE pool_strategy_id = rp.strategy_id AND status = 'posted'), 0)
         - COALESCE((SELECT sum(reserve_released) FROM reserve_settlements s WHERE s.pool_strategy_id = rp.strategy_id), 0)`);
  for (const r of reserveBad.rows) problems.push(`pool ${r.pool}: reserve ledger does not match posted runs minus settlements`);

  // v2 (rewards-accounting-v2.md §4): the pool reserve is exactly the reserves owned by unsettled
  // investments (their latest posted v2 line) plus any legacy pool_v1 reserve.
  const ownedBad = await db.query<{ pool: string; ledger: string; owned: string }>(`
    SELECT rp.strategy_id AS pool,
           COALESCE((SELECT sum(balance) FROM ledger_accounts WHERE owner_strategy_id = rp.strategy_id AND purpose = 'pool_reserve'), 0)::text AS ledger,
           (COALESCE((SELECT sum(last.reserve_close) FROM pool_allocations pa
                       JOIN LATERAL (SELECT l.reserve_close FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
                                      WHERE l.allocation_id = pa.id AND r.status = 'posted' AND r.loss_model = 'investment_v2'
                                      ORDER BY r.period_end DESC LIMIT 1) last ON TRUE
                      WHERE pa.pool_strategy_id = rp.strategy_id
                        AND NOT EXISTS (SELECT 1 FROM reserve_settlements s WHERE s.allocation_id = pa.id)), 0)
            + COALESCE((SELECT sum(reserve_contribution - reserve_applied) FROM reward_runs
                         WHERE pool_strategy_id = rp.strategy_id AND status = 'posted' AND loss_model = 'pool_v1'), 0))::text AS owned
      FROM reward_pools rp`);
  for (const r of ownedBad.rows) {
    if (!new Money(r.ledger).eq(r.owned)) problems.push(`pool ${r.pool}: reserve ledger ${r.ledger} != owned reserves + legacy ${r.owned}`);
  }

  // v2 per-investment balances must chain: each posted line opens where the previous posted line closed.
  const chain = await db.query<{ id: string }>(`
    SELECT x.id::text FROM (
      SELECT l.id, l.loss_open, l.reserve_open,
             LAG(l.loss_close) OVER w AS prev_loss, LAG(l.reserve_close) OVER w AS prev_reserve
        FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
       WHERE r.status = 'posted' AND r.loss_model = 'investment_v2'
      WINDOW w AS (PARTITION BY l.allocation_id ORDER BY r.period_end)) x
     WHERE x.loss_open <> COALESCE(x.prev_loss, 0) OR x.reserve_open <> COALESCE(x.prev_reserve, 0)`);
  for (const r of chain.rows) problems.push(`v2 reward line ${r.id}: opening balances do not continue the previous posted period`);

  // Settlement records the allocation's final memo balances, and nothing is posted for it afterwards.
  const settleBad = await db.query<{ id: string }>(`
    SELECT s.id::text FROM reserve_settlements s
      LEFT JOIN LATERAL (SELECT l.reserve_close, l.loss_close FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
                          WHERE l.allocation_id = s.allocation_id AND r.status = 'posted' AND r.loss_model = 'investment_v2'
                          ORDER BY r.period_end DESC LIMIT 1) last ON TRUE
     WHERE s.reserve_released <> COALESCE(last.reserve_close, 0) OR s.loss_expired <> COALESCE(last.loss_close, 0)
        OR EXISTS (SELECT 1 FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
                    WHERE l.allocation_id = s.allocation_id AND r.status = 'posted' AND r.posted_at > s.created_at)`);
  for (const r of settleBad.rows) problems.push(`reserve settlement ${r.id} does not match the allocation's final balances`);

  const distBad = await db.query<{ code: string }>(`
    SELECT s.code FROM strategies s
     WHERE COALESCE((SELECT sum(balance) FROM ledger_accounts WHERE owner_strategy_id = s.id AND purpose = 'strategy_distributions'), 0)
        <> COALESCE((SELECT sum(eligible_profit - reserve_applied) FROM reward_runs WHERE pool_strategy_id = s.id AND status = 'posted'), 0)`);
  for (const r of distBad.rows) problems.push(`strategy ${r.code}: distributions ledger does not match posted runs`);

  const linesBad = await db.query<{ id: string }>(`
    SELECT r.id FROM reward_runs r
     WHERE r.total_rewards <> COALESCE((SELECT sum(reward) FROM reward_run_lines l WHERE l.run_id = r.id), 0)`);
  for (const r of linesBad.rows) problems.push(`reward run ${r.id}: lines do not sum to total_rewards`);

  const sourcesBad = await db.query<{ id: string }>(`
    SELECT r.id FROM reward_runs r
     WHERE r.status = 'posted' AND r.source_trade_count <> (SELECT count(*) FROM reward_run_sources s WHERE s.run_id = r.id)`);
  for (const r of sourcesBad.rows) problems.push(`reward run ${r.id}: recorded sources differ from source_trade_count`);

  // D2: a posted reward must not stay pending on an investment that already matured.
  const stranded = await db.query<{ id: string }>(`
    SELECT DISTINCT l.investment_id AS id FROM reward_run_lines l
      JOIN reward_runs r ON r.id = l.run_id JOIN investments i ON i.id = l.investment_id
     WHERE r.status = 'posted' AND l.reward > 0 AND l.released_entry_id IS NULL AND i.status = 'matured'`);
  for (const r of stranded.rows) problems.push(`matured investment ${r.id} still has unreleased posted rewards`);

  // D3: every realised trade of a pool dated inside a posted period must belong to a posted run.
  const orphans = await db.query<{ id: string }>(`
    SELECT t.id FROM strategy_trades t
      JOIN journal_entries e ON e.id = t.entry_id
      JOIN reward_pools rp ON rp.strategy_id = t.strategy_id
     WHERE e.created_at >= rp.rewards_start_at
       AND e.created_at < (SELECT max(period_end) FROM reward_runs r WHERE r.pool_strategy_id = rp.strategy_id AND r.status = 'posted')
       AND NOT EXISTS (SELECT 1 FROM reward_run_sources s WHERE s.trade_id = t.id)`);
  for (const r of orphans.rows) problems.push(`trade ${r.id} is dated inside a posted reward period but excluded from it`);

  // Customer-side solvency: simulated custody exactly backs every customer liability
  // (available, invested, pending rewards) plus the pool reserves.
  const solvency = await db.query<{ asset: string; custody: string; liabilities: string }>(`
    SELECT asset,
           COALESCE(sum(balance) FILTER (WHERE purpose = 'platform_sim_custody'), 0)::text AS custody,
           COALESCE(sum(balance) FILTER (WHERE purpose IN ('user_available', 'user_invested', 'user_reward_pending', 'pool_reserve')), 0)::text AS liabilities
      FROM ledger_accounts GROUP BY asset
    HAVING COALESCE(sum(balance) FILTER (WHERE purpose = 'platform_sim_custody'), 0)
        <> COALESCE(sum(balance) FILTER (WHERE purpose IN ('user_available', 'user_invested', 'user_reward_pending', 'pool_reserve')), 0)`);
  for (const r of solvency.rows) problems.push(`${r.asset}: custody ${r.custody} does not equal customer liabilities + reserves ${r.liabilities}`);

  return problems;
}
