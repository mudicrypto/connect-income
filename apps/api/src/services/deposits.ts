import { withTransaction, type Db } from "../db/pool.js";
import { badRequest } from "../lib/errors.js";
import { format, Money, parseAmount } from "../lib/money.js";
import { ensureAccount, ensureUserAccounts, getAsset } from "../ledger/accounts.js";
import { postEntry } from "../ledger/ledger.js";
import { audit } from "./audit.js";
import { runIdempotent } from "./idempotency.js";

/** Upper bound per simulated deposit, to keep demo data sane. */
export const MAX_SIMULATED_DEPOSIT = new Money("1000000");

export interface DepositResult {
  entryId: string;
  asset: string;
  amount: string;
  availableBalance: string;
}

/**
 * Credit simulated (not real) USDT to a user.
 *   Dr platform_sim_custody   (platform asset: simulated USDT received)
 *   Cr user_available         (platform liability: owed to the user)
 */
export async function simulatedDeposit(
  db: Db,
  input: { userId: string; amount: unknown; idempotencyKey: string; ip?: string | null },
) {
  const assetCode = "USDT";
  return withTransaction(db, async (tx) => {
    const asset = await getAsset(tx, assetCode);
    const amount = parseAmount(input.amount, asset.scale);
    if (amount.gt(MAX_SIMULATED_DEPOSIT)) {
      throw badRequest("amount_too_large", `Simulated deposits are limited to ${MAX_SIMULATED_DEPOSIT.toFixed()} ${assetCode}`);
    }
    return runIdempotent<DepositResult>(
      tx,
      {
        userId: input.userId,
        key: input.idempotencyKey,
        operation: "simulated_deposit",
        request: { asset: assetCode, amount: amount.toFixed() },
      },
      async () => {
        const user = await ensureUserAccounts(tx, input.userId, assetCode);
        const custody = await ensureAccount(tx, "platform_sim_custody", assetCode);
        const { entryId } = await postEntry(tx, {
          entryType: "simulated_deposit",
          idempotencyKey: `simulated_deposit:${input.userId}:${input.idempotencyKey}`,
          description: `Simulated ${assetCode} deposit`,
          initiatedBy: input.userId,
          metadata: { simulated: true },
          postings: [
            { accountId: custody, direction: "debit", amount },
            { accountId: user.available, direction: "credit", amount },
          ],
        });
        const { rows } = await tx.query<{ balance: string }>("SELECT balance::text FROM ledger_accounts WHERE id = $1", [
          user.available,
        ]);
        await audit(tx, {
          actorUserId: input.userId,
          action: "deposit.simulated",
          targetType: "journal_entry",
          targetId: entryId,
          details: { asset: assetCode, amount: amount.toFixed() },
          ip: input.ip,
        });
        return {
          statusCode: 201,
          body: {
            entryId,
            asset: assetCode,
            amount: format(amount, asset.scale),
            availableBalance: format(rows[0]!.balance, asset.scale),
          },
        };
      },
    );
  });
}
