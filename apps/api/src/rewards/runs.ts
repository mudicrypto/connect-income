import { z } from "zod";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { AppError, badRequest, conflict, notFound, unprocessable } from "../lib/errors.js";
import { format, fromDb, Money } from "../lib/money.js";
import { ensureAccount, ensureStrategyAccounts, ensureUserAccounts, getAsset, lockAccounts } from "../ledger/accounts.js";
import { postEntry, type PostingInput } from "../ledger/ledger.js";
import { audit } from "../services/audit.js";
import { calculateRewards, calculateRewardsV2, capitalIntegral, type CalcResult, type CalcResultV2 } from "./calc.js";
import { currentPolicy } from "./pools.js";

/**
 * Reward runs: the auditable reward journal. Lifecycle and guarantees are
 * specified in docs/rewards-accounting.md sections 4-6.
 */

class RunFailure extends AppError {
  constructor(code: string, message: string, public readonly details?: unknown) {
    super(422, code, message);
  }
}

const us = (col: string) => `(extract(epoch from ${col}) * 1000000)::numeric(30,0)::text`;

export type LossModel = "pool_v1" | "investment_v2";

interface PoolPeriodInputs {
  tradeIds: string[];
  /** v1 result (pool-wide carry-forward) or v2 result (per-investment loss recovery). */
  result: CalcResult | CalcResultV2;
  scale: number;
  asset: string;
}

/**
 * Opening per-investment balances (loss-recovery L⁰ and owned reserve V⁰) for
 * allocations, from each allocation's latest POSTED v2 line. v1 lines carry no
 * memo, so an allocation's v2 history starts at zero (rewards-accounting-v2.md §7).
 */
async function openingBalances(tx: Tx, allocationIds: string[]) {
  const { rows } = await tx.query<{ allocation_id: string; loss_close: string; reserve_close: string }>(
    `SELECT DISTINCT ON (l.allocation_id) l.allocation_id, l.loss_close::text, l.reserve_close::text
       FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
      WHERE l.allocation_id = ANY($1::uuid[]) AND r.status = 'posted' AND r.loss_model = 'investment_v2'
      ORDER BY l.allocation_id, r.period_end DESC`,
    [allocationIds],
  );
  return new Map(rows.map((r) => [r.allocation_id, { lossOpen: new Money(r.loss_close), reserveOpen: new Money(r.reserve_close) }]));
}

