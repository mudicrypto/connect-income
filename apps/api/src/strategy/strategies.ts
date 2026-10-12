import { z } from "zod";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { format, fromDb, Money, parseAmount } from "../lib/money.js";
import { ensureStrategyAccounts, getAsset } from "../ledger/accounts.js";
import { postEntry } from "../ledger/ledger.js";
import { getInstrumentBySymbol, latestTick } from "../market/market.js";
import { audit } from "../services/audit.js";
import { runIdempotent } from "../services/idempotency.js";
import { INSTRUMENT_KIND_FOR, parseParams, type StrategyType } from "./logic.js";
import { down, drawdownRatio } from "./math.js";

const decimalString = z.string().regex(/^\d{1,20}(\.\d{1,6})?$/, "must be a decimal string, e.g. \"1000.00\"");
const ratioString = z.string().regex(/^0(\.\d{1,8})?$|^1(\.0{1,8})?$/, "must be a ratio between 0 and 1, e.g. \"0.25\"");

export const createStrategySchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,32}$/, "2-32 chars of A-Z 0-9 _ -"),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(""),
    type: z.enum(["trading", "staking", "lending"]),
    instrumentSymbol: z.string().trim(),
    maxAllocation: decimalString,
    maxPositionValue: decimalString,
    maxExposureRatio: ratioString,
    dailyLossLimit: decimalString,
    maxDrawdownRatio: ratioString,
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

function positive(name: string, v: string) {
  if (new Money(v).lte(0)) throw unprocessable("invalid_limit", `${name} must be greater than zero`);
}

export async function createStrategy(db: Db, actorUserId: string, raw: unknown, ip?: string | null) {
  const input = createStrategySchema.parse(raw);
  positive("maxAllocation", input.maxAllocation);
  positive("maxPositionValue", input.maxPositionValue);
  positive("maxExposureRatio", input.maxExposureRatio);
  positive("dailyLossLimit", input.dailyLossLimit);
  positive("maxDrawdownRatio", input.maxDrawdownRatio);
  if (new Money(input.maxDrawdownRatio).gte(1)) throw unprocessable("invalid_limit", "maxDrawdownRatio must be below 1");
  const params = parseParams(input.type, input.params);

  return withTransaction(db, async (tx) => {
    const inst = await getInstrumentBySymbol(tx, input.instrumentSymbol);
    if (inst.kind !== INSTRUMENT_KIND_FOR[input.type]) {
      throw unprocessable("instrument_mismatch", `A ${input.type} strategy needs a ${INSTRUMENT_KIND_FOR[input.type]} instrument`);
    }
    const tick = await latestTick(tx, inst.id);
    if (!tick) throw unprocessable("no_market_data", `${inst.symbol} has no simulated market data yet; advance the market first`);

    const res = await tx.query<{ id: string }>(
      `INSERT INTO strategies
         (code, name, description, strategy_type, instrument_id, max_allocation, max_position_value, max_exposure_ratio,
          daily_loss_limit, max_drawdown_ratio, params, last_tick_seq, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (code) DO NOTHING RETURNING id`,
      [
        input.code,
        input.name,
        input.description,
        input.type,
        inst.id,
        input.maxAllocation,
        input.maxPositionValue,
        input.maxExposureRatio,
        input.dailyLossLimit,
        input.maxDrawdownRatio,
        JSON.stringify(params),
        tick.seq,
        actorUserId,
      ],
    );
    if (!res.rows[0]) throw conflict("strategy_code_taken", `Strategy code ${input.code} already exists`);
    const id = res.rows[0].id;
    await ensureStrategyAccounts(tx, id, inst.quote_asset);
    await tx.query(
      "INSERT INTO strategy_events (strategy_id, event_type, tick_seq, actor_user_id, details) VALUES ($1, 'created', $2, $3, $4)",
      [id, tick.seq, actorUserId, JSON.stringify({ params, instrument: inst.symbol })],
    );
    await audit(tx, { actorUserId, action: "strategy.create", targetType: "strategy", targetId: id, details: { code: input.code }, ip });
    return id;
  });
}

