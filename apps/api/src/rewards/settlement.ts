import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { AppError, conflict, notFound, unprocessable } from "../lib/errors.js";
import { format, fromDb, Money } from "../lib/money.js";
import { ensureAccount, ensureUserAccounts } from "../ledger/accounts.js";
import { postEntry } from "../ledger/ledger.js";
import { audit } from "../services/audit.js";

/**
 * Reserve ownership and settlement (docs/rewards-accounting-v2.md §5).
 *
 * A v2 pool's reserve is owned per investment (allocation). Once an allocation's
 * term has ended AND every period overlapping it is posted, its remaining
 * reserve is returned to the investor and its unrecovered loss balance expires,
 * via an explicit, admin-approved settlement. Nothing is released because a
 * pool is closed.
 */

export type AllocationReserveState = "participating" | "settleable" | "blocked" | "settled";

export interface AllocationSettlementView {
  allocationId: string;
  investmentId: string;
  userId: string;
  userEmail: string;
  effectiveTo: string;
  investmentStatus: string;
  reserveHeld: string | null;
  lossBalance: string | null;
  unreleasedRewards: string;
  state: AllocationReserveState;
  reason: string | null;
  settledReserve: string | null;
  settledLossExpired: string | null;
}

interface AllocRow {
  allocation_id: string;
  investment_id: string;
  user_id: string;
  email: string;
  effective_to: Date;
  inv_status: string;
  reserve_close: string | null;
  loss_close: string | null;
  unreleased: string;
  settled_reserve: string | null;
  settled_loss: string | null;
}

async function allocationRows(db: Db | Tx, poolId: string): Promise<AllocRow[]> {
  const { rows } = await db.query<AllocRow>(
    `SELECT pa.id AS allocation_id, pa.investment_id, pa.user_id, u.email, pa.effective_to, i.status AS inv_status,
            last.reserve_close::text,
            -- Before its first v2 line, a transitioned investment's loss balance is its legacy-transition amount.
            COALESCE(last.loss_close, (SELECT tl.loss_amount FROM legacy_loss_transition_lines tl WHERE tl.allocation_id = pa.id))::text AS loss_close,
            COALESCE((SELECT sum(l.reward) FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
                       WHERE l.allocation_id = pa.id AND r.status = 'posted' AND l.released_entry_id IS NULL), 0)::text AS unreleased,
            rs.reserve_released::text AS settled_reserve, rs.loss_expired::text AS settled_loss
       FROM pool_allocations pa
       JOIN investments i ON i.id = pa.investment_id
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN reserve_settlements rs ON rs.allocation_id = pa.id
       LEFT JOIN LATERAL (
         SELECT l.reserve_close, l.loss_close FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
          WHERE l.allocation_id = pa.id AND r.status = 'posted' AND r.loss_model = 'investment_v2'
          ORDER BY r.period_end DESC LIMIT 1) last ON TRUE
      WHERE pa.pool_strategy_id = $1
      ORDER BY pa.effective_to, pa.id`,
    [poolId],
  );
  return rows;
}

function classify(
  a: AllocRow,
  pool: { loss_model: string; posted_end: Date | null; pending: boolean },
): { state: AllocationReserveState; reason: string | null } {
  if (a.settled_reserve !== null) return { state: "settled", reason: null };
  if (pool.loss_model !== "investment_v2") return { state: "blocked", reason: "pool is on the legacy pool_v1 model (transition required)" };
  if (a.inv_status !== "matured" || !pool.posted_end || pool.posted_end < a.effective_to) {
    return { state: "participating", reason: a.inv_status !== "matured" ? "investment not matured" : "periods overlapping the term are not all posted" };
  }
  if (pool.pending) return { state: "blocked", reason: "a reward run is pending for this pool" };
  if (!new Money(a.unreleased).isZero()) return { state: "blocked", reason: "posted rewards not yet released" };
  return { state: "settleable", reason: null };
}

async function poolFacts(db: Db | Tx, poolId: string) {
  const { rows } = await db.query<{ loss_model: string; status: string; posted_end: Date | null; pending: boolean; reserve: string; legacy_reserve: string }>(
    `SELECT rp.loss_model, rp.status,
            (SELECT max(period_end) FROM reward_runs WHERE pool_strategy_id = rp.strategy_id AND status = 'posted') AS posted_end,
            EXISTS (SELECT 1 FROM reward_runs WHERE pool_strategy_id = rp.strategy_id AND status = 'calculated') AS pending,
            COALESCE((SELECT sum(balance) FROM ledger_accounts WHERE owner_strategy_id = rp.strategy_id AND purpose = 'pool_reserve'), 0)::text AS reserve,
            COALESCE((SELECT sum(reserve_contribution - reserve_applied) FROM reward_runs
                       WHERE pool_strategy_id = rp.strategy_id AND status = 'posted' AND loss_model = 'pool_v1'), 0)::text AS legacy_reserve
       FROM reward_pools rp WHERE rp.strategy_id = $1`,
    [poolId],
  );
  if (!rows[0]) throw notFound("Pool not found");
  return rows[0];
}