/** Gather source data for a pool and period and run the pure calculation. */
async function computePeriod(
  tx: Tx,
  poolId: string,
  periodStart: Date,
  periodEnd: Date,
  reserveRatio: string,
  cfOpen: string,
  model: LossModel,
): Promise<PoolPeriodInputs> {
  const meta = await tx.query<{ quote_asset: string; s_us: string; e_us: string }>(
    `SELECT i.quote_asset, ${us("$2::timestamptz")} AS s_us, ${us("$3::timestamptz")} AS e_us
       FROM strategies s JOIN market_instruments i ON i.id = s.instrument_id WHERE s.id = $1`,
    [poolId, periodStart, periodEnd],
  );
  const { quote_asset, s_us, e_us } = meta.rows[0]!;
  const asset = await getAsset(tx, quote_asset);

  // 1. Realised P&L: trades whose ledger entry was created inside [s, e).
  const trades = await tx.query<{ id: string; realised_pnl: string; fee: string }>(
    `SELECT t.id, t.realised_pnl::text, t.fee::text
       FROM strategy_trades t JOIN journal_entries e ON e.id = t.entry_id
      WHERE t.strategy_id = $1 AND e.created_at >= $2 AND e.created_at < $3
      ORDER BY t.id`,
    [poolId, periodStart, periodEnd],
  );

  // 2a. Paper capital timeline (credits to strategy_capital increase it).
  const capital = await tx.query<{ at_us: string; delta: string }>(
    `SELECT ${us("e.created_at")} AS at_us,
            (CASE WHEN p.direction = 'credit' THEN p.amount ELSE -p.amount END)::text AS delta
       FROM ledger_postings p
       JOIN ledger_accounts a ON a.id = p.account_id
       JOIN journal_entries e ON e.id = p.entry_id
      WHERE a.owner_strategy_id = $1 AND a.purpose = 'strategy_capital' AND e.created_at < $2`,
    [poolId, periodEnd],
  );
  const sUs = new Money(s_us);
  const eUs = new Money(e_us);
  const capInt = capitalIntegral(
    capital.rows.map((r) => ({ atUs: new Money(r.at_us), delta: new Money(r.delta) })),
    sUs,
    eUs,
  );

  // 2b. Allocations overlapping the period.
  const allocs = await tx.query<{ id: string; investment_id: string; user_id: string; amount: string; overlap_us: string }>(
    `SELECT id, investment_id, user_id, amount::text,
            (${us("LEAST(effective_to, $3::timestamptz)")}::numeric - ${us("GREATEST(effective_from, $2::timestamptz)")}::numeric)::text AS overlap_us
       FROM pool_allocations
      WHERE pool_strategy_id = $1 AND effective_from < $3 AND effective_to > $2
      ORDER BY id`,
    [poolId, periodStart, periodEnd],
  );

  const reserve = await tx.query<{ balance: string }>(
    `SELECT COALESCE(sum(balance), 0)::text AS balance FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = 'pool_reserve'`,
    [poolId],
  );

  if (model === "investment_v2") {
    const opening = await openingBalances(tx, allocs.rows.map((a) => a.id));
    const resultV2 = calculateRewardsV2({
      trades: trades.rows.map((t) => ({ realisedPnl: new Money(t.realised_pnl), fee: new Money(t.fee) })),
      capitalIntegral: capInt,
      allocations: allocs.rows.map((a) => ({
        allocationId: a.id,
        investmentId: a.investment_id,
        userId: a.user_id,
        amount: new Money(a.amount),
        overlapUs: new Money(a.overlap_us),
        ...(opening.get(a.id) ?? { lossOpen: new Money(0), reserveOpen: new Money(0) }),
      })),
      reserveRatio: new Money(reserveRatio),
      scale: asset.scale,
    });
    return { tradeIds: trades.rows.map((t) => t.id), result: resultV2, scale: asset.scale, asset: asset.code };
  }

  const result = calculateRewards({
    trades: trades.rows.map((t) => ({ realisedPnl: new Money(t.realised_pnl), fee: new Money(t.fee) })),
    capitalIntegral: capInt,
    allocations: allocs.rows.map((a) => ({
      allocationId: a.id,
      investmentId: a.investment_id,
      userId: a.user_id,
      amount: new Money(a.amount),
      overlapUs: new Money(a.overlap_us),
    })),
    cfOpen: new Money(cfOpen),
    reserveOpen: new Money(reserve.rows[0]!.balance),
    reserveRatio: new Money(reserveRatio),
    scale: asset.scale,
  });
  return { tradeIds: trades.rows.map((t) => t.id), result, scale: asset.scale, asset: asset.code };
}

async function lastPosted(tx: Tx, poolId: string) {
  const { rows } = await tx.query<{ period_end: Date; cf_close: string }>(
    `SELECT period_end, cf_close::text FROM reward_runs WHERE pool_strategy_id = $1 AND status = 'posted'
      ORDER BY period_end DESC LIMIT 1`,
    [poolId],
  );
  return rows[0] ?? null;
}

