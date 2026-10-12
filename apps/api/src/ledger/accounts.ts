import type { Tx } from "../db/pool.js";
import { notFound } from "../lib/errors.js";

export type AccountPurpose =
  | "user_available"
  | "user_invested"
  | "platform_sim_custody"
  | "strategy_capital"
  | "strategy_cash"
  | "strategy_position"
  | "strategy_realised_gain"
  | "strategy_realised_loss"
  | "strategy_fees";
export type Direction = "debit" | "credit";

type OwnerKind = "user" | "strategy" | "platform";

interface PurposeSpec {
  category: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalBalance: Direction;
  owner: OwnerKind;
  label: string;
}

/** Who owns an account: a user, a strategy, or (neither) the platform. */
export type AccountOwner = { userId: string } | { strategyId: string } | undefined;

/**
 * Chart of accounts. Each kind of money lives in its own account type so that
 * customer funds, invested principal and platform funds are never commingled.
 * Strategy accounts form a self-contained sub-ledger per strategy funded by
 * simulated paper capital, so strategy results never touch customer balances.
 * Future milestones add: reward liability, treasury, exchange liquidity —
 * each as a separate purpose (requires a migration).
 */
export const PURPOSES: Record<AccountPurpose, PurposeSpec> = {
  user_available: { category: "liability", normalBalance: "credit", owner: "user", label: "Available balance" },
  user_invested: { category: "liability", normalBalance: "credit", owner: "user", label: "Invested principal" },
  platform_sim_custody: { category: "asset", normalBalance: "debit", owner: "platform", label: "Simulated USDT custody" },
  strategy_capital: { category: "equity", normalBalance: "credit", owner: "strategy", label: "Simulated paper capital" },
  strategy_cash: { category: "asset", normalBalance: "debit", owner: "strategy", label: "Strategy simulated cash" },
  strategy_position: { category: "asset", normalBalance: "debit", owner: "strategy", label: "Strategy position cost basis" },
  strategy_realised_gain: { category: "revenue", normalBalance: "credit", owner: "strategy", label: "Realised simulated gains" },
  strategy_realised_loss: { category: "expense", normalBalance: "debit", owner: "strategy", label: "Realised simulated losses" },
  strategy_fees: { category: "expense", normalBalance: "debit", owner: "strategy", label: "Simulated trading fees" },
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

function ownerKind(owner: AccountOwner): OwnerKind {
  if (!owner) return "platform";
  return "userId" in owner ? "user" : "strategy";
}

function accountCode(purpose: AccountPurpose, asset: string, owner: AccountOwner): string {
  if (!owner) return `platform:${purpose}:${asset}`;
  return "userId" in owner ? `user:${owner.userId}:${purpose}:${asset}` : `strategy:${owner.strategyId}:${purpose}:${asset}`;
}

/**
 * Get-or-create a ledger account. Safe under concurrency. `owner` may be a
 * user id string (backwards compatible), an owner object, or omitted for a
 * platform account.
 */
export async function ensureAccount(
  tx: Tx,
  purpose: AccountPurpose,
  asset: string,
  ownerOrUserId?: AccountOwner | string,
): Promise<string> {
  const owner: AccountOwner = typeof ownerOrUserId === "string" ? { userId: ownerOrUserId } : ownerOrUserId;
  const spec = PURPOSES[purpose];
  if (spec.owner !== ownerKind(owner)) {
    throw new Error(`account purpose ${purpose} must be owned by: ${spec.owner}`);
  }
  const code = accountCode(purpose, asset, owner);
  await tx.query(
    `INSERT INTO ledger_accounts (code, name, category, normal_balance, purpose, asset, owner_user_id, owner_strategy_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (code) DO NOTHING`,
    [
      code,
      `${spec.label} (${asset})`,
      spec.category,
      spec.normalBalance,
      purpose,
      asset,
      owner && "userId" in owner ? owner.userId : null,
      owner && "strategyId" in owner ? owner.strategyId : null,
    ],
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

export interface StrategyAccounts {
  capital: string;
  cash: string;
  position: string;
  gain: string;
  loss: string;
  fees: string;
}

export async function ensureStrategyAccounts(tx: Tx, strategyId: string, asset: string): Promise<StrategyAccounts> {
  const owner = { strategyId };
  return {
    capital: await ensureAccount(tx, "strategy_capital", asset, owner),
    cash: await ensureAccount(tx, "strategy_cash", asset, owner),
    position: await ensureAccount(tx, "strategy_position", asset, owner),
    gain: await ensureAccount(tx, "strategy_realised_gain", asset, owner),
    loss: await ensureAccount(tx, "strategy_realised_loss", asset, owner),
    fees: await ensureAccount(tx, "strategy_fees", asset, owner),
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
