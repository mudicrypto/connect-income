import { randomUUID } from "node:crypto";
import { withTransaction, type Db } from "../db/pool.js";
import { badRequest, notFound, unprocessable } from "../lib/errors.js";
import { format, fromDb, parseAmount } from "../lib/money.js";
import { ensureUserAccounts, getAsset, lockAccounts } from "../ledger/accounts.js";
import { postEntry } from "../ledger/ledger.js";
import { audit } from "./audit.js";
import { runIdempotent } from "./idempotency.js";
import { allocateInvestmentToPool, productPools } from "../rewards/pools.js";
import { releaseInvestmentRewards } from "../rewards/runs.js";

export interface ProductView {
  id: string;
  code: string;
  name: string;
  description: string;
  asset: string;
  termMinutes: number;
  minAmount: string;
  maxAmount: string | null;
  strategyDescription: string;
  riskDisclosure: string;
  devOnly: boolean;
  status: string;
  /** Simulated strategy pool backing variable rewards, if any. */
  pool: { poolId: string; poolCode: string; poolName: string; accepting: boolean } | null;
}

interface ProductRow {
  id: string;
  code: string;
  name: string;
  description: string;
  asset: string;
  term_minutes: number;
  min_amount: string;
  max_amount: string | null;
  strategy_description: string;
  risk_disclosure: string;
  dev_only: boolean;
  status: string;
  scale: number;
}

const PRODUCT_COLUMNS = `p.id, p.code, p.name, p.description, p.asset, p.term_minutes, p.min_amount::text,
  p.max_amount::text, p.strategy_description, p.risk_disclosure, p.dev_only, p.status, a.scale`;

function toProductView(r: ProductRow): ProductView {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    asset: r.asset,
    termMinutes: r.term_minutes,
    minAmount: format(r.min_amount, r.scale),
    maxAmount: r.max_amount === null ? null : format(r.max_amount, r.scale),
    strategyDescription: r.strategy_description,
    riskDisclosure: r.risk_disclosure,
    devOnly: r.dev_only,
    status: r.status,
    pool: null,
  };
}