const calculateSchema = z
  .object({
    poolStrategyId: z.string().regex(/^[0-9a-f-]{36}$/i),
    // Optional: defaults to the database clock, so client clock skew cannot matter.
    periodEnd: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/** Calculate (but do not post) the next reward run for a pool. Writes no ledger entries. */
export async function calculateRun(db: Db, actorUserId: string, raw: unknown, ip?: string | null): Promise<string> {
  return withTransaction(db, (tx) => calculateRunTx(tx, actorUserId, raw, ip));
}

/** Same as calculateRun, inside the caller's transaction. */
export async function calculateRunTx(tx: Tx, actorUserId: string, raw: unknown, ip?: string | null): Promise<string> {
  const input = calculateSchema.parse(raw);
  {
    const pool = await tx.query<{ rewards_start_at: Date; loss_model: LossModel; period_mode: "daily_utc" | "ad_hoc" }>(
      "SELECT rewards_start_at, loss_model, period_mode FROM reward_pools WHERE strategy_id = $1 FOR UPDATE",
      [input.poolStrategyId],
    );
    if (!pool.rows[0]) throw notFound("Pool not found");
    const pending = await tx.query("SELECT id FROM reward_runs WHERE pool_strategy_id = $1 AND status = 'calculated'", [
      input.poolStrategyId,
    ]);
    if (pending.rowCount) throw conflict("run_pending", "This pool already has a calculated run awaiting post or cancel");

    const prev = await lastPosted(tx, input.poolStrategyId);
    const periodStart = prev ? prev.period_end : pool.rows[0].rewards_start_at;
    const model = pool.rows[0].loss_model;
    let periodEnd: Date;
    if (pool.rows[0].period_mode === "daily_utc") {
      // The next period ends at the first UTC midnight after its start (a stub aligns
      // the first period); one closed UTC day per run after that.
      periodEnd = (await tx.query<{ end: Date }>("SELECT next_utc_midnight($1) AS end", [periodStart])).rows[0]!.end;
      if (input.periodEnd && new Date(input.periodEnd).getTime() !== periodEnd.getTime()) {
        throw badRequest("invalid_period", `This pool uses daily UTC periods; the next period ends at ${periodEnd.toISOString()}`);
      }
      const closed = (await tx.query<{ closed: boolean }>("SELECT $1::timestamptz <= now() AS closed", [periodEnd])).rows[0]!.closed;
      if (!closed) {
        throw unprocessable("period_not_closed", `The UTC day ending ${periodEnd.toISOString()} has not closed yet; only closed periods are rewarded`);
      }
    } else {
      periodEnd = input.periodEnd ? new Date(input.periodEnd) : (await tx.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
    }
    const check = await tx.query<{ ok_order: boolean; ok_past: boolean }>(
      "SELECT $2::timestamptz > $1::timestamptz AS ok_order, $2::timestamptz <= now() AS ok_past",
      [periodStart, periodEnd],
    );
    if (!check.rows[0]!.ok_order) {
      throw badRequest("invalid_period", `periodEnd must be after the period start (${periodStart.toISOString()})`);
    }
    if (!check.rows[0]!.ok_past) throw badRequest("invalid_period", "periodEnd cannot be in the future: only closed periods are rewarded");

    const policy = await currentPolicy(tx);
    const { result, tradeIds } = await computePeriod(
      tx,
      input.poolStrategyId,
      periodStart,
      periodEnd,
      policy.reserve_ratio,
      prev?.cf_close ?? "0",
      model,
    );
    const r = result;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO reward_runs
         (pool_strategy_id, policy_id, policy_version, period_start, period_end, source_trade_count, gross_gains, gross_losses,
          fees, net_realised, capital_integral, allocation_integral, customer_fraction, attributable, cf_open, cf_recovered,
          cf_close, reserve_open, reserve_applied, eligible_profit, reserve_contribution, rounding_residual, distributable,
          total_rewards, created_by, loss_model, attribution_residual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
       RETURNING id`,
      [
        input.poolStrategyId,
        policy.id,
        policy.version,
        periodStart,
        periodEnd,
        tradeIds.length,
        r.grossGains.toFixed(),
        r.grossLosses.toFixed(),
        r.fees.toFixed(),
        r.netRealised.toFixed(),
        r.capitalIntegral.toFixed(),
        r.allocationIntegral.toFixed(),
        r.customerFraction.toFixed(),
        r.attributable.toFixed(),
        r.cfOpen.toFixed(),
        r.cfRecovered.toFixed(),
        r.cfClose.toFixed(),
        r.reserveOpen.toFixed(),
        r.reserveApplied.toFixed(),
        r.eligibleProfit.toFixed(),
        r.reserveContribution.toFixed(),
        r.roundingResidual.toFixed(),
        r.distributable.toFixed(),
        r.totalRewards.toFixed(),
        actorUserId,
        model,
        "attributionResidual" in r ? r.attributionResidual.toFixed() : "0",
      ],
    );
    const runId = rows[0]!.id;
    for (const l of r.lines) {
      const v2 = "lossOpen" in l ? l : null;
      await tx.query(
        `INSERT INTO reward_run_lines (run_id, allocation_id, investment_id, user_id, allocation_amount, overlap_us,
           weighted_allocation, weight_fraction, reward, loss_open, attributable, loss_recovered, loss_close, reserve_open,
           reserve_applied, eligible, reserve_contribution, reserve_close)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          runId, l.allocationId, l.investmentId, l.userId, l.amount.toFixed(), l.overlapUs.toFixed(), l.weightedAllocation.toFixed(),
          l.weightFraction.toFixed(), l.reward.toFixed(),
          v2?.lossOpen.toFixed() ?? null, v2?.attributable.toFixed() ?? null, v2?.lossRecovered.toFixed() ?? null,
          v2?.lossClose.toFixed() ?? null, v2?.reserveOpen.toFixed() ?? null, v2?.reserveApplied.toFixed() ?? null,
          v2?.eligible.toFixed() ?? null, v2?.reserveContribution.toFixed() ?? null, v2?.reserveClose.toFixed() ?? null,
        ],
      );
    }
    await audit(tx, {
      actorUserId,
      action: "reward_run.calculate",
      targetType: "reward_run",
      targetId: runId,
      details: { pool: input.poolStrategyId, lossModel: model, periodStart, periodEnd, distributable: r.distributable.toFixed(), totalRewards: r.totalRewards.toFixed() },
      ip,
    });
    return runId;
  }
}

const RECONCILED_FIELDS = [
  ["source_trade_count", "sourceTradeCount"],
  ["net_realised", "netRealised"],
  ["attributable", "attributable"],
  ["cf_close", "cfClose"],
  ["reserve_applied", "reserveApplied"],
  ["eligible_profit", "eligibleProfit"],
  ["reserve_contribution", "reserveContribution"],
  ["distributable", "distributable"],
  ["total_rewards", "totalRewards"],
] as const;

/**
 * Post a calculated run: recompute and reconcile, check pool cash, write the
 * ledger entries, record sources, mark posted, release matured lines. One
 * transaction; on a deterministic failure the run is marked 'failed'.
 */
export async function postRun(
  db: Db,
  actorUserId: string,
  runId: string,
  ip?: string | null,
  /** TEST ONLY: called just before the run is marked posted; throwing simulates a crash mid-post. */
  faultInjector?: () => void,
) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw notFound("Reward run not found");
  try {
    return await withTransaction(db, async (tx) => {
      const run = (
        await tx.query<Record<string, string> & { period_start: Date; period_end: Date; status: string; source_trade_count: number }>(
          `SELECT r.*, r.source_trade_count, p.reserve_ratio::text AS reserve_ratio,
                  r.net_realised::text AS net_realised, r.attributable::text AS attributable, r.cf_open::text AS cf_open,
                  r.cf_close::text AS cf_close, r.reserve_applied::text AS reserve_applied, r.eligible_profit::text AS eligible_profit,
                  r.reserve_contribution::text AS reserve_contribution, r.distributable::text AS distributable,
                  r.total_rewards::text AS total_rewards
             FROM reward_runs r JOIN reward_policies p ON p.id = r.policy_id WHERE r.id = $1 FOR UPDATE OF r`,
          [runId],
        )
      ).rows[0];
      if (!run) throw notFound("Reward run not found");
      if (run.status !== "calculated") throw conflict("run_not_postable", `Run is ${run.status}; only calculated runs can be posted`);
      const poolId = run.pool_strategy_id!;
      // Lock order: run -> pool -> strategy -> investments -> ledger accounts.
      // The pool lock serialises with new allocations; the strategy lock waits for
      // any in-flight tick or capital allocation, so the recomputation below sees
      // every write dated inside the period (later writers hit the DB period guard).
      await tx.query("SELECT 1 FROM reward_pools WHERE strategy_id = $1 FOR UPDATE", [poolId]);
      await tx.query("SELECT 1 FROM strategies WHERE id = $1 FOR UPDATE", [poolId]);
      // Lock the recipients' investments so a concurrent maturity settlement either
      // completes first (and we release below) or waits and then sees this run posted.
      await tx.query(
        `SELECT i.id FROM investments i WHERE i.id IN (SELECT investment_id FROM reward_run_lines WHERE run_id = $1)
          ORDER BY i.id FOR UPDATE`,
        [runId],
      );

      const prev = await lastPosted(tx, poolId);
      if (prev && prev.period_end.getTime() !== run.period_start.getTime()) {
        throw new RunFailure("period_chain_broken", "Run period no longer follows the last posted period");
      }

      // Reconciliation: the source data must still produce the stored figures.
      const { result, tradeIds, asset } = await computePeriod(
        tx,
        poolId,
        run.period_start,
        run.period_end,
        run.reserve_ratio!,
        run.cf_open!,
        run.loss_model as LossModel,
      );
      const mismatches = RECONCILED_FIELDS.filter(([col, key]) => !new Money(String(run[col])).eq(result[key] as Money | number)).map(
        ([col, key]) => ({ field: col, stored: String(run[col]), recomputed: String(result[key]) }),
      );
      // Per line: the reward, and for v2 every per-investment memo balance.
      const storedLines = await tx.query<{
        allocation_id: string;
        reward: string;
        loss_open: string | null;
        loss_close: string | null;
        reserve_open: string | null;
        reserve_close: string | null;
        attributable: string | null;
      }>(
        `SELECT allocation_id, reward::text, loss_open::text, loss_close::text, reserve_open::text, reserve_close::text,
                attributable::text FROM reward_run_lines WHERE run_id = $1 ORDER BY allocation_id`,
        [runId],
      );
      const fresh = new Map<string, (typeof result.lines)[number]>(result.lines.map((l) => [l.allocationId, l]));
      const same = (a: string | null, b: Money | undefined) => (a === null ? b === undefined : b !== undefined && new Money(a).eq(b));
      const linesMatch =
        storedLines.rows.length === result.lines.length &&
        storedLines.rows.every((l) => {
          const f = fresh.get(l.allocation_id);
          if (!f || !new Money(l.reward).eq(f.reward)) return false;
          if (!("lossOpen" in f)) return l.loss_open === null;
          return (
            same(l.loss_open, f.lossOpen) && same(l.loss_close, f.lossClose) && same(l.reserve_open, f.reserveOpen) &&
            same(l.reserve_close, f.reserveClose) && same(l.attributable, f.attributable)
          );
        });
      if (mismatches.length || !linesMatch) {
        throw new RunFailure("reconciliation_failed", "Source data changed since calculation; recalculate the period", {
          mismatches,
          linesMatch,
        });
      }

      const strategy = await ensureStrategyAccounts(tx, poolId, asset);
      const reserveAcct = await ensureAccount(tx, "pool_reserve", asset, { strategyId: poolId });
      const custody = await ensureAccount(tx, "platform_sim_custody", asset);
      const eligible = new Money(run.eligible_profit!);
      const reserveApplied = new Money(run.reserve_applied!);
      const reserveContribution = new Money(run.reserve_contribution!);

      let distributionEntryId: string | null = null;
      if (eligible.gt(0)) {
        const cash = fromDb((await lockAccounts(tx, [strategy.cash])).get(strategy.cash));
        if (cash.lt(eligible)) {
          throw new RunFailure(
            "insufficient_pool_cash",
            `Pool cash ${format(cash, 6)} is below the amount to distribute ${format(eligible, 6)}; positions must be closed first`,
          );
        }
        const lines = await tx.query<{ user_id: string; reward: string }>(
          "SELECT user_id, reward::text FROM reward_run_lines WHERE run_id = $1 AND reward > 0 ORDER BY id",
          [runId],
        );
        const postings: PostingInput[] = [
          // Strategy half: realised profit leaves the pool.
          { accountId: strategy.distributions, direction: "debit", amount: eligible },
          { accountId: strategy.cash, direction: "credit", amount: eligible },
          // Customer half: the cash backs new customer liabilities.
          { accountId: custody, direction: "debit", amount: eligible },
        ];
        for (const l of lines.rows) {
          const acct = await ensureAccount(tx, "user_reward_pending", asset, { userId: l.user_id });
          postings.push({ accountId: acct, direction: "credit", amount: new Money(l.reward) });
        }
        if (reserveContribution.gt(0)) postings.push({ accountId: reserveAcct, direction: "credit", amount: reserveContribution });
        distributionEntryId = (
          await postEntry(tx, {
            entryType: "reward_distribution",
            idempotencyKey: `reward_run:${runId}:distribution`,
            description: "Simulated reward distribution from realised pool profit",
            initiatedBy: actorUserId,
            referenceType: "reward_run",
            referenceId: runId,
            metadata: { simulated: true, pool: poolId },
            postings,
          })
        ).entryId;
      }

      let reserveReleaseEntryId: string | null = null;
      if (reserveApplied.gt(0)) {
        reserveReleaseEntryId = (
          await postEntry(tx, {
            entryType: "reward_reserve_release",
            idempotencyKey: `reward_run:${runId}:reserve_release`,
            description: "Pool reserve applied to customer-attributable simulated loss",
            initiatedBy: actorUserId,
            referenceType: "reward_run",
            referenceId: runId,
            metadata: { simulated: true, pool: poolId },
            postings: [
              { accountId: reserveAcct, direction: "debit", amount: reserveApplied },
              { accountId: custody, direction: "credit", amount: reserveApplied },
              { accountId: strategy.cash, direction: "debit", amount: reserveApplied },
              { accountId: strategy.distributions, direction: "credit", amount: reserveApplied },
            ],
          })
        ).entryId;
      }

      // Distributions and reserve releases are capital flows, not trading results:
      // shift the strategy's risk baselines exactly as capital allocations do, so the
      // drawdown and daily-loss monitors never mistake a payout for a loss.
      const flow = reserveApplied.minus(eligible);
      if (!flow.isZero()) {
        await tx.query(
          `UPDATE strategies SET last_equity = last_equity + $2, peak_equity = peak_equity + $2,
                  day_start_equity = day_start_equity + $2 WHERE id = $1`,
          [poolId, flow.toFixed()],
        );
      }

      for (const t of tradeIds) await tx.query("INSERT INTO reward_run_sources (run_id, trade_id) VALUES ($1, $2)", [runId, t]);
      faultInjector?.();
      await tx.query(
        `UPDATE reward_runs SET status = 'posted', posted_at = now(), finished_at = now(), distribution_entry_id = $2,
                reserve_release_entry_id = $3 WHERE id = $1`,
        [runId, distributionEntryId, reserveReleaseEntryId],
      );

      // Investments that already matured get their rewards immediately.
      const matured = await tx.query<{ id: string }>(
        `SELECT DISTINCT i.id FROM reward_run_lines l JOIN investments i ON i.id = l.investment_id
          WHERE l.run_id = $1 AND l.reward > 0 AND i.status = 'matured' ORDER BY i.id`,
        [runId],
      );
      let released = 0;
      for (const m of matured.rows) released += await releaseInvestmentRewards(tx, m.id, actorUserId);

      await audit(tx, {
        actorUserId,
        action: "reward_run.post",
        targetType: "reward_run",
        targetId: runId,
        details: { distributionEntryId, reserveReleaseEntryId, sources: tradeIds.length, releasedLines: released },
        ip,
      });
      return { runId, status: "posted" as const, distributionEntryId, reserveReleaseEntryId, releasedLines: released };
    });
  } catch (err) {
    if (err instanceof RunFailure) {
      await db.query(
        "UPDATE reward_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'calculated'",
        [runId, `${err.code}: ${err.message}${err.details ? " " + JSON.stringify(err.details) : ""}`],
      );
      await audit(db, { actorUserId, action: "reward_run.failed", targetType: "reward_run", targetId: runId, details: { code: err.code }, ip });
    }
    throw err;
  }
}

