import type { Tx } from "../db/pool.js";
import { notFound } from "../lib/errors.js";

export type AccountPurpose = "user_available" | "user_invested" | "platform_sim_custody";
export type Direction = "debit" | "credit";

interface PurposeSpec {
  category: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalBalance: Direction;
  userOwned: boolean;
  label: string;
}

/**
 * Chart of accounts. Each kind of money lives in its own account type so that
 * customer funds, invested principal and platform funds are never commingled.
 * Future milestones add: strategy P&L, reward liability, treasury, exchange
 * liquidity — each as a separate purpose (requires a migration).
 */
export const PURPOSES: Record<AccountPurpose, PurposeSpec> = {
  user_available: { category: "liability", normalBalance: "credit", userOwned: true, label: "Available balance" },
  user_invested: { category: "liability", normalBalance: "credit", userOwned: true, label: "Invested principal" },
  platform_sim_custody: {
    category: "asset",
    normalBalance: "debit",
    userOwned: false,
    label: "Simulated USDT custody",
  },
};

export interface AssetInfo {
  code: string;
  name: string;
  scale: number;
}

export async function getAsset(tx: Tx, code: string): Promise<AssetInfo> {
  const { rows } = await tx.query<AssetInfo>("SELECT code, name, scale FROM assets WHERE code = $1", [code]);
  if (!rows[0]) throw notFound(`Unknown asset ${code}`);
  return rows[0];
}

function accountCode(purpose: AccountPurpose, asset: string, userId?: string): string {
  return userId ? `user:${userId}:${purpose}:${asset}` : `platform:${purpose}:${asset}`;
}

/** Get-or-create a ledger account. Safe under concurrency. */
export async function ensureAccount(tx: Tx, purpose: AccountPurpose, asset: string, userId?: string): Promise<string> {
  const spec = PURPOSES[purpose];
  if (spec.userOwned !== Boolean(userId)) {
    throw new Error(`account purpose ${purpose} ${spec.userOwned ? "requires" : "must not have"} an owner`);
  }
  const code = accountCode(purpose, asset, userId);
  await tx.query(
    `INSERT INTO ledger_accounts (code, name, category, normal_balance, purpose, asset, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (code) DO NOTHING`,
    [code, `${spec.label} (${asset})`, spec.category, spec.normalBalance, purpose, asset, userId ?? null],
  );
  const { rows } = await tx.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE code = $1", [code]);
  return rows[0]!.id;
}

export async function ensureUserAccounts(tx: Tx, userId: string, asset: string) {
  return {
    available: await ensureAccount(tx, "user_available", asset, userId),
    invested: await ensureAccount(tx, "user_invested", asset, userId),
  };
}

/** Lock accounts in a deterministic order (by id) to avoid deadlocks; returns balances. */
export async function lockAccounts(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const { rows } = await tx.query<{ id: string; balance: string }>(
    "SELECT id, balance::text FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.balance]));
}
