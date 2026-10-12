import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { Money } from "../src/lib/money.js";
import { nextPrice } from "../src/market/generator.js";
import { appendScriptedTicks, generateTicks, getInstrumentBySymbol, latestTick } from "../src/market/market.js";
import { getUserBalances } from "../src/services/accounts.js";
import { processTick, runEngine } from "../src/strategy/engine.js";
import {
  allocateCapital,
  getStrategyDetail,
  pauseStrategy,
  resumeStrategy,
  setKillSwitch,
} from "../src/strategy/strategies.js";
import { createTestUser, fund, key, testDb } from "./helpers.js";
import { MOMENTUM_1, makeStrategy, scriptedInstrument, strategyAccountBalances, trades } from "./strategy-helpers.js";

const db = testDb();
let adminId: string;
beforeAll(async () => {
  adminId = (await createTestUser(db, "admin")).id;
});
afterAll(() => db.end());

const run = (strategyIds: string[], extra: Partial<Parameters<typeof runEngine>[1]> = {}) =>
  runEngine(db, { trigger: "test", strategyIds, ...extra });
const expectLedgerOk = async () => expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
const strategyRow = async (id: string) =>
  (await db.query("SELECT status, pause_reason, last_tick_seq::text FROM strategies WHERE id = $1", [id])).rows[0];

describe("paper trading P&L", () => {
  it("books a profitable trade into separate gain and fee accounts", async () => {
    const inst = await scriptedInstrument(db, { feeBps: "10" });
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params: MOMENTUM_1 });
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]);
    const summary = await run([id]);
    expect(summary).toMatchObject({ status: "completed", ticksProcessed: 3, trades: 2 });

    const t = await trades(db, id);
    expect(t.map((r) => [r.tick_seq, r.side, r.reason, r.quantity])).toEqual([
      ["1", "buy", "signal", "48.9706372"],
      ["3", "sell", "signal", "48.9706372"],
    ]);
    expect(t[1]!.realised_pnl).toBe("146.911911");
    // Values below were computed independently with Python's decimal module.
    expect(await strategyAccountBalances(db, id)).toEqual({
      strategy_capital: "10000",
      strategy_cash: "10136.774989",
      strategy_position: "0",
      strategy_realised_gain: "146.911911",
      strategy_realised_loss: "0",
      strategy_fees: "10.136922",
      strategy_distributions: "0",
    });
    const { strategy } = await getStrategyDetail(db, id);
    expect(strategy).toMatchObject({
      simulated: true,
      realisedPnl: "146.911911",
      fees: "10.136922",
      netPnl: "136.774989",
      unrealisedPnl: "0.000000",
      equity: "10136.774989",
    });
    await expectLedgerOk();
  });

  it("books a losing trade into the realised loss account", async () => {
    const inst = await scriptedInstrument(db, { feeBps: "10" });
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params: MOMENTUM_1 });
    await appendScriptedTicks(db, inst.id, ["102", "95"]);
    await run([id]);
    expect(await strategyAccountBalances(db, id)).toEqual({
      strategy_capital: "10000",
      strategy_cash: "9647.558323",
      strategy_position: "0",
      strategy_realised_gain: "0",
      strategy_realised_loss: "342.794461",
      strategy_fees: "9.647216",
      strategy_distributions: "0",
    });
    await expectLedgerOk();
  });

  it("reports unrealised P&L on open positions without booking it", async () => {
    const inst = await scriptedInstrument(db, { feeBps: "0" });
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    await appendScriptedTicks(db, inst.id, ["102", "110"]); // buy at 102, mark at 110
    await run([id]);
    const { strategy } = await getStrategyDetail(db, id);
    expect(strategy.costBasis).toBe("500.000000"); // 4.90196078 units * 102, rounded up
    expect(new Money(strategy.unrealisedPnl).gt(0)).toBe(true);
    expect(strategy.realisedPnl).toBe("0.000000");
    expect((await strategyAccountBalances(db, id)).strategy_realised_gain).toBe("0");
    await expectLedgerOk();
  });

  it("charges slippage through the execution price", async () => {
    const inst = await scriptedInstrument(db, { feeBps: "0", slippageBps: "50" });
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    await appendScriptedTicks(db, inst.id, ["102", "102", "90"]);
    await run([id]);
    const t = await trades(db, id);
    expect(t[0]!.exec_price).toBe("102.51"); // 102 * 1.005
    expect(t[1]!.exec_price).toBe("89.55"); // 90 * 0.995
    expect(new Money(t[0]!.slippage_cost!).gt(0)).toBe(true);
    await expectLedgerOk();
  });

  it("never touches customer balances", async () => {
    const user = await createTestUser(db);
    await fund(db, user.id, "777");
    const inst = await scriptedInstrument(db);
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "5000", params: MOMENTUM_1 });
    await appendScriptedTicks(db, inst.id, ["102", "120", "100"]);
    await run([id]);
    expect((await trades(db, id)).length).toBe(2);
    expect((await getUserBalances(db, user.id))[0]).toMatchObject({ available: "777.000000", invested: "0.000000" });
    await expectLedgerOk();
  });
});