export async function cancelRun(db: Db, actorUserId: string, runId: string, reason: unknown, ip?: string | null) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw notFound("Reward run not found");
  return withTransaction(db, async (tx) => {
    const r = await tx.query<{ status: string }>("SELECT status FROM reward_runs WHERE id = $1 FOR UPDATE", [runId]);
    if (!r.rows[0]) throw notFound("Reward run not found");
    if (r.rows[0].status !== "calculated") throw conflict("run_not_cancellable", `Run is ${r.rows[0].status}`);
    const text = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "Cancelled by admin";
    await tx.query("UPDATE reward_runs SET status = 'cancelled', finished_at = now(), error = $2 WHERE id = $1", [runId, text]);
    await audit(tx, { actorUserId, action: "reward_run.cancel", targetType: "reward_run", targetId: runId, details: { reason: text }, ip });
  });
}

/**
 * Release a matured investment's posted, unreleased rewards to the customer's
 * available balance (one entry per run line). Called from maturity settlement
 * and from postRun. Returns the number of lines released.
 */
export async function releaseInvestmentRewards(tx: Tx, investmentId: string, actorUserId: string | null): Promise<number> {
  const lines = await tx.query<{ id: string; run_id: string; allocation_id: string; user_id: string; reward: string; asset: string }>(
    `SELECT l.id::text, l.run_id, l.allocation_id, l.user_id, l.reward::text, i.asset
       FROM reward_run_lines l
       JOIN reward_runs r ON r.id = l.run_id
       JOIN investments i ON i.id = l.investment_id
      WHERE l.investment_id = $1 AND r.status = 'posted' AND l.reward > 0 AND l.released_entry_id IS NULL
      ORDER BY l.id FOR UPDATE OF l`,
    [investmentId],
  );
  for (const l of lines.rows) {
    const accounts = await ensureUserAccounts(tx, l.user_id, l.asset);
    const pending = await ensureAccount(tx, "user_reward_pending", l.asset, { userId: l.user_id });
    const { entryId } = await postEntry(tx, {
      entryType: "reward_release",
      idempotencyKey: `reward_release:${l.run_id}:${l.allocation_id}`,
      description: "Simulated reward released after maturity",
      initiatedBy: actorUserId,
      referenceType: "investment",
      referenceId: investmentId,
      metadata: { simulated: true, runId: l.run_id },
      postings: [
        { accountId: pending, direction: "debit", amount: new Money(l.reward) },
        { accountId: accounts.available, direction: "credit", amount: new Money(l.reward) },
      ],
    });
    await tx.query("UPDATE reward_run_lines SET released_entry_id = $2, released_at = now() WHERE id = $1", [l.id, entryId]);
  }
  return lines.rows.length;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

const RUN_COLUMNS = `r.id, r.pool_strategy_id AS "poolId", s.code AS "poolCode", r.policy_version AS "policyVersion", r.status,
  r.period_start AS "periodStart", r.period_end AS "periodEnd", r.source_trade_count AS "sourceTradeCount",
  r.gross_gains::text AS "grossGains", r.gross_losses::text AS "grossLosses", r.fees::text, r.net_realised::text AS "netRealised",
  r.customer_fraction::text AS "customerFraction", r.attributable::text, r.cf_open::text AS "cfOpen",
  r.cf_recovered::text AS "cfRecovered", r.cf_close::text AS "cfClose", r.reserve_open::text AS "reserveOpen",
  r.reserve_applied::text AS "reserveApplied", r.eligible_profit::text AS "eligibleProfit",
  r.reserve_contribution::text AS "reserveContribution", r.rounding_residual::text AS "roundingResidual",
  r.distributable::text, r.total_rewards::text AS "totalRewards", r.distribution_entry_id AS "distributionEntryId",
  r.reserve_release_entry_id AS "reserveReleaseEntryId", r.error, r.created_at AS "createdAt", r.posted_at AS "postedAt",
  r.finished_at AS "finishedAt", r.loss_model AS "lossModel", r.attribution_residual::text AS "attributionResidual"`;

export async function listRuns(db: Db, poolId?: string) {
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS} FROM reward_runs r JOIN strategies s ON s.id = r.pool_strategy_id
      WHERE ($1::uuid IS NULL OR r.pool_strategy_id = $1) ORDER BY r.created_at DESC LIMIT 100`,
    [poolId ?? null],
  );
  return rows;
}

export async function getRun(db: Db, runId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw notFound("Reward run not found");
  const run = await db.query(`SELECT ${RUN_COLUMNS} FROM reward_runs r JOIN strategies s ON s.id = r.pool_strategy_id WHERE r.id = $1`, [runId]);
  if (!run.rows[0]) throw notFound("Reward run not found");
  const [lines, sources] = await Promise.all([
    db.query(
      `SELECT l.id::text, l.investment_id AS "investmentId", l.allocation_id AS "allocationId", u.email AS "userEmail",
              l.allocation_amount::text AS "allocationAmount", l.overlap_us::text AS "overlapUs",
              l.weight_fraction::text AS "weightFraction", l.reward::text, l.released_entry_id AS "releasedEntryId", l.released_at AS "releasedAt",
              l.attributable::text, l.loss_open::text AS "lossOpen", l.loss_recovered::text AS "lossRecovered", l.loss_close::text AS "lossClose",
              l.reserve_open::text AS "reserveOpen", l.reserve_applied::text AS "reserveApplied",
              l.reserve_contribution::text AS "reserveContribution", l.reserve_close::text AS "reserveClose"
         FROM reward_run_lines l JOIN users u ON u.id = l.user_id WHERE l.run_id = $1 ORDER BY l.id`,
      [runId],
    ),
    db.query(
      `SELECT t.id, t.tick_seq::text AS "tickSeq", t.side, t.realised_pnl::text AS "realisedPnl", t.fee::text, t.entry_id AS "entryId"
         FROM reward_run_sources src JOIN strategy_trades t ON t.id = src.trade_id WHERE src.run_id = $1 ORDER BY t.tick_seq`,
      [runId],
    ),
  ]);
  return { simulated: true, run: run.rows[0], lines: lines.rows, sources: sources.rows };
}

/** Per-investment performance statement for its owner. */
export async function investmentRewardStatement(db: Db, userId: string, investmentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(investmentId)) throw notFound("Investment not found");
  const inv = await db.query(
    `SELECT i.id, i.principal::text, i.status, i.start_at AS "startAt", i.maturity_at AS "maturityAt", p.name AS "productName",
            pa.amount::text AS "allocationAmount", s.code AS "poolCode", s.name AS "poolName"
       FROM investments i
       JOIN investment_products p ON p.id = i.product_id
       LEFT JOIN pool_allocations pa ON pa.investment_id = i.id
       LEFT JOIN strategies s ON s.id = pa.pool_strategy_id
      WHERE i.id = $1 AND i.user_id = $2`,
    [investmentId, userId],
  );
  if (!inv.rows[0]) throw notFound("Investment not found");
  const lines = await db.query(
    `SELECT r.id AS "runId", r.period_start AS "periodStart", r.period_end AS "periodEnd", r.policy_version AS "policyVersion",
            r.net_realised::text AS "poolNetRealised", r.cf_close::text AS "poolLossCarryForward",
            l.weight_fraction::text AS "weightFraction", l.reward::text, l.released_at AS "releasedAt",
            r.loss_model AS "lossModel", l.attributable::text AS "yourShareOfPoolResult", l.loss_recovered::text AS "lossRecovered",
            l.loss_close::text AS "yourLossToRecover", l.reserve_contribution::text AS "reserveWithheld",
            l.reserve_applied::text AS "reserveApplied", l.reserve_close::text AS "yourReserve"
       FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id
      WHERE l.investment_id = $1 AND r.status = 'posted' ORDER BY r.period_start`,
    [investmentId],
  );
  const settlement = await db.query(
    `SELECT reserve_released::text AS "reserveReturned", loss_expired::text AS "lossExpired", created_at AS "settledAt"
       FROM reserve_settlements WHERE investment_id = $1`,
    [investmentId],
  );
  return { simulated: true, investment: inv.rows[0], periods: lines.rows, settlement: settlement.rows[0] ?? null };
}
