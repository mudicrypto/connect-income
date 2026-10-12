import { withTransaction, type Db } from "../db/pool.js";
import { ensureStrategyAccounts, getAsset, type StrategyAccounts } from "../ledger/accounts.js";
import { postEntry, type PostingInput } from "../ledger/ledger.js";
import { Money, type Money as MoneyT } from "../lib/money.js";
import { getInstrument } from "../market/market.js";
import { decide, parseParams, type StrategyType } from "./logic.js";
import {
  applyFill,
  down,
  drawdownRatio,
  fillBuy,
  fillSell,
  lossBreach,
  positionLimitViolations,
  value,
  type Breach,
  type Fill,
  type PositionState,
  type RiskLimits,
  type Venue,
} from "./math.js";

/**
 * Paper-trading engine. SIMULATED ONLY.
 *
 * Processing model:
 *   - A strategy has a cursor (`last_tick_seq`). Each market tick after the
 *     cursor is processed in its OWN database transaction that locks the
 *     strategy row, so concurrent runs serialise and skip ticks already done.
 *   - Everything a tick produces (trades, ledger entries, position, valuation
 *     snapshot, risk events, cursor advance) commits atomically. An
 *     interrupted run therefore leaves no partial tick; the next run resumes
 *     at the cursor.
 *   - UNIQUE(strategy, tick) on strategy_tick_results and deterministic
 *     journal keys make double-processing impossible at the database level.
 */

export interface EngineOptions {
  trigger: "admin" | "scheduler" | "test" | "seed";
  actorUserId?: string | null;
  strategyIds?: string[];
  /** Upper bound of ticks per strategy per run. */
  maxTicksPerStrategy?: number;
  /** TEST ONLY: called inside the tick transaction just before commit; throwing simulates a crash. */
  faultInjector?: (ctx: { strategyId: string; tickSeq: number }) => void | Promise<void>;
}

export interface RunSummary {
  runId: string;
  status: "completed" | "failed";
  ticksProcessed: number;
  trades: number;
  error?: string;
}

interface StrategyRow {
  id: string;
  code: string;
  strategy_type: StrategyType;
  instrument_id: string;
  status: "active" | "paused";
  pause_reason: string | null;
  paused_at: Date | null;
  max_position_value: string;
  max_exposure_ratio: string;
  daily_loss_limit: string;
  max_drawdown_ratio: string;
  params: unknown;
  last_tick_seq: string;
  last_equity: string;
  peak_equity: string;
  day_start_equity: string;
  current_day: string | null;
}

const STALE_RUN_MINUTES = 5;