describe("capital allocation", () => {
  it("enforces the maximum allocation and is idempotent", async () => {
    const inst = await scriptedInstrument(db);
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, limits: { maxAllocation: "10000" } });
    const k = key();
    await allocateCapital(db, { actorUserId: adminId, strategyId: id, amount: "6000", idempotencyKey: k });
    const replay = await allocateCapital(db, { actorUserId: adminId, strategyId: id, amount: "6000", idempotencyKey: k });
    expect(replay.replayed).toBe(true);
    await expect(allocateCapital(db, { actorUserId: adminId, strategyId: id, amount: "4000.000001", idempotencyKey: key() })).rejects.toThrow(
      /maximum/,
    );
    await allocateCapital(db, { actorUserId: adminId, strategyId: id, amount: "4000", idempotencyKey: key() });
    expect((await strategyAccountBalances(db, id)).strategy_capital).toBe("10000");
    await expectLedgerOk();
  });
});

describe("risk controls", () => {
  it("clips buys to position and exposure limits, verified post-trade", async () => {
    const inst = await scriptedInstrument(db, { kind: "staking", feeBps: "10", slippageBps: "10" });
    const id = await makeStrategy(db, adminId, {
      type: "staking",
      instrumentSymbol: inst.symbol,
      capital: "10000",
      params: { targetExposure: "0.9", rebalanceBand: "0.01", minTradeValue: "1" },
      limits: { maxPositionValue: "3000", maxExposureRatio: "0.5" },
    });
    await appendScriptedTicks(db, inst.id, ["100", "101", "102", "103", "104", "130", "135"]);
    await run([id]);
    const t = await trades(db, id);
    expect(t.length).toBeGreaterThan(0);
    // At every trade, post-trade value at mid is within both limits.
    const results = await db.query(
      `SELECT r.position_value::text, r.equity::text FROM strategy_tick_results r WHERE r.strategy_id = $1 AND r.trades > 0`,
      [id],
    );
    for (const r of results.rows) {
      expect(new Money(r.position_value).lte(3000)).toBe(true);
      expect(new Money(r.position_value).lte(new Money(r.equity).times("0.5"))).toBe(true);
    }
    const events = await db.query("SELECT event_type, details FROM strategy_events WHERE strategy_id = $1 ORDER BY id", [id]);
    const clipped = events.rows.find((e) => e.event_type === "order_clipped");
    expect(clipped?.details.limitedBy).toContain("max_position_value");
    await expectLedgerOk();
  });

  it("auto-pauses and liquidates on a max drawdown breach, then opens nothing new", async () => {
    const inst = await scriptedInstrument(db, { kind: "staking", feeBps: "10" });
    const id = await makeStrategy(db, adminId, {
      type: "staking",
      instrumentSymbol: inst.symbol,
      capital: "10000",
      params: { targetExposure: "0.9", rebalanceBand: "0.05", minTradeValue: "1" },
      limits: { maxDrawdownRatio: "0.1" },
    });
    await appendScriptedTicks(db, inst.id, ["100", "85", "90", "95"]);
    await run([id]);
    const s = await strategyRow(id);
    expect(s.status).toBe("paused");
    expect(s.pause_reason).toMatch(/max_drawdown/);
    const t = await trades(db, id);
    expect(t.map((r) => [r.tick_seq, r.side, r.reason])).toEqual([
      ["1", "buy", "rebalance"],
      ["2", "sell", "risk_liquidation"],
    ]);
    const notes = await db.query("SELECT note FROM strategy_tick_results WHERE strategy_id = $1 AND tick_seq > 2", [id]);
    expect(notes.rows.every((r) => r.note === "buy_blocked:paused")).toBe(true);
    const breach = await db.query("SELECT details FROM strategy_events WHERE strategy_id = $1 AND event_type = 'risk_breach'", [id]);
    expect(breach.rows[0].details).toMatchObject({ limit: "max_drawdown", liquidated: true });
    await expectLedgerOk();
  });

  it("auto-pauses on a daily loss limit breach", async () => {
    const inst = await scriptedInstrument(db, { kind: "staking", feeBps: "0" });
    const id = await makeStrategy(db, adminId, {
      type: "staking",
      instrumentSymbol: inst.symbol,
      capital: "10000",
      params: { targetExposure: "0.9", rebalanceBand: "0.05", minTradeValue: "1" },
      limits: { dailyLossLimit: "500", maxDrawdownRatio: "0.5" },
    });
    await appendScriptedTicks(db, inst.id, ["100", "94"]);
    await run([id]);
    const s = await strategyRow(id);
    expect(s.status).toBe("paused");
    expect(s.pause_reason).toMatch(/daily_loss/);
    await expectLedgerOk();
  });

  it("a paused strategy opens no new positions; resume re-baselines and trades again", async () => {
    const inst = await scriptedInstrument(db);
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    await pauseStrategy(db, adminId, id, "maintenance");
    await appendScriptedTicks(db, inst.id, ["102"]); // entry signal
    await run([id]);
    expect(await trades(db, id)).toEqual([]);
    const note = await db.query("SELECT note FROM strategy_tick_results WHERE strategy_id = $1", [id]);
    expect(note.rows[0].note).toBe("buy_blocked:paused");
    await expect(pauseStrategy(db, adminId, id, "again")).rejects.toThrow(/already paused/);

    await resumeStrategy(db, adminId, id);
    await appendScriptedTicks(db, inst.id, ["104"]); // another entry signal
    await run([id]);
    expect((await trades(db, id)).map((r) => r.side)).toEqual(["buy"]);
    await expectLedgerOk();
  });

  it("the global kill switch blocks new positions but allows exits", async () => {
    const inst = await scriptedInstrument(db);
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    await appendScriptedTicks(db, inst.id, ["102"]); // buy
    await run([id]);
    try {
      await setKillSwitch(db, adminId, true, "test");
      await appendScriptedTicks(db, inst.id, ["90", "92"]); // exit signal, then (flat) entry signal
      await run([id]);
    } finally {
      await setKillSwitch(db, adminId, false, null);
    }
    expect((await trades(db, id)).map((r) => [r.tick_seq, r.side])).toEqual([
      ["1", "buy"],
      ["2", "sell"],
    ]);
    const note = await db.query("SELECT note FROM strategy_tick_results WHERE strategy_id = $1 AND tick_seq = 3", [id]);
    expect(note.rows[0].note).toBe("buy_blocked:kill_switch");
    await expectLedgerOk();
  });
});

