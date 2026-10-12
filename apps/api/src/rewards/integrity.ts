import type { Db, Tx } from "../db/pool.js";

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
        <> COALESCE((SELECT sum(reserve_contribution - reserve_applied) FROM reward_runs WHERE pool_strategy_id = rp.strategy_id AND status = 'posted'), 0)`);
  for (const r of reserveBad.rows) problems.push(`pool ${r.pool}: reserve ledger does not match posted runs`);

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
