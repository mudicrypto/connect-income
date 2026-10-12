import { z } from "zod";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { format, fromDb, Money } from "../lib/money.js";
import { ensureAccount, ensureStrategyAccounts } from "../ledger/accounts.js";
import { audit } from "../services/audit.js";

/**
 * Customer reward pools (SIMULATED). A pool is a milestone-2 strategy that
 * customer investments participate in via allocation records. Customer
 * principal never moves into the pool: see docs/rewards-accounting.md.
 */

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, "must be a UUID");
const amount = z.string().regex(/^\d{1,20}(\.\d{1,6})?$/, "must be a decimal string");

export async function registerPool(db: Db, actorUserId: string, raw: unknown, ip?: string | null) {
  const input = z.object({ strategyId: uuid, customerCapacity: amount }).strict().parse(raw);
  if (new Money(input.customerCapacity).lte(0)) throw unprocessable("invalid_capacity", "customerCapacity must be > 0");
  return withTransaction(db, async (tx) => {
    const s = await tx.query<{ id: string; quote_asset: string }>(
      `SELECT s.id, i.quote_asset FROM strategies s JOIN market_instruments i ON i.id = s.instrument_id WHERE s.id = $1`,
      [input.strategyId],
    );
    if (!s.rows[0]) throw notFound("Strategy not found");
    const res = await tx.query(
      `INSERT INTO reward_pools (strategy_id, customer_capacity, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (strategy_id) DO NOTHING RETURNING strategy_id`,
      [input.strategyId, input.customerCapacity, actorUserId],
    );
    if (!res.rowCount) throw conflict("pool_exists", "This strategy is already a reward pool");
    await ensureStrategyAccounts(tx, input.strategyId, s.rows[0].quote_asset);
    await ensureAccount(tx, "pool_reserve", s.rows[0].quote_asset, { strategyId: input.strategyId });
    await audit(tx, {
      actorUserId,
      action: "pool.register",
      targetType: "strategy",
      targetId: input.strategyId,
      details: { customerCapacity: input.customerCapacity },
      ip,
    });
  });
}

export async function updatePool(db: Db, actorUserId: string, poolId: string, raw: unknown, ip?: string | null) {
  const input = z
    .object({ customerCapacity: amount.optional(), status: z.enum(["active", "closed"]).optional() })
    .strict()
    .parse(raw);
  if (input.customerCapacity !== undefined && new Money(input.customerCapacity).lte(0)) {
    throw unprocessable("invalid_capacity", "customerCapacity must be > 0");
  }
  return withTransaction(db, async (tx) => {
    const before = await tx.query("SELECT customer_capacity::text, status FROM reward_pools WHERE strategy_id = $1 FOR UPDATE", [poolId]);
    if (!before.rows[0]) throw notFound("Pool not found");
    await tx.query(
      `UPDATE reward_pools SET customer_capacity = COALESCE($2, customer_capacity), status = COALESCE($3, status)
        WHERE strategy_id = $1`,
      [poolId, input.customerCapacity ?? null, input.status ?? null],
    );
    await audit(tx, { actorUserId, action: "pool.update", targetType: "strategy", targetId: poolId, details: { before: before.rows[0], after: input }, ip });
  });
}

/** Point a product at a pool (or none). Append-only history; affects only NEW investments. */
export async function assignProductToPool(db: Db, actorUserId: string, raw: unknown, ip?: string | null) {
  const input = z
    .object({ productId: uuid, poolStrategyId: uuid.nullable(), reason: z.string().trim().max(200).optional() })
    .strict()
    .parse(raw);
  return withTransaction(db, async (tx) => {
    const p = await tx.query("SELECT id FROM investment_products WHERE id = $1 FOR UPDATE", [input.productId]);
    if (!p.rowCount) throw notFound("Product not found");
    if (input.poolStrategyId) {
      const pool = await tx.query("SELECT status FROM reward_pools WHERE strategy_id = $1", [input.poolStrategyId]);
      if (!pool.rows[0]) throw notFound("Pool not found");
      if (pool.rows[0].status !== "active") throw unprocessable("pool_closed", "Cannot assign a product to a closed pool");
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO product_pool_assignments (product_id, pool_strategy_id, reason, assigned_by) VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [input.productId, input.poolStrategyId, input.reason ?? null, actorUserId],
    );
    await audit(tx, {
      actorUserId,
      action: "product.assign_pool",
      targetType: "investment_product",
      targetId: input.productId,
      details: { poolStrategyId: input.poolStrategyId, assignmentId: rows[0]!.id, reason: input.reason ?? null },
      ip,
    });
    return rows[0]!.id;
  });
}