describe("processing guarantees", () => {
  /** A long deterministic scripted series so strategies trade many times. */
  async function longSeries(instrumentId: string, n: number) {
    const p = { seed: "engine-test", startPrice: "100", driftBps: "0", volatilityBps: "150", shockProbability: "0.02", shockBps: "400", priceScale: 8 };
    const prices: string[] = [];
    let price = new Money("100");
    for (let seq = 1; seq <= n; seq++) {
      price = nextPrice(price, p, seq);
      prices.push(price.toFixed(8));
    }
    await appendScriptedTicks(db, instrumentId, prices);
  }
  const params = { lookbackTicks: 3, entryThresholdBps: 100, exitThresholdBps: -80, targetExposure: "0.6", minTradeValue: "5" };
  const comparable = async (id: string) => (await trades(db, id)).map((r) => [r.tick_seq, r.side, r.quantity, r.exec_price, r.realised_pnl]);

  it("never processes the same tick twice, even when asked to", async () => {
    const inst = await scriptedInstrument(db);
    const id = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    await appendScriptedTicks(db, inst.id, ["102", "95"]);
    expect((await run([id])).ticksProcessed).toBe(2);
    expect((await run([id])).ticksProcessed).toBe(0);
    const tick = await db.query("SELECT id::text FROM market_ticks WHERE instrument_id = $1 AND seq = 1", [inst.id]);
    expect(await processTick(db, id, tick.rows[0].id, null)).toEqual({ processed: false, trades: 0 });
    await expect(
      db.query(
        `INSERT INTO strategy_tick_results (strategy_id, tick_id, tick_seq, status_after, price, cash, position_qty, position_value,
           cost_basis, equity, peak_equity, drawdown_ratio, day_pnl) VALUES ($1, $2, 1, 'active', 1, 0, 0, 0, 0, 0, 0, 0, 0)`,
        [id, tick.rows[0].id],
      ),
    ).rejects.toThrow(/strategy_tick_results_once/);
    expect((await trades(db, id)).length).toBe(2);
    await expectLedgerOk();
  });

  it("concurrent runs produce exactly the same result as a single run", async () => {
    const inst = await scriptedInstrument(db, { feeBps: "10", slippageBps: "5" });
    const reference = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params });
    const concurrent = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params });
    await longSeries(inst.id, 80);

    await run([reference]);
    const results = await Promise.all(Array.from({ length: 4 }, () => run([concurrent])));
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(results.reduce((n, r) => n + r.ticksProcessed, 0)).toBe(80);

    const ref = await comparable(reference);
    expect(ref.length).toBeGreaterThan(4);
    expect(await comparable(concurrent)).toEqual(ref);
    const counts = await db.query("SELECT count(*)::int AS n FROM strategy_tick_results WHERE strategy_id = $1", [concurrent]);
    expect(counts.rows[0].n).toBe(80);
    await expectLedgerOk();
  });

  it("recovers after an interrupted run without duplicates or partial ticks", async () => {
    const inst = await scriptedInstrument(db, { feeBps: "10", slippageBps: "5" });
    const reference = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params });
    const victim = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params });
    await longSeries(inst.id, 60);
    await run([reference]);

    const crashed = await run([victim], {
      faultInjector: ({ tickSeq }) => {
        if (tickSeq === 37) throw new Error("simulated crash");
      },
    });
    expect(crashed).toMatchObject({ status: "failed", ticksProcessed: 36, error: "simulated crash" });
    expect((await strategyRow(victim)).last_tick_seq).toBe("36");
    const partial = await db.query("SELECT count(*)::int AS n FROM strategy_trades WHERE strategy_id = $1 AND tick_seq >= 37", [victim]);
    expect(partial.rows[0].n).toBe(0);
    const runRow = await db.query("SELECT status, error FROM strategy_runs WHERE id = $1", [crashed.runId]);
    expect(runRow.rows[0]).toEqual({ status: "failed", error: "simulated crash" });
    await expectLedgerOk();

    const resumed = await run([victim]);
    expect(resumed).toMatchObject({ status: "completed", ticksProcessed: 24 });
    expect(await comparable(victim)).toEqual(await comparable(reference));
    await expectLedgerOk();
  });

  it("marks runs abandoned when their process died", async () => {
    const { rows } = await db.query(
      "INSERT INTO strategy_runs (trigger, heartbeat_at) VALUES ('test', now() - interval '1 hour') RETURNING id",
    );
    await run([]);
    const r = await db.query("SELECT status FROM strategy_runs WHERE id = $1", [rows[0].id]);
    expect(r.rows[0].status).toBe("abandoned");
  });
});