export async function poolSettlementView(db: Db | Tx, poolId: string) {
  const pool = await poolFacts(db, poolId);
  const allocations: AllocationSettlementView[] = (await allocationRows(db, poolId)).map((a) => {
    const c = classify(a, pool);
    return {
      allocationId: a.allocation_id,
      investmentId: a.investment_id,
      userId: a.user_id,
      userEmail: a.email,
      effectiveTo: a.effective_to.toISOString(),
      investmentStatus: a.inv_status,
      // Legacy pool_v1 pools track losses and reserve only pool-wide: there is no per-investment figure.
      reserveHeld: pool.loss_model !== "investment_v2" ? null : a.settled_reserve !== null ? "0" : (a.reserve_close ?? "0"),
      lossBalance: pool.loss_model !== "investment_v2" ? null : a.settled_loss !== null ? "0" : (a.loss_close ?? "0"),
      unreleasedRewards: a.unreleased,
      state: c.state,
      reason: c.reason,
      settledReserve: a.settled_reserve,
      settledLossExpired: a.settled_loss,
    };
  });
  const outstanding =
    pool.pending ||
    allocations.some((a) => a.state !== "settled") ||
    !new Money(pool.reserve).isZero();
  const state = pool.status === "active" ? "open" : outstanding ? "closed_settling" : "closed_settled";
  return {
    simulated: true,
    poolState: state,
    lossModel: pool.loss_model,
    reserveBalance: pool.reserve,
    legacyReserve: pool.legacy_reserve,
    allocations,
  };
}

/**
 * Settle every settleable allocation of a pool: return each one's owned reserve
 * to the investor's available balance (Dr pool_reserve / Cr user_available) and
 * record its expired loss balance. One transaction, after reconciliation.
 */
export async function settlePoolReserves(db: Db, actorUserId: string, poolId: string, ip?: string | null) {
  if (!/^[0-9a-f-]{36}$/i.test(poolId)) throw notFound("Pool not found");
  return withTransaction(db, (tx) => settlePoolReservesTx(tx, actorUserId, poolId, ip));
}

