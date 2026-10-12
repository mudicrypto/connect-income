import type { Tx } from "../db/pool.js";
import { Money, type Money as MoneyT } from "../lib/money.js";
import type { Direction } from "./accounts.js";

export type EntryType =
  | "simulated_deposit"
  | "investment_open"
  | "investment_mature"
  | "strategy_capital_allocation"
  | "strategy_trade"
  | "reward_distribution"
  | "reward_reserve_release"
  | "reward_release";

export interface PostingInput {
  accountId: string;
  direction: Direction;
  amount: MoneyT;
}

export interface EntryInput {
  entryType: EntryType;
  /** Globally unique; replaying the same key never posts twice. */
  idempotencyKey: string;
  description: string;
  initiatedBy?: string | null;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  postings: PostingInput[];
}

export interface PostedEntry {
  entryId: string;
  /** false when an entry with this idempotency key already existed. */
  created: boolean;
}

export class LedgerError extends Error {}

/**
 * Post a balanced journal entry. Must be called inside a transaction.
 *
 * Validation happens here first (fast, clear errors) and is enforced again by
 * database triggers at COMMIT (defence in depth): balanced per asset, at least
 * two postings, positive amounts, append-only, no overdraft.
 */
export async function postEntry(tx: Tx, input: EntryInput): Promise<PostedEntry> {
  if (input.postings.length < 2) throw new LedgerError("an entry needs at least two postings");

  const accountIds = [...new Set(input.postings.map((p) => p.accountId))];
  const { rows: accounts } = await tx.query<{ id: string; asset: string }>(
    "SELECT id, asset FROM ledger_accounts WHERE id = ANY($1::uuid[])",
    [accountIds],
  );
  const assetOf = new Map(accounts.map((a) => [a.id, a.asset]));

  const net = new Map<string, MoneyT>();
  for (const p of input.postings) {
    const asset = assetOf.get(p.accountId);
    if (!asset) throw new LedgerError(`unknown ledger account ${p.accountId}`);
    if (!Money.isDecimal(p.amount) || !p.amount.isFinite() || p.amount.lte(0)) {
      throw new LedgerError("posting amounts must be positive decimals");
    }
    const signed = p.direction === "debit" ? p.amount : p.amount.neg();
    net.set(asset, (net.get(asset) ?? new Money(0)).plus(signed));
  }
  for (const [asset, total] of net) {
    if (!total.isZero()) throw new LedgerError(`entry is unbalanced for ${asset} by ${total.toString()}`);
  }

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries
       (entry_type, idempotency_key, description, initiated_by, reference_type, reference_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.entryType,
      input.idempotencyKey,
      input.description,
      input.initiatedBy ?? null,
      input.referenceType ?? null,
      input.referenceId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await tx.query<{ id: string }>("SELECT id FROM journal_entries WHERE idempotency_key = $1", [
      input.idempotencyKey,
    ]);
    return { entryId: existing.rows[0]!.id, created: false };
  }
  const entryId = inserted.rows[0].id;

  // Insert in account-id order so concurrent entries lock rows consistently.
  const ordered = [...input.postings].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  for (const p of ordered) {
    await tx.query(
      `INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after)
       VALUES ($1, $2, $3, $4, $5, 0)`,
      [entryId, p.accountId, assetOf.get(p.accountId), p.direction, p.amount.toFixed()],
    );
  }
  return { entryId, created: true };
}