describe("synthetic market data", () => {
  it("generates the same series regardless of batching, and is append-only", async () => {
    const inst = await getInstrumentBySymbol(db, "SIM-BTC-USDT");
    await generateTicks(db, inst.id, 10);
    await generateTicks(db, inst.id, 15);
    const stored = await db.query("SELECT seq::int, price::text FROM market_ticks WHERE instrument_id = $1 ORDER BY seq LIMIT 25", [inst.id]);
    const p = {
      seed: inst.seed!,
      startPrice: inst.start_price!,
      driftBps: inst.drift_bps!,
      volatilityBps: inst.volatility_bps!,
      shockProbability: inst.shock_probability!,
      shockBps: inst.shock_bps!,
      priceScale: inst.price_scale,
    };
    let price = new Money(p.startPrice);
    for (const row of stored.rows) {
      if (row.seq > 0) price = nextPrice(price, p, row.seq);
      expect(new Money(row.price).eq(price)).toBe(true);
    }
    // Regression: latest tick must be chosen numerically, not by text ("9" > "24").
    const max = await db.query("SELECT max(seq)::text AS s FROM market_ticks WHERE instrument_id = $1", [inst.id]);
    expect(Number(max.rows[0].s)).toBeGreaterThanOrEqual(24);
    expect((await latestTick(db, inst.id))!.seq).toBe(max.rows[0].s);
    await expect(db.query("UPDATE market_ticks SET price = 1 WHERE instrument_id = $1", [inst.id])).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE market_instruments SET fee_bps = 0 WHERE id = $1", [inst.id])).rejects.toThrow(/append-only/);
  });

  it("rejects instruments not labelled as simulated", async () => {
    await expect(
      db.query(
        `INSERT INTO market_instruments (symbol, name, description, kind, quote_asset, data_source, fee_bps, slippage_bps,
           tick_interval_minutes, genesis_at, is_simulated)
         VALUES ('BTC-USDT', 'x', 'x', 'spot', 'USDT', 'synthetic_scripted', 0, 0, 60, now(), true)`,
      ),
    ).rejects.toThrow(/symbol_check/);
    await expect(
      db.query(
        `INSERT INTO market_instruments (symbol, name, description, kind, quote_asset, data_source, fee_bps, slippage_bps,
           tick_interval_minutes, genesis_at, is_simulated)
         VALUES ('SIM-REAL', 'x', 'x', 'spot', 'USDT', 'synthetic_scripted', 0, 0, 60, now(), false)`,
      ),
    ).rejects.toThrow(/is_simulated_check/);
  });

  it("strategy history is append-only", async () => {
    const row = await db.query("SELECT id FROM strategy_trades LIMIT 1");
    await expect(db.query("UPDATE strategy_trades SET fee = 0 WHERE id = $1", [row.rows[0].id])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM strategy_events")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM strategies")).rejects.toThrow(/cannot be deleted/);
  });
});