export async function listProducts(db: Db, opts: { includeDevOnly: boolean }): Promise<ProductView[]> {
  const { rows } = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM investment_products p JOIN assets a ON a.code = p.asset
      WHERE p.status = 'active' AND ($1 OR NOT p.dev_only)
      ORDER BY p.term_minutes, p.code`,
    [opts.includeDevOnly],
  );
  const pools = await productPools(db);
  return rows.map((r) => ({ ...toProductView(r), pool: pools.get(r.id) ?? null }));
}

export interface InvestmentView {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  asset: string;
  principal: string;
  status: "active" | "matured";
  startAt: string;
  maturityAt: string;
  settledAt: string | null;
  openEntryId: string;
  settleEntryId: string | null;
  /** Simulated pool participation and variable rewards (null if the product has no pool). */
  pool: { code: string; name: string } | null;
  rewardsPending: string;
  rewardsReleased: string;
}

const INVESTMENT_SELECT = `
  SELECT i.id, i.product_id, p.code AS product_code, p.name AS product_name, i.asset, i.principal::text,
         i.status, i.start_at, i.maturity_at, i.settled_at, i.open_entry_id, i.settle_entry_id, a.scale,
         ps.code AS pool_code, ps.name AS pool_name,
         COALESCE((SELECT sum(l.reward) FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
                    WHERE l.investment_id = i.id AND r.status = 'posted' AND l.released_entry_id IS NULL), 0)::text AS rewards_pending,
         COALESCE((SELECT sum(l.reward) FROM reward_run_lines l
                    WHERE l.investment_id = i.id AND l.released_entry_id IS NOT NULL), 0)::text AS rewards_released
    FROM investments i
    LEFT JOIN pool_allocations pa ON pa.investment_id = i.id
    LEFT JOIN strategies ps ON ps.id = pa.pool_strategy_id
    JOIN investment_products p ON p.id = i.product_id
    JOIN assets a ON a.code = i.asset`;

interface InvestmentRow {
  id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  asset: string;
  principal: string;
  status: "active" | "matured";
  start_at: Date;
  maturity_at: Date;
  settled_at: Date | null;
  open_entry_id: string;
  settle_entry_id: string | null;
  scale: number;
  pool_code: string | null;
  pool_name: string | null;
  rewards_pending: string;
  rewards_released: string;
}

function toInvestmentView(r: InvestmentRow): InvestmentView {
  return {
    id: r.id,
    productId: r.product_id,
    productCode: r.product_code,
    productName: r.product_name,
    asset: r.asset,
    principal: format(r.principal, r.scale),
    status: r.status,
    startAt: r.start_at.toISOString(),
    maturityAt: r.maturity_at.toISOString(),
    settledAt: r.settled_at?.toISOString() ?? null,
    openEntryId: r.open_entry_id,
    settleEntryId: r.settle_entry_id,
    pool: r.pool_code ? { code: r.pool_code, name: r.pool_name! } : null,
    rewardsPending: format(r.rewards_pending, r.scale),
    rewardsReleased: format(r.rewards_released, r.scale),
  };
}

export async function listInvestments(db: Db, userId: string): Promise<InvestmentView[]> {
  const { rows } = await db.query<InvestmentRow>(`${INVESTMENT_SELECT} WHERE i.user_id = $1 ORDER BY i.created_at DESC`, [
    userId,
  ]);
  return rows.map(toInvestmentView);
}

/**
 * Open a fixed-term investment by moving principal from the user's available
 * balance into their invested-principal account.
 *   Dr user_available   (liability to user decreases)
 *   Cr user_invested    (liability to user for locked principal increases)
 * No return rate is promised or recorded here.
 */
export async function createInvestment(
  db: Db,
  input: {
    userId: string;
    productId: unknown;
    amount: unknown;
    idempotencyKey: string;
    allowDevOnly: boolean;
    ip?: string | null;
  },
) {
  if (typeof input.productId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.productId)) {
    throw badRequest("invalid_product", "productId must be a UUID");
  }
  const productId = input.productId;

  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM investment_products p JOIN assets a ON a.code = p.asset
        WHERE p.id = $1 FOR SHARE OF p`,
      [productId],
    );
    const product = rows[0];
    if (!product || (product.dev_only && !input.allowDevOnly)) throw notFound("Investment product not found");
    const asset = await getAsset(tx, product.asset);
    const amount = parseAmount(input.amount, asset.scale);

    return runIdempotent<InvestmentView>(
      tx,
      {
        userId: input.userId,
        key: input.idempotencyKey,
        operation: "investment_create",
        request: { productId, amount: amount.toFixed() },
      },
      async () => {
        if (product.status !== "active") {
          throw unprocessable("product_unavailable", "This product is not accepting new investments");
        }
        if (amount.lt(fromDb(product.min_amount))) {
          throw unprocessable("below_minimum", `Minimum investment is ${format(product.min_amount, asset.scale)} ${asset.code}`);
        }
        if (product.max_amount !== null && amount.gt(fromDb(product.max_amount))) {
          throw unprocessable("above_maximum", `Maximum investment is ${format(product.max_amount, asset.scale)} ${asset.code}`);
        }

        const accounts = await ensureUserAccounts(tx, input.userId, asset.code);
        const balances = await lockAccounts(tx, [accounts.available, accounts.invested]);
        const available = fromDb(balances.get(accounts.available));
        if (available.lt(amount)) {
          throw unprocessable(
            "insufficient_funds",
            `Insufficient available balance: ${format(available, asset.scale)} ${asset.code}`,
          );
        }

        const investmentId = randomUUID();
        const { entryId } = await postEntry(tx, {
          entryType: "investment_open",
          idempotencyKey: `investment:${investmentId}:open`,
          description: `Investment in ${product.name}`,
          initiatedBy: input.userId,
          referenceType: "investment",
          referenceId: investmentId,
          metadata: { productCode: product.code },
          postings: [
            { accountId: accounts.available, direction: "debit", amount },
            { accountId: accounts.invested, direction: "credit", amount },
          ],
        });

        // Dates come from the database clock (transaction start) so they are
        // consistent with ledger timestamps.
        await tx.query(
          `INSERT INTO investments (id, user_id, product_id, asset, principal, start_at, maturity_at, open_entry_id)
           VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(mins => $6), $7)`,
          [investmentId, input.userId, product.id, asset.code, amount.toFixed(), product.term_minutes, entryId],
        );
        // Simulated pool participation (if the product is assigned to a pool);
        // enforces pool status/capacity and rolls everything back on failure.
        await allocateInvestmentToPool(tx, {
          investmentId,
          userId: input.userId,
          productId: product.id,
          principal: amount,
          ip: input.ip,
        });
        const created = await tx.query<InvestmentRow>(`${INVESTMENT_SELECT} WHERE i.id = $1`, [investmentId]);
        const view = toInvestmentView(created.rows[0]!);

        await audit(tx, {
          actorUserId: input.userId,
          action: "investment.create",
          targetType: "investment",
          targetId: investmentId,
          details: { productCode: product.code, amount: amount.toFixed(), maturityAt: view.maturityAt },
          ip: input.ip,
        });
        return { statusCode: 201, body: view };
      },
    );
  });
}

