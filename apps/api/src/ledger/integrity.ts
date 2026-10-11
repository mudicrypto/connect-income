import type { Db, Tx } from "../db/pool.js";

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
    if (r.debit_total !== r.credit_total) {
      problems.push(`trial balance for ${r.asset} does not balance: ${r.debit_total} vs ${r.credit_total}`);
    }
  }

  return { ok: problems.length === 0, checkedAt: new Date().toISOString(), problems, trialBalance };
}
