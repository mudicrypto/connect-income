import type { Db, Tx } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import { badRequest, notFound } from "../lib/errors.js";
import { format } from "../lib/money.js";
import { nextPrice, type GeneratorParams } from "./generator.js";

export interface InstrumentRow {
  id: string;
  symbol: string;
  name: string;
  description: string;
  kind: "spot" | "staking" | "lending";
  quote_asset: string;
  data_source: "synthetic_generator" | "synthetic_scripted";
  price_scale: number;
  quantity_scale: number;
  fee_bps: string;
  slippage_bps: string;
  tick_interval_minutes: number;
  genesis_at: Date;
  seed: string | null;
  start_price: string | null;
  drift_bps: string | null;
  volatility_bps: string | null;
  shock_probability: string | null;
  shock_bps: string | null;
}

const INSTRUMENT_COLUMNS = `id, symbol, name, description, kind, quote_asset, data_source, price_scale, quantity_scale,
  fee_bps::text, slippage_bps::text, tick_interval_minutes, genesis_at, seed, start_price::text, drift_bps::text,
  volatility_bps::text, shock_probability::text, shock_bps::text`;

export async function getInstrument(db: Db | Tx, id: string): Promise<InstrumentRow> {
  const { rows } = await db.query<InstrumentRow>(`SELECT ${INSTRUMENT_COLUMNS} FROM market_instruments WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound("Instrument not found");
  return rows[0];
}

export async function getInstrumentBySymbol(db: Db | Tx, symbol: string): Promise<InstrumentRow> {
  const { rows } = await db.query<InstrumentRow>(`SELECT ${INSTRUMENT_COLUMNS} FROM market_instruments WHERE symbol = $1`, [
    symbol,
  ]);
  if (!rows[0]) throw notFound(`Instrument ${symbol} not found`);
  return rows[0];
}

function generatorParams(i: InstrumentRow): GeneratorParams {
  if (i.data_source !== "synthetic_generator") throw new Error(`${i.symbol} is not generator-driven`);
  return {
    seed: i.seed!,
    startPrice: i.start_price!,
    driftBps: i.drift_bps!,
    volatilityBps: i.volatility_bps!,
    shockProbability: i.shock_probability!,
    shockBps: i.shock_bps!,
    priceScale: i.price_scale,
  };
}

export interface TickRow {
  id: string;
  seq: string;
  simulated_at: Date;
  price: string;
}

export async function latestTick(db: Db | Tx, instrumentId: string): Promise<TickRow | null> {
  const { rows } = await db.query<TickRow>(
    // ORDER BY the table column (t.seq), not the text-cast output column of the same name.
    `SELECT t.id::text, t.seq::text, t.simulated_at, t.price::text FROM market_ticks t
      WHERE t.instrument_id = $1 ORDER BY t.seq DESC LIMIT 1`,
    [instrumentId],
  );
  return rows[0] ?? null;
}

/**
 * Append `count` synthetic ticks to a generator-driven instrument (creating
 * the genesis tick first if needed). Serialised per instrument with an
 * advisory lock; uniqueness of (instrument, seq) is the backstop.
 */
export async function generateTicks(db: Db, instrumentId: string, count: number): Promise<{ fromSeq: number; toSeq: number }> {
  return withTransaction(db, (tx) => generateTicksTx(tx, instrumentId, count));
}

/** Same as generateTicks, inside the caller's transaction. */
export async function generateTicksTx(tx: Tx, instrumentId: string, count: number): Promise<{ fromSeq: number; toSeq: number }> {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw badRequest("invalid_ticks", "ticks must be 1..10000");
  {
    const inst = await getInstrument(tx, instrumentId);
    const params = generatorParams(inst);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('market_ticks:' || $1))", [instrumentId]);
    const last = await latestTick(tx, instrumentId);
    let seq = last ? BigInt(last.seq) : -1n;
    let price = last ? last.price : params.startPrice;
    const fromSeq = Number(seq + 1n);
    const seqs: string[] = [];
    const prices: string[] = [];
    const times: Date[] = [];
    for (let i = 0; i < count; i++) {
      seq += 1n;
      if (seq > 0n) price = nextPrice(price, params, seq).toFixed(inst.price_scale);
      else price = format(params.startPrice, inst.price_scale);
      seqs.push(seq.toString());
      prices.push(price);
      times.push(new Date(inst.genesis_at.getTime() + Number(seq) * inst.tick_interval_minutes * 60_000));
    }
    await tx.query(
      `INSERT INTO market_ticks (instrument_id, seq, simulated_at, price)
       SELECT $1, s::bigint, t, p::numeric FROM unnest($2::text[], $3::timestamptz[], $4::text[]) AS u(s, t, p)`,
      [instrumentId, seqs, times, prices],
    );
    return { fromSeq, toSeq: Number(seq) };
  }
}

/** Advance every generator-driven instrument by `count` ticks, atomically. */
export async function advanceMarket(db: Db, count: number) {
  return withTransaction(db, (tx) => advanceMarketTx(tx, count));
}

export async function advanceMarketTx(tx: Tx, count: number) {
  const { rows } = await tx.query<{ id: string; symbol: string }>(
    "SELECT id, symbol FROM market_instruments WHERE data_source = 'synthetic_generator' ORDER BY symbol",
  );
  const results = [];
  for (const r of rows) results.push({ symbol: r.symbol, ...(await generateTicksTx(tx, r.id, count)) });
  return results;
}

/** Insert explicit simulated prices (scripted scenarios, tests). */
export async function appendScriptedTicks(db: Db, instrumentId: string, prices: string[]) {
  return withTransaction(db, async (tx) => {
    const inst = await getInstrument(tx, instrumentId);
    if (inst.data_source !== "synthetic_scripted") throw new Error(`${inst.symbol} is generator-driven`);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('market_ticks:' || $1))", [instrumentId]);
    const last = await latestTick(tx, instrumentId);
    let seq = last ? BigInt(last.seq) : -1n;
    for (const price of prices) {
      seq += 1n;
      await tx.query("INSERT INTO market_ticks (instrument_id, seq, simulated_at, price) VALUES ($1, $2, $3, $4)", [
        instrumentId,
        seq.toString(),
        new Date(inst.genesis_at.getTime() + Number(seq) * inst.tick_interval_minutes * 60_000),
        price,
      ]);
    }
    return Number(seq);
  });
}

export async function listInstruments(db: Db) {
  const { rows } = await db.query<{
    id: string;
    symbol: string;
    name: string;
    description: string;
    kind: string;
    data_source: string;
    fee_bps: string;
    slippage_bps: string;
    tick_interval_minutes: number;
    latest_seq: string | null;
    latest_price: string | null;
    latest_at: Date | null;
  }>(`
    SELECT i.id, i.symbol, i.name, i.description, i.kind, i.data_source, i.fee_bps::text, i.slippage_bps::text,
           i.tick_interval_minutes, t.seq::text AS latest_seq, t.price::text AS latest_price, t.simulated_at AS latest_at
      FROM market_instruments i
      LEFT JOIN LATERAL (SELECT seq, price, simulated_at FROM market_ticks WHERE instrument_id = i.id ORDER BY seq DESC LIMIT 1) t ON TRUE
     ORDER BY i.symbol`);
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    description: r.description,
    kind: r.kind,
    dataSource: r.data_source,
    simulated: true as const,
    feeBps: r.fee_bps,
    slippageBps: r.slippage_bps,
    tickIntervalMinutes: r.tick_interval_minutes,
    latestSeq: r.latest_seq,
    latestPrice: r.latest_price,
    latestSimulatedAt: r.latest_at?.toISOString() ?? null,
  }));
}

export async function recentPrices(db: Db, instrumentId: string, limit = 200) {
  const { rows } = await db.query<{ seq: string; price: string; simulated_at: Date }>(
    `SELECT t.seq::text, t.price::text, t.simulated_at FROM market_ticks t WHERE t.instrument_id = $1 ORDER BY t.seq DESC LIMIT $2`,
    [instrumentId, limit],
  );
  return rows.reverse().map((r) => ({ seq: r.seq, price: r.price, simulatedAt: r.simulated_at.toISOString() }));
}