export async function settlePoolReservesTx(tx: Tx, actorUserId: string, poolId: string, ip?: string | null) {
  // Lock order as reward posting: pool -> (strategy not needed: customer side only) -> investments -> accounts.
  const lock = await tx.query("SELECT 1 FROM reward_pools WHERE strategy_id = $1 FOR UPDATE", [poolId]);
  if (!lock.rowCount) throw notFound("Pool not found");
  const pool = await poolFacts(tx, poolId);
  if (pool.loss_model !== "investment_v2") {
    throw conflict("legacy_pool", "Reserve settlement needs the per-investment model; this pool is on legacy pool_v1 (transition required)");
  }
  await tx.query(
    "SELECT i.id FROM investments i WHERE i.id IN (SELECT investment_id FROM pool_allocations WHERE pool_strategy_id = $1) ORDER BY i.id FOR UPDATE",
    [poolId],
  );
  const rows = await allocationRows(tx, poolId);

  // Reconcile before touching anything: ledger reserve = Σ owned reserves of unsettled allocations + legacy v1 reserve.
  const owned = rows.filter((a) => a.settled_reserve === null).reduce((s, a) => s.plus(fromDb(a.reserve_close)), new Money(0));
  if (!fromDb(pool.reserve).eq(owned.plus(pool.legacy_reserve))) {
    throw new AppError(
      422,
      "reserve_reconciliation_failed",
      `Pool reserve ${pool.reserve} does not equal owned reserves ${owned.toFixed()} + legacy ${pool.legacy_reserve}; settlement aborted`,
    );
  }

  const settleable = rows.filter((a) => classify(a, pool).state === "settleable");
  const reserveAcct = await ensureAccount(tx, "pool_reserve", "USDT", { strategyId: poolId });
  const settled: Array<{ allocationId: string; reserveReleased: string; lossExpired: string; entryId: string | null }> = [];
  for (const a of settleable) {
    const reserve = fromDb(a.reserve_close);
    const loss = fromDb(a.loss_close);
    let entryId: string | null = null;
    if (reserve.gt(0)) {
      const user = await ensureUserAccounts(tx, a.user_id, "USDT");
      entryId = (
        await postEntry(tx, {
          entryType: "reserve_settlement",
          idempotencyKey: `reserve_settlement:${a.allocation_id}`,
          description: "Simulated reserve returned at final settlement of an investment",
          initiatedBy: actorUserId,
          referenceType: "pool_allocation",
          referenceId: a.allocation_id,
          metadata: { simulated: true, pool: poolId, investmentId: a.investment_id, lossExpired: loss.toFixed() },
          postings: [
            { accountId: reserveAcct, direction: "debit", amount: reserve },
            { accountId: user.available, direction: "credit", amount: reserve },
          ],
        })
      ).entryId;
    }
    await tx.query(
      `INSERT INTO reserve_settlements (allocation_id, pool_strategy_id, investment_id, user_id, reserve_released, loss_expired, entry_id, settled_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.allocation_id, poolId, a.investment_id, a.user_id, reserve.toFixed(), loss.toFixed(), entryId, actorUserId],
    );
    settled.push({ allocationId: a.allocation_id, reserveReleased: reserve.toFixed(), lossExpired: loss.toFixed(), entryId });
  }
  await audit(tx, {
    actorUserId,
    action: "pool.reserve_settlement",
    targetType: "strategy",
    targetId: poolId,
    details: { settled: settled.length, released: settled.reduce((s, x) => s.plus(x.reserveReleased), new Money(0)).toFixed() },
    ip,
  });
  return { simulated: true, settled };
}

/**
 * Move a legacy pool to the per-investment model. Allowed only when its legacy
 * pool-level balances are both zero (nothing to attribute) and no run is pending;
 * otherwise this is a founder decision (rewards-accounting-v2.md §7).
 */
export async function switchToInvestmentModel(db: Db, actorUserId: string, poolId: string, ip?: string | null) {
  if (!/^[0-9a-f-]{36}$/i.test(poolId)) throw notFound("Pool not found");
  return withTransaction(db, async (tx) => {
    const p = await tx.query<{ loss_model: string }>("SELECT loss_model FROM reward_pools WHERE strategy_id = $1 FOR UPDATE", [poolId]);
    if (!p.rows[0]) throw notFound("Pool not found");
    if (p.rows[0].loss_model === "investment_v2") throw conflict("already_v2", "Pool already uses the per-investment model");
    const facts = await poolFacts(tx, poolId);
    const cf = await tx.query<{ cf: string }>(
      `SELECT COALESCE((SELECT cf_close FROM reward_runs WHERE pool_strategy_id = $1 AND status = 'posted'
                         ORDER BY period_end DESC LIMIT 1), 0)::text AS cf`,
      [poolId],
    );
    if (facts.pending) throw conflict("pool_run_pending", "Post or cancel the pending run first");
    if (!new Money(cf.rows[0]!.cf).isZero() || !new Money(facts.reserve).isZero()) {
      throw unprocessable(
        "transition_requires_decision",
        `Legacy pool-level balances cannot be attributed to individual investments without a founder decision ` +
          `(carry-forward ${format(cf.rows[0]!.cf, 6)}, reserve ${format(facts.reserve, 6)} USDT). See docs/rewards-accounting-v2.md §7.`,
      );
    }
    await tx.query("UPDATE reward_pools SET loss_model = 'investment_v2', transition_required = FALSE WHERE strategy_id = $1", [poolId]);
    await audit(tx, { actorUserId, action: "pool.switch_loss_model", targetType: "strategy", targetId: poolId, details: { to: "investment_v2" }, ip });
  });
}

/** Switch a pool's accounting period mode (applies from the next period). */
export async function setPeriodMode(db: Db, actorUserId: string, poolId: string, mode: unknown, ip?: string | null) {
  if (mode !== "daily_utc" && mode !== "ad_hoc") throw unprocessable("invalid_period_mode", "periodMode must be daily_utc or ad_hoc");
  return withTransaction(db, async (tx) => {
    const p = await tx.query<{ period_mode: string }>("SELECT period_mode FROM reward_pools WHERE strategy_id = $1 FOR UPDATE", [poolId]);
    if (!p.rows[0]) throw notFound("Pool not found");
    const pending = await tx.query("SELECT 1 FROM reward_runs WHERE pool_strategy_id = $1 AND status = 'calculated'", [poolId]);
    if (pending.rowCount) throw conflict("pool_run_pending", "Post or cancel the pending run first");
    await tx.query("UPDATE reward_pools SET period_mode = $2 WHERE strategy_id = $1", [poolId, mode]);
    await audit(tx, { actorUserId, action: "pool.period_mode", targetType: "strategy", targetId: poolId, details: { from: p.rows[0].period_mode, to: mode }, ip });
  });
}

/** The next period a pool would calculate, and whether it has closed. */
export async function nextPeriod(db: Db | Tx, poolId: string) {
  const { rows } = await db.query<{ start: Date; end: Date | null; closed: boolean | null; mode: string }>(
    `SELECT s.start, CASE WHEN rp.period_mode = 'daily_utc' THEN next_utc_midnight(s.start) END AS end,
            CASE WHEN rp.period_mode = 'daily_utc' THEN next_utc_midnight(s.start) <= now() END AS closed, rp.period_mode AS mode
       FROM reward_pools rp,
            LATERAL (SELECT COALESCE((SELECT max(period_end) FROM reward_runs r WHERE r.pool_strategy_id = rp.strategy_id AND r.status = 'posted'),
                                     rp.rewards_start_at) AS start) s
      WHERE rp.strategy_id = $1`,
    [poolId],
  );
  const r = rows[0]!;
  return { mode: r.mode, start: r.start.toISOString(), end: r.end?.toISOString() ?? null, closed: r.closed };
}