async function lockStrategy(tx: Tx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Strategy not found");
  const { rows } = await tx.query<{ id: string; status: string; instrument_id: string; max_allocation: string; last_tick_seq: string }>(
    "SELECT id, status, instrument_id, max_allocation::text, last_tick_seq::text FROM strategies WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw notFound("Strategy not found");
  return rows[0];
}

export async function pauseStrategy(db: Db, actorUserId: string, id: string, reason: unknown, ip?: string | null) {
  const text = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "Paused by admin";
  return withTransaction(db, async (tx) => {
    const s = await lockStrategy(tx, id);
    if (s.status === "paused") throw conflict("already_paused", "Strategy is already paused");
    await tx.query("UPDATE strategies SET status = 'paused', pause_reason = $2, paused_at = now() WHERE id = $1", [id, text]);
    await tx.query(
      "INSERT INTO strategy_events (strategy_id, event_type, tick_seq, actor_user_id, details) VALUES ($1, 'paused', $2, $3, $4)",
      [id, s.last_tick_seq, actorUserId, JSON.stringify({ reason: text })],
    );
    await audit(tx, { actorUserId, action: "strategy.pause", targetType: "strategy", targetId: id, details: { reason: text }, ip });
  });
}

/**
 * Resume a paused strategy. Risk baselines (peak equity for drawdown, day
 * start for daily loss) are reset to current equity: the admin explicitly
 * acknowledges the loss that caused any automatic pause.
 */
export async function resumeStrategy(db: Db, actorUserId: string, id: string, ip?: string | null) {
  return withTransaction(db, async (tx) => {
    const s = await lockStrategy(tx, id);
    if (s.status === "active") throw conflict("already_active", "Strategy is already active");
    const equity = (await strategyMetrics(tx, [id]))[0]!.equityRaw;
    await tx.query(
      `UPDATE strategies SET status = 'active', pause_reason = NULL, paused_at = NULL,
              last_equity = $2, peak_equity = $2, day_start_equity = $2 WHERE id = $1`,
      [id, equity.toFixed()],
    );
    await tx.query(
      "INSERT INTO strategy_events (strategy_id, event_type, tick_seq, actor_user_id, details) VALUES ($1, 'resumed', $2, $3, $4)",
      [id, s.last_tick_seq, actorUserId, JSON.stringify({ riskBaselineEquity: equity.toFixed() })],
    );
    await audit(tx, { actorUserId, action: "strategy.resume", targetType: "strategy", targetId: id, ip });
  });
}

/**
 * Allocate simulated PAPER capital to a strategy (never customer funds).
 *   Dr strategy_cash   Cr strategy_capital
 */
export async function allocateCapital(
  db: Db,
  input: { actorUserId: string; strategyId: string; amount: unknown; idempotencyKey: string; ip?: string | null },
) {
  return withTransaction(db, async (tx) => {
    const s = await lockStrategy(tx, input.strategyId);
    const inst = await tx.query<{ quote_asset: string }>("SELECT quote_asset FROM market_instruments WHERE id = $1", [s.instrument_id]);
    const asset = await getAsset(tx, inst.rows[0]!.quote_asset);
    const amount = parseAmount(input.amount, asset.scale);
    return runIdempotent(
      tx,
      {
        userId: input.actorUserId,
        key: input.idempotencyKey,
        operation: "strategy_allocate",
        request: { strategyId: s.id, amount: amount.toFixed() },
      },
      async () => {
        const accounts = await ensureStrategyAccounts(tx, s.id, asset.code);
        const cap = await tx.query<{ balance: string }>("SELECT balance::text FROM ledger_accounts WHERE id = $1", [accounts.capital]);
        const allocated = fromDb(cap.rows[0]!.balance);
        if (allocated.plus(amount).gt(s.max_allocation)) {
          throw unprocessable(
            "allocation_limit",
            `Allocation would exceed the strategy's maximum of ${format(s.max_allocation, asset.scale)} ${asset.code} ` +
              `(currently allocated ${format(allocated, asset.scale)})`,
          );
        }
        const { entryId } = await postEntry(tx, {
          entryType: "strategy_capital_allocation",
          idempotencyKey: `strategy_capital:${s.id}:${input.idempotencyKey}`,
          description: "Simulated paper capital allocated to strategy",
          initiatedBy: input.actorUserId,
          referenceType: "strategy",
          referenceId: s.id,
          metadata: { simulated: true, paperCapital: true },
          postings: [
            { accountId: accounts.cash, direction: "debit", amount },
            { accountId: accounts.capital, direction: "credit", amount },
          ],
        });
        // Capital flows must not look like P&L to the risk monitors.
        await tx.query(
          `UPDATE strategies SET last_equity = last_equity + $2, peak_equity = peak_equity + $2,
                  day_start_equity = day_start_equity + $2 WHERE id = $1`,
          [s.id, amount.toFixed()],
        );
        await tx.query(
          "INSERT INTO strategy_events (strategy_id, event_type, tick_seq, actor_user_id, details) VALUES ($1, 'capital_allocated', $2, $3, $4)",
          [s.id, s.last_tick_seq, input.actorUserId, JSON.stringify({ amount: amount.toFixed(), entryId })],
        );
        await audit(tx, {
          actorUserId: input.actorUserId,
          action: "strategy.allocate",
          targetType: "strategy",
          targetId: s.id,
          details: { amount: amount.toFixed(), entryId },
          ip: input.ip,
        });
        return {
          statusCode: 201,
          body: { entryId, allocatedCapital: format(allocated.plus(amount), asset.scale), asset: asset.code },
        };
      },
    );
  });
}

export async function getKillSwitch(db: Db | Tx) {
  const { rows } = await db.query<{ kill_switch: boolean; kill_switch_reason: string | null; updated_at: Date }>(
    "SELECT kill_switch, kill_switch_reason, updated_at FROM engine_settings",
  );
  const r = rows[0]!;
  return { enabled: r.kill_switch, reason: r.kill_switch_reason, updatedAt: r.updated_at.toISOString() };
}

export async function setKillSwitch(db: Db, actorUserId: string, enabled: unknown, reason: unknown, ip?: string | null) {
  if (typeof enabled !== "boolean") throw unprocessable("invalid_input", "enabled must be a boolean");
  const text = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : null;
  return withTransaction(db, async (tx) => {
    await tx.query(
      "UPDATE engine_settings SET kill_switch = $1, kill_switch_reason = $2, updated_by = $3, updated_at = now()",
      [enabled, enabled ? (text ?? "Engaged by admin") : null, actorUserId],
    );
    await tx.query("INSERT INTO strategy_events (event_type, actor_user_id, details) VALUES ($1, $2, $3)", [
      enabled ? "kill_switch_on" : "kill_switch_off",
      actorUserId,
      JSON.stringify({ reason: text }),
    ]);
    await audit(tx, { actorUserId, action: enabled ? "engine.kill_switch_on" : "engine.kill_switch_off", details: { reason: text }, ip });
    return getKillSwitch(tx);
  });
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

interface MetricsRow {
  id: string;
  code: string;
  name: string;
  description: string;
  strategy_type: StrategyType;
  status: "active" | "paused";
  pause_reason: string | null;
  paused_at: Date | null;
  symbol: string;
  instrument_name: string;
  quote_asset: string;
  scale: number;
  max_allocation: string;
  max_position_value: string;
  max_exposure_ratio: string;
  daily_loss_limit: string;
  max_drawdown_ratio: string;
  params: unknown;
  last_tick_seq: string;
  peak_equity: string;
  day_start_equity: string;
  mark_price: string | null;
  mark_at: Date | null;
  capital: string;
  cash: string;
  position_cost: string;
  gain: string;
  loss: string;
  fees: string;
  quantity: string;
  trade_count: number;
  breach_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function strategyMetrics(db: Db | Tx, ids?: string[]) {
  const { rows } = await db.query<MetricsRow>(
    `SELECT s.id, s.code, s.name, s.description, s.strategy_type, s.status, s.pause_reason, s.paused_at,
            i.symbol, i.name AS instrument_name, i.quote_asset, a.scale,
            s.max_allocation::text, s.max_position_value::text, s.max_exposure_ratio::text, s.daily_loss_limit::text,
            s.max_drawdown_ratio::text, s.params, s.last_tick_seq::text, s.peak_equity::text, s.day_start_equity::text,
            t.price::text AS mark_price, t.simulated_at AS mark_at,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_capital'), 0)::text AS capital,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_cash'), 0)::text AS cash,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_position'), 0)::text AS position_cost,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_realised_gain'), 0)::text AS gain,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_realised_loss'), 0)::text AS loss,
            COALESCE(sum(la.balance) FILTER (WHERE la.purpose = 'strategy_fees'), 0)::text AS fees,
            COALESCE((SELECT quantity FROM strategy_positions p WHERE p.strategy_id = s.id AND p.instrument_id = s.instrument_id), 0)::text AS quantity,
            (SELECT count(*)::int FROM strategy_trades st WHERE st.strategy_id = s.id) AS trade_count,
            (SELECT count(*)::int FROM strategy_events se WHERE se.strategy_id = s.id AND se.event_type = 'risk_breach') AS breach_count,
            s.created_at, s.updated_at
       FROM strategies s
       JOIN market_instruments i ON i.id = s.instrument_id
       JOIN assets a ON a.code = i.quote_asset
       LEFT JOIN market_ticks t ON t.instrument_id = s.instrument_id AND t.seq = s.last_tick_seq
       LEFT JOIN ledger_accounts la ON la.owner_strategy_id = s.id
      WHERE ($1::uuid[] IS NULL OR s.id = ANY($1::uuid[]))
      GROUP BY s.id, i.id, a.scale, t.price, t.simulated_at
      ORDER BY s.code`,
    [ids ?? null],
  );
  return rows.map((r) => {
    const q = r.scale;
    const f = (v: Money) => format(v, q);
    const qty = fromDb(r.quantity);
    const mark = fromDb(r.mark_price ?? "0");
    const cash = fromDb(r.cash);
    const cost = fromDb(r.position_cost);
    const capital = fromDb(r.capital);
    const positionValue = down(qty.times(mark), q);
    const equity = cash.plus(positionValue);
    const realised = fromDb(r.gain).minus(fromDb(r.loss));
    const fees = fromDb(r.fees);
    const unrealised = positionValue.minus(cost);
    const peak = Money.max(fromDb(r.peak_equity), equity);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      type: r.strategy_type,
      status: r.status,
      pauseReason: r.pause_reason,
      pausedAt: r.paused_at?.toISOString() ?? null,
      simulated: true as const,
      instrument: { symbol: r.symbol, name: r.instrument_name },
      asset: r.quote_asset,
      limits: {
        maxAllocation: f(fromDb(r.max_allocation)),
        maxPositionValue: f(fromDb(r.max_position_value)),
        maxExposureRatio: r.max_exposure_ratio,
        dailyLossLimit: f(fromDb(r.daily_loss_limit)),
        maxDrawdownRatio: r.max_drawdown_ratio,
      },
      params: r.params,
      lastTickSeq: r.last_tick_seq,
      markPrice: r.mark_price,
      markSimulatedAt: r.mark_at?.toISOString() ?? null,
      allocatedCapital: f(capital),
      cash: f(cash),
      positionQty: qty.toFixed(),
      costBasis: f(cost),
      positionValue: f(positionValue),
      equity: f(equity),
      equityRaw: equity,
      realisedGain: f(fromDb(r.gain)),
      realisedLoss: f(fromDb(r.loss)),
      realisedPnl: f(realised),
      fees: f(fees),
      unrealisedPnl: f(unrealised),
      netPnl: f(equity.minus(capital)),
      exposureRatio: equity.gt(0) ? positionValue.div(equity).toFixed(6) : "0.000000",
      peakEquity: f(peak),
      drawdownRatio: drawdownRatio(peak, equity).toFixed(6),
      dayPnl: f(equity.minus(fromDb(r.day_start_equity))),
      tradeCount: r.trade_count,
      breachCount: r.breach_count,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  });
}

export async function listStrategies(db: Db) {
  return (await strategyMetrics(db)).map(({ equityRaw: _e, ...rest }) => rest);
}

export async function getStrategyDetail(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Strategy not found");
  const metrics = (await strategyMetrics(db, [id]))[0];
  if (!metrics) throw notFound("Strategy not found");
  const { equityRaw: _e, ...strategy } = metrics;
  const [trades, events, series] = await Promise.all([
    db.query(
      `SELECT id, tick_seq::text AS "tickSeq", seq_in_tick AS "seqInTick", side, reason, quantity::text, mid_price::text AS "midPrice",
              exec_price::text AS "execPrice", notional::text, fee::text, slippage_cost::text AS "slippageCost",
              realised_pnl::text AS "realisedPnl", position_qty_after::text AS "positionQtyAfter", entry_id AS "entryId",
              created_at AS "createdAt"
         FROM strategy_trades WHERE strategy_id = $1 ORDER BY tick_seq DESC, seq_in_tick DESC LIMIT 200`,
      [id],
    ),
    db.query(
      `SELECT id::text, event_type AS "eventType", tick_seq::text AS "tickSeq", details, actor_user_id AS "actorUserId",
              created_at AS "createdAt"
         FROM strategy_events WHERE strategy_id = $1 ORDER BY id DESC LIMIT 200`,
      [id],
    ),
    db.query(
      `SELECT tick_seq::text AS "tickSeq", price::text, equity::text, drawdown_ratio::text AS "drawdownRatio", status_after AS "status"
         FROM (SELECT * FROM strategy_tick_results WHERE strategy_id = $1 ORDER BY tick_seq DESC LIMIT 240) r
        ORDER BY tick_seq`,
      [id],
    ),
  ]);
  return { strategy, trades: trades.rows, events: events.rows, equitySeries: series.rows };
}

export async function listRuns(db: Db, limit = 20) {
  const { rows } = await db.query(
    `SELECT id, trigger, status, ticks_processed AS "ticksProcessed", trades, error, started_at AS "startedAt",
            finished_at AS "finishedAt" FROM strategy_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
