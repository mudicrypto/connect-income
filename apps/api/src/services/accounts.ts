import type { Db } from "../db/pool.js";
import { format, fromDb } from "../lib/money.js";

export interface BalanceView {
  asset: string;
  available: string;
  invested: string;
  /** Simulated rewards posted for the user's investments, released at maturity. */
  rewardPending: string;
  total: string;
}

export async function getUserBalances(db: Db, userId: string): Promise<BalanceView[]> {
  const { rows } = await db.query<{ asset: string; scale: number; available: string; invested: string; reward_pending: string }>(
    `SELECT a.code AS asset, a.scale,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'user_available'), 0)::text AS available,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'user_invested'), 0)::text AS invested,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'user_reward_pending'), 0)::text AS reward_pending
       FROM assets a
       LEFT JOIN ledger_accounts la ON la.asset = a.code AND la.owner_user_id = $1
      GROUP BY a.code, a.scale ORDER BY a.code`,
    [userId],
  );
  return rows.map((r) => ({
    asset: r.asset,
    available: format(r.available, r.scale),
    invested: format(r.invested, r.scale),
    rewardPending: format(r.reward_pending, r.scale),
    total: format(fromDb(r.available).plus(fromDb(r.invested)).plus(fromDb(r.reward_pending)), r.scale),
  }));
}