export async function createPolicy(db: Db, actorUserId: string, raw: unknown, ip?: string | null) {
  const input = z
    .object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(1000).default(""),
      reserveRatio: z.string().regex(/^0(\.\d{1,8})?$/, "reserveRatio must be a decimal in [0, 1), e.g. \"0.1\""),
    })
    .strict()
    .parse(raw);
  return withTransaction(db, async (tx) => {
    await tx.query("LOCK TABLE reward_policies IN SHARE ROW EXCLUSIVE MODE");
    const { rows } = await tx.query<{ version: number }>(
      `INSERT INTO reward_policies (version, name, description, reserve_ratio, created_by)
       SELECT COALESCE(max(version), 0) + 1, $1, $2, $3, $4 FROM reward_policies RETURNING version`,
      [input.name, input.description, input.reserveRatio, actorUserId],
    );
    await audit(tx, { actorUserId, action: "reward_policy.create", details: { version: rows[0]!.version, ...input }, ip });
    return rows[0]!.version;
  });
}

export async function currentPolicy(db: Db | Tx) {
  const { rows } = await db.query<{ id: string; version: number; name: string; reserve_ratio: string }>(
    "SELECT id, version, name, reserve_ratio::text FROM reward_policies ORDER BY version DESC LIMIT 1",
  );
  if (!rows[0]) throw new Error("no reward policy configured");
  return rows[0];
}

export async function listPolicies(db: Db) {
  const { rows } = await db.query(
    `SELECT id, version, name, description, reserve_ratio::text AS "reserveRatio", created_at AS "createdAt"
       FROM reward_policies ORDER BY version DESC`,
  );
  return rows;
}

/**
 * Called inside createInvestment's transaction. If the product is assigned to
 * a pool, record the investment's (simulated) participation, enforcing pool
 * status and capacity. Returns null when the product has no pool.
 */