export async function runEngine(db: Db, opts: EngineOptions): Promise<RunSummary> {
  // A run whose process died never reaches its finally block; mark it so.
  await db.query(
    `UPDATE strategy_runs SET status = 'abandoned', finished_at = now(), error = 'no heartbeat (process interrupted)'
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)`,
    [STALE_RUN_MINUTES],
  );
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO strategy_runs (trigger, actor_user_id) VALUES ($1, $2) RETURNING id",
    [opts.trigger, opts.actorUserId ?? null],
  );
  const runId = rows[0]!.id;
  let ticksProcessed = 0;
  let trades = 0;
  try {
    const strategies = await db.query<{ id: string; instrument_id: string; last_tick_seq: string }>(
      `SELECT id, instrument_id, last_tick_seq::text FROM strategies
        WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY code`,
      [opts.strategyIds ?? null],
    );
    for (const s of strategies.rows) {
      const ticks = await db.query<{ id: string }>(
        `SELECT id::text FROM market_ticks WHERE instrument_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [s.instrument_id, s.last_tick_seq, opts.maxTicksPerStrategy ?? 5000],
      );
      for (const t of ticks.rows) {
        const r = await processTick(db, s.id, t.id, runId, opts.faultInjector);
        if (r.processed) {
          ticksProcessed++;
          trades += r.trades;
        }
        if (ticksProcessed % 20 === 0) {
          await db.query("UPDATE strategy_runs SET heartbeat_at = now(), ticks_processed = $2, trades = $3 WHERE id = $1", [
            runId,
            ticksProcessed,
            trades,
          ]);
        }
      }
    }
    await db.query(
      `UPDATE strategy_runs SET status = 'completed', ticks_processed = $2, trades = $3, finished_at = now(), heartbeat_at = now()
        WHERE id = $1`,
      [runId, ticksProcessed, trades],
    );
    return { runId, status: "completed", ticksProcessed, trades };
  } catch (err) {
    const message = (err as Error).message;
    await db.query(
      `UPDATE strategy_runs SET status = 'failed', ticks_processed = $2, trades = $3, error = $4, finished_at = now()
        WHERE id = $1`,
      [runId, ticksProcessed, trades, message.slice(0, 1000)],
    );
    return { runId, status: "failed", ticksProcessed, trades, error: message };
  }
}

/** Process one tick for one strategy. Returns processed=false if it was already processed. */
export async function processTick(
  db: Db,
  strategyId: string,
  tickId: string,
  runId: string | null,
  faultInjector?: EngineOptions["faultInjector"],
): Promise<{ processed: boolean; trades: number }> {
  return withTransaction(db, async (tx) => {
    const s = (
      await tx.query<StrategyRow>(
        `SELECT id, code, strategy_type, instrument_id, status, pause_reason, paused_at,
                max_position_value::text, max_exposure_ratio::text, daily_loss_limit::text, max_drawdown_ratio::text,
                params, last_tick_seq::text, last_equity::text, peak_equity::text, day_start_equity::text,
                to_char(current_day, 'YYYY-MM-DD') AS current_day
           FROM strategies WHERE id = $1 FOR UPDATE`,
        [strategyId],
      )
    ).rows[0];
    if (!s) throw new Error(`strategy ${strategyId} not found`);
    const tick = (
      await tx.query<{ id: string; seq: string; price: string; simulated_at: Date; instrument_id: string }>(
        "SELECT id::text, seq::text, price::text, simulated_at, instrument_id FROM market_ticks WHERE id = $1",
        [tickId],
      )
    ).rows[0];
    if (!tick || tick.instrument_id !== s.instrument_id) throw new Error(`tick ${tickId} does not belong to strategy instrument`);
    const seq = BigInt(tick.seq);
    const cursor = BigInt(s.last_tick_seq);
    if (seq <= cursor) return { processed: false, trades: 0 }; // already processed (concurrent or repeated run)
    if (seq !== cursor + 1n) throw new Error(`tick gap for ${s.code}: cursor ${cursor}, tick ${seq}`);

    const inst = await getInstrument(tx, s.instrument_id);
    const asset = await getAsset(tx, inst.quote_asset);
    const q = asset.scale;
    const venue: Venue = {
      feeBps: new Money(inst.fee_bps),
      slippageBps: new Money(inst.slippage_bps),
      priceScale: inst.price_scale,
      quantityScale: inst.quantity_scale,
      quoteScale: q,
    };
    const limits: RiskLimits = {
      maxPositionValue: new Money(s.max_position_value),
      maxExposureRatio: new Money(s.max_exposure_ratio),
      dailyLossLimit: new Money(s.daily_loss_limit),
      maxDrawdownRatio: new Money(s.max_drawdown_ratio),
    };
    const params = parseParams(s.strategy_type, s.params);
    const accounts = await ensureStrategyAccounts(tx, s.id, asset.code);
    const killSwitch = (await tx.query<{ kill_switch: boolean }>("SELECT kill_switch FROM engine_settings")).rows[0]!.kill_switch;

    const cashRow = await tx.query<{ balance: string }>("SELECT balance::text FROM ledger_accounts WHERE id = $1", [accounts.cash]);
    const posRow = await tx.query<{ quantity: string; cost_basis: string }>(
      `SELECT quantity::text, cost_basis::text FROM strategy_positions
        WHERE strategy_id = $1 AND instrument_id = $2 FOR UPDATE`,
      [s.id, s.instrument_id],
    );
    let state: PositionState = {
      cash: new Money(cashRow.rows[0]!.balance),
      quantity: new Money(posRow.rows[0]?.quantity ?? "0"),
      costBasis: new Money(posRow.rows[0]?.cost_basis ?? "0"),
    };
    const mid = new Money(tick.price);

    let status = s.status;
    let pauseReason = s.pause_reason;
    let pausedAt = s.paused_at;
    let peak = new Money(s.peak_equity);
    let dayStart = new Money(s.day_start_equity);
    let currentDay = s.current_day;
    const tickDay = tick.simulated_at.toISOString().slice(0, 10);
    if (currentDay !== tickDay) {
      // New simulated day: the daily loss baseline is the equity at the previous tick's close.
      dayStart = new Money(s.last_equity);
      currentDay = tickDay;
    }

    let tradeCount = 0;
    const notes: string[] = [];

    const event = (eventType: string, details: Record<string, unknown>) =>
      tx.query(
        "INSERT INTO strategy_events (strategy_id, event_type, tick_seq, run_id, details) VALUES ($1, $2, $3, $4, $5)",
        [s.id, eventType, tick.seq, runId, JSON.stringify(details)],
      );

    const execute = async (fill: Fill, reason: "signal" | "rebalance" | "risk_liquidation") => {
      const applied = applyFill(state, fill, q);
      const seqInTick = tradeCount;
      const postings = tradePostings(accounts, fill, applied.released, applied.realisedPnl);
      const { entryId, created } = await postEntry(tx, {
        entryType: "strategy_trade",
        idempotencyKey: `strategy_trade:${s.id}:${tick.id}:${seqInTick}`,
        description: `Simulated ${fill.side} ${fill.quantity.toFixed()} ${inst.symbol} @ ${fill.execPrice.toFixed()} (${reason})`,
        referenceType: "strategy",
        referenceId: s.id,
        metadata: { simulated: true, tickSeq: tick.seq, reason },
        postings,
      });
      if (!created) throw new Error(`duplicate trade entry for ${s.code} tick ${tick.seq}`);
      await tx.query(
        `INSERT INTO strategy_trades
           (strategy_id, instrument_id, tick_id, tick_seq, seq_in_tick, run_id, side, reason, quantity, mid_price,
            exec_price, notional, fee, slippage_cost, cost_basis_released, realised_pnl, position_qty_after, entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          s.id,
          s.instrument_id,
          tick.id,
          tick.seq,
          seqInTick,
          runId,
          fill.side,
          reason,
          fill.quantity.toFixed(),
          fill.midPrice.toFixed(),
          fill.execPrice.toFixed(),
          fill.notional.toFixed(),
          fill.fee.toFixed(),
          fill.slippageCost.toFixed(),
          applied.released.toFixed(),
          applied.realisedPnl.toFixed(),
          applied.next.quantity.toFixed(),
          entryId,
        ],
      );
      await tx.query(
        `INSERT INTO strategy_positions (strategy_id, instrument_id, quantity, cost_basis) VALUES ($1, $2, $3, $4)
         ON CONFLICT (strategy_id, instrument_id) DO UPDATE SET quantity = EXCLUDED.quantity, cost_basis = EXCLUDED.cost_basis, updated_at = now()`,
        [s.id, s.instrument_id, applied.next.quantity.toFixed(), applied.next.costBasis.toFixed()],
      );
      state = applied.next;
      tradeCount++;
    };

    let breached: Breach | null = null;
    const liquidateAndPause = async (breach: Breach) => {
      breached = breach;
      let liquidated = false;
      if (state.quantity.gt(0)) {
        const fill = fillSell(state.quantity, mid, venue);
        if (fill) {
          await execute(fill, "risk_liquidation");
          liquidated = true;
        }
      }
      status = "paused";
      pausedAt = tick.simulated_at;
      pauseReason = `Auto-paused: ${breach.limit} limit breached (observed ${breach.observed}, limit ${breach.threshold})`;
      await event("risk_breach", { ...breach, action: "paused", liquidated });
    };

    // 1. Mark to market and monitor loss limits before any new decision.
    let val = value(state, mid, q);
    if (val.equity.gt(peak)) peak = val.equity;
    if (status === "active") {
      const breach = lossBreach(val.equity, peak, dayStart, limits);
      if (breach) await liquidateAndPause(breach);
    }

    // 2. Strategy decision, sized and checked against risk limits on the server.
    if (!breached) {
      let lookbackPrice: MoneyT | null = null;
      if (s.strategy_type === "trading") {
        const lb = BigInt((params as { lookbackTicks: number }).lookbackTicks);
        if (seq - lb >= 0n) {
          const r = await tx.query<{ price: string }>("SELECT price::text FROM market_ticks WHERE instrument_id = $1 AND seq = $2", [
            s.instrument_id,
            (seq - lb).toString(),
          ]);
          lookbackPrice = r.rows[0] ? new Money(r.rows[0].price) : null;
        }
      }
      const decision = decide({
        type: s.strategy_type,
        params,
        price: mid,
        lookbackPrice,
        equity: val.equity,
        positionValue: val.positionValue,
        positionQty: state.quantity,
      });
      const minTrade = new Money(params.minTradeValue);

      if (decision.action === "buy") {
        if (status !== "active") notes.push("buy_blocked:paused");
        else if (killSwitch) notes.push("buy_blocked:kill_switch");
        else {
          const headroom: Record<string, MoneyT> = {
            requested: decision.value,
            max_position_value: limits.maxPositionValue.minus(val.positionValue),
            max_exposure_ratio: val.equity.times(limits.maxExposureRatio).minus(val.positionValue),
            available_cash: state.cash,
          };
          let budget = decision.value;
          for (const v of Object.values(headroom)) if (v.lt(budget)) budget = v;
          const binding = Object.entries(headroom)
            .filter(([k, v]) => k !== "requested" && v.lt(decision.value))
            .map(([k]) => k);
          // Verify the actual fill against post-trade limits; shrink until it passes.
          let fill = budget.gt(0) ? fillBuy(down(budget, q), mid, venue) : null;
          for (let i = 0; fill && i < 200; i++) {
            if (positionLimitViolations(applyFill(state, fill, q).next, mid, limits, q).length === 0) break;
            budget = down(budget.times("0.99"), q);
            fill = fillBuy(budget, mid, venue);
          }
          const valid = fill && positionLimitViolations(applyFill(state, fill, q).next, mid, limits, q).length === 0;
          if (fill && valid && fill.notional.gte(minTrade)) {
            await execute(fill, decision.reason);
            if (binding.length > 0) {
              await event("order_clipped", {
                side: "buy",
                requestedValue: decision.value.toFixed(q),
                executedNotional: fill.notional.toFixed(),
                limitedBy: binding,
              });
            }
          } else {
            await event("order_rejected", {
              side: "buy",
              requestedValue: decision.value.toFixed(q),
              reason: binding.length ? binding : ["below_min_trade_value"],
            });
          }
        }
      } else if (decision.action === "sell") {
        // Exits are always allowed: they reduce risk, even when paused or under the kill switch.
        const qty = decision.all ? state.quantity : Money.min(state.quantity, down(decision.value.div(mid), venue.quantityScale));
        const fill = fillSell(qty, mid, venue);
        if (fill) await execute(fill, decision.reason);
      } else if (decision.note) {
        notes.push(decision.note);
      }
    }

    // 3. Post-trade valuation and monitoring.
    val = value(state, mid, q);
    if (val.equity.gt(peak)) peak = val.equity;
    if (status === "active" && !breached) {
      const breach = lossBreach(val.equity, peak, dayStart, limits);
      if (breach) {
        await liquidateAndPause(breach);
        val = value(state, mid, q);
      }
    }

    await tx.query(
      `INSERT INTO strategy_tick_results
         (strategy_id, tick_id, tick_seq, run_id, status_after, price, cash, position_qty, position_value, cost_basis,
          equity, peak_equity, drawdown_ratio, day_pnl, trades, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        s.id,
        tick.id,
        tick.seq,
        runId,
        status,
        mid.toFixed(),
        state.cash.toFixed(),
        state.quantity.toFixed(),
        val.positionValue.toFixed(),
        state.costBasis.toFixed(),
        val.equity.toFixed(),
        peak.toFixed(),
        drawdownRatio(peak, val.equity).toFixed(),
        val.equity.minus(dayStart).toFixed(),
        tradeCount,
        notes.length ? notes.join(",") : null,
      ],
    );
    await tx.query(
      `UPDATE strategies
          SET last_tick_seq = $2, last_equity = $3, peak_equity = $4, day_start_equity = $5, current_day = $6,
              status = $7, pause_reason = $8, paused_at = $9
        WHERE id = $1`,
      [s.id, tick.seq, val.equity.toFixed(), peak.toFixed(), dayStart.toFixed(), currentDay, status, pauseReason, pausedAt],
    );

    if (faultInjector) await faultInjector({ strategyId: s.id, tickSeq: Number(seq) });
    return { processed: true, trades: tradeCount };
  });
}

/**
 * Ledger postings for one simulated fill (all within the strategy's own sub-ledger).
 *   Buy:  Dr strategy_position (notional)   Dr strategy_fees (fee)   Cr strategy_cash (notional + fee)
 *   Sell: Dr strategy_cash (notional - fee) Dr strategy_fees (fee)   Cr strategy_position (cost released)
 *         and the difference: Cr strategy_realised_gain  or  Dr strategy_realised_loss
 */
export function tradePostings(a: StrategyAccounts, fill: Fill, released: MoneyT, realisedPnl: MoneyT): PostingInput[] {
  const p: PostingInput[] = [];
  if (fill.side === "buy") {
    p.push({ accountId: a.position, direction: "debit", amount: fill.notional });
    if (fill.fee.gt(0)) p.push({ accountId: a.fees, direction: "debit", amount: fill.fee });
    p.push({ accountId: a.cash, direction: "credit", amount: fill.notional.plus(fill.fee) });
    return p;
  }
  p.push({ accountId: a.cash, direction: "debit", amount: fill.notional.minus(fill.fee) });
  if (fill.fee.gt(0)) p.push({ accountId: a.fees, direction: "debit", amount: fill.fee });
  if (released.gt(0)) p.push({ accountId: a.position, direction: "credit", amount: released });
  if (realisedPnl.gt(0)) p.push({ accountId: a.gain, direction: "credit", amount: realisedPnl });
  if (realisedPnl.lt(0)) p.push({ accountId: a.loss, direction: "debit", amount: realisedPnl.abs() });
  return p;
}