/**
 * Settle every active investment whose maturity date has passed: principal
 * returns to the user's available balance.
 *   Dr user_invested
 *   Cr user_available
 * Rewards are never created here: only rewards already calculated from
 * realised pool profit and posted by a reward run are released.
 *
 * Each investment settles in its own transaction and is idempotent
 * (journal key `investment:<id>:mature`), so the sweep can run concurrently
 * or repeatedly without double-paying.
 */
export async function settleMaturedInvestments(
  db: Db,
  opts: { asOf?: Date; limit?: number; actorUserId?: string | null } = {},
): Promise<{ settled: string[] }> {
  const asOf = opts.asOf ?? new Date();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM investments WHERE status = 'active' AND maturity_at <= $1 ORDER BY maturity_at LIMIT $2`,
    [asOf, opts.limit ?? 500],
  );
  const settled: string[] = [];
  for (const { id } of rows) {
    const done = await withTransaction(db, async (tx) => {
      const locked = await tx.query<{ user_id: string; asset: string; principal: string }>(
        `SELECT user_id, asset, principal::text FROM investments
          WHERE id = $1 AND status = 'active' AND maturity_at <= $2 FOR UPDATE SKIP LOCKED`,
        [id, asOf],
      );
      const inv = locked.rows[0];
      if (!inv) return false; // already settled or being settled by another worker
      const accounts = await ensureUserAccounts(tx, inv.user_id, inv.asset);
      const amount = fromDb(inv.principal);
      const { entryId } = await postEntry(tx, {
        entryType: "investment_mature",
        idempotencyKey: `investment:${id}:mature`,
        description: "Investment matured: principal returned",
        initiatedBy: opts.actorUserId ?? null,
        referenceType: "investment",
        referenceId: id,
        metadata: { reward: "0", note: "Strategy-derived rewards not yet implemented" },
        postings: [
          { accountId: accounts.invested, direction: "debit", amount },
          { accountId: accounts.available, direction: "credit", amount },
        ],
      });
      await tx.query(
        `UPDATE investments SET status = 'matured', settle_entry_id = $2, settled_at = now() WHERE id = $1`,
        [id, entryId],
      );
      // Rewards already posted for this investment become available now.
      const releasedLines = await releaseInvestmentRewards(tx, id, opts.actorUserId ?? null);
      await audit(tx, {
        actorUserId: opts.actorUserId ?? null,
        action: "investment.mature",
        targetType: "investment",
        targetId: id,
        details: { principal: inv.principal, releasedRewardLines: releasedLines },
      });
      return true;
    });
    if (done) settled.push(id);
  }

  // Defence in depth: release any posted reward still pending on an investment
  // that has already matured (should never exist; checked by the integrity checker).
  const stranded = await db.query<{ id: string }>(
    `SELECT DISTINCT l.investment_id AS id FROM reward_run_lines l
       JOIN reward_runs r ON r.id = l.run_id JOIN investments i ON i.id = l.investment_id
      WHERE r.status = 'posted' AND l.reward > 0 AND l.released_entry_id IS NULL AND i.status = 'matured'
      LIMIT $1`,
    [opts.limit ?? 500],
  );
  for (const { id } of stranded.rows) {
    await withTransaction(db, async (tx) => {
      await tx.query("SELECT 1 FROM investments WHERE id = $1 FOR UPDATE", [id]);
      await releaseInvestmentRewards(tx, id, opts.actorUserId ?? null);
    });
  }
  return { settled };
}