export async function allocateInvestmentToPool(
  tx: Tx,
  inv: { investmentId: string; userId: string; productId: string; principal: Money; ip?: string | null },
) {
  const a = await tx.query<{ id: string; pool_strategy_id: string | null }>(
    `SELECT id::text, pool_strategy_id FROM product_pool_assignments WHERE product_id = $1 ORDER BY id DESC LIMIT 1`,
    [inv.productId],
  );
  const assignment = a.rows[0];
  if (!assignment?.pool_strategy_id) return null;
  const poolId = assignment.pool_strategy_id;

  // Lock the pool so concurrent investments cannot jointly exceed capacity.
  const pool = (
    await tx.query<{ customer_capacity: string; status: string; strategy_status: string; code: string }>(
      `SELECT rp.customer_capacity::text, rp.status, s.status AS strategy_status, s.code
         FROM reward_pools rp JOIN strategies s ON s.id = rp.strategy_id
        WHERE rp.strategy_id = $1 FOR UPDATE OF rp`,
      [poolId],
    )
  ).rows[0]!;
  if (pool.status !== "active" || pool.strategy_status !== "active") {
    throw unprocessable("pool_unavailable", `The simulated strategy pool behind this product (${pool.code}) is not accepting allocations`);
  }
  const capital = await tx.query<{ balance: string }>(
    `SELECT COALESCE(sum(balance), 0)::text AS balance FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = 'strategy_capital'`,
    [poolId],
  );
  const active = await tx.query<{ total: string }>(
    // Count every allocation that has not ended, regardless of its start: now() is the
    // transaction START time, so a concurrent, later-starting transaction's allocation
    // (committed while we waited for the pool lock) can have effective_from > our now().
    `SELECT COALESCE(sum(amount), 0)::text AS total FROM pool_allocations
      WHERE pool_strategy_id = $1 AND effective_to > now()`,
    [poolId],
  );
  const weight = new Money(1); // one pool per product: the whole investment participates
  const allocation = inv.principal.times(weight);
  const limit = Money.min(fromDb(pool.customer_capacity), fromDb(capital.rows[0]!.balance));
  const used = fromDb(active.rows[0]!.total);
  if (used.plus(allocation).gt(limit)) {
    throw unprocessable(
      "pool_capacity",
      `The simulated strategy pool behind this product is full (remaining capacity ${format(Money.max(limit.minus(used), new Money(0)), 6)} USDT)`,
    );
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO pool_allocations (investment_id, user_id, pool_strategy_id, assignment_id, weight, amount, effective_from, effective_to)
     SELECT i.id, i.user_id, $2, $3, $4, $5, i.start_at, i.maturity_at FROM investments i WHERE i.id = $1
     RETURNING id`,
    [inv.investmentId, poolId, assignment.id, weight.toFixed(), allocation.toFixed()],
  );
  await audit(tx, {
    actorUserId: inv.userId,
    action: "pool.allocation_created",
    targetType: "pool_allocation",
    targetId: rows[0]!.id,
    details: { investmentId: inv.investmentId, poolStrategyId: poolId, amount: allocation.toFixed(), weight: weight.toFixed(), simulated: true },
    ip: inv.ip,
  });
  return { allocationId: rows[0]!.id, poolStrategyId: poolId };
}

export async function listPools(db: Db) {
  const { rows } = await db.query(`
    SELECT rp.strategy_id AS id, s.code, s.name, s.status AS "strategyStatus", rp.status, rp.customer_capacity::text AS "customerCapacity",
           rp.rewards_start_at AS "rewardsStartAt",
           COALESCE((SELECT sum(balance) FROM ledger_accounts WHERE owner_strategy_id = rp.strategy_id AND purpose = 'strategy_capital'), 0)::text AS "paperCapital",
           COALESCE((SELECT sum(balance) FROM ledger_accounts WHERE owner_strategy_id = rp.strategy_id AND purpose = 'pool_reserve'), 0)::text AS "reserve",
           COALESCE((SELECT sum(balance) FROM ledger_accounts WHERE owner_strategy_id = rp.strategy_id AND purpose = 'strategy_distributions'), 0)::text AS "distributed",
           COALESCE((SELECT sum(amount) FROM pool_allocations pa WHERE pa.pool_strategy_id = rp.strategy_id
                       AND pa.effective_to > now()), 0)::text AS "activeAllocations",
           (SELECT count(*)::int FROM pool_allocations pa WHERE pa.pool_strategy_id = rp.strategy_id) AS "allocationCount",
           COALESCE((SELECT cf_close FROM reward_runs r WHERE r.pool_strategy_id = rp.strategy_id AND r.status = 'posted'
                      ORDER BY r.period_end DESC LIMIT 1), 0)::text AS "lossCarryForward",
           (SELECT max(period_end) FROM reward_runs r WHERE r.pool_strategy_id = rp.strategy_id AND r.status = 'posted') AS "lastPeriodEnd",
           (SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.name))
              FROM investment_products p
             WHERE (SELECT pool_strategy_id FROM product_pool_assignments a WHERE a.product_id = p.id ORDER BY a.id DESC LIMIT 1) = rp.strategy_id) AS products
      FROM reward_pools rp JOIN strategies s ON s.id = rp.strategy_id
     ORDER BY s.code`);
  return rows.map((r) => ({ ...r, simulated: true, products: r.products ?? [] }));
}

/** Current pool (if any) per product, for product listings. */
export async function productPools(db: Db | Tx): Promise<Map<string, { poolId: string; poolCode: string; poolName: string }>> {
  const { rows } = await db.query<{ product_id: string; pool_id: string; code: string; name: string }>(`
    SELECT DISTINCT ON (a.product_id) a.product_id, a.pool_strategy_id AS pool_id, s.code, s.name
      FROM product_pool_assignments a LEFT JOIN strategies s ON s.id = a.pool_strategy_id
     ORDER BY a.product_id, a.id DESC`);
  return new Map(rows.filter((r) => r.pool_id).map((r) => [r.product_id, { poolId: r.pool_id, poolCode: r.code, poolName: r.name }]));
}
