import type { Db } from "../db/pool.js";
import { format } from "../lib/money.js";

export interface TransactionView {
  postingId: string;
  entryId: string;
  entryType: string;
  description: string;
  account: "available" | "invested" | "reward_pending";
  asset: string;
  /** Signed change from the user's point of view: positive = balance increased. */
  amount: string;
  balanceAfter: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

/**
 * The user's statement: every posting on any of their ledger accounts, newest
 * first. Cursor-paginated by posting id (stable, append-only ordering).
 */
export async function listTransactions(
  db: Db,
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<{ items: TransactionView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before && /^\d+$/.test(opts.before) ? opts.before : null;
  const { rows } = await db.query<{
    id: string;
    entry_id: string;
    entry_type: string;
    description: string;
    purpose: string;
    asset: string;
    direction: string;
    normal_balance: string;
    amount: string;
    balance_after: string;
    reference_type: string | null;
    reference_id: string | null;
    created_at: Date;
    scale: number;
  }>(
    `SELECT p.id::text, p.entry_id, e.entry_type, e.description, a.purpose, p.asset, p.direction,
            a.normal_balance, p.amount::text, p.balance_after::text, e.reference_type, e.reference_id,
            p.created_at, s.scale
       FROM ledger_postings p
       JOIN ledger_accounts a ON a.id = p.account_id
       JOIN journal_entries e ON e.id = p.entry_id
       JOIN assets s ON s.code = p.asset
      WHERE a.owner_user_id = $1 AND ($2::bigint IS NULL OR p.id < $2::bigint)
      ORDER BY p.id DESC
      LIMIT $3`,
    [userId, before, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      postingId: r.id,
      entryId: r.entry_id,
      entryType: r.entry_type,
      description: r.description,
      account: r.purpose === "user_invested" ? "invested" : r.purpose === "user_reward_pending" ? "reward_pending" : "available",
      asset: r.asset,
      amount: (r.direction === r.normal_balance ? "" : "-") + format(r.amount, r.scale),
      balanceAfter: format(r.balance_after, r.scale),
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      createdAt: r.created_at.toISOString(),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
