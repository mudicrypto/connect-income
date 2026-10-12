import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { Money } from "../src/lib/money.js";
import { assignProductToPool, updatePool } from "../src/rewards/pools.js";
import { calculateRun, cancelRun, postRun } from "../src/rewards/runs.js";
import { poolSettlementView, settlePoolReserves, switchToInvestmentModel } from "../src/rewards/settlement.js";
import { getUserBalances } from "../src/services/accounts.js";
import { settleMaturedInvestments } from "../src/services/investments.js";
import { createTestProduct, createTestUser, fund, key, makeApp, sessionCookie, testDb } from "./helpers.js";
import { at, backdatedCapital, backdatedInvestment, backdatedPool, backdatedRoundTrip, utcMidnight } from "./history-fixtures.js";
import { MOMENTUM_1, makeStrategy, registerLegacyV1Pool, scriptedInstrument } from "./strategy-helpers.js";

const db = testDb();
let adminId: string;
beforeAll(async () => {
  adminId = (await createTestUser(db, "admin")).id;
});
afterAll(() => db.end());

const expectLedgerOk = async () => expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
const usdt = async (userId: string) => (await getUserBalances(db, userId)).find((b) => b.asset === "USDT")!;
const runRow = async (id: string) => (await db.query("SELECT * FROM reward_runs WHERE id = $1", [id])).rows[0];
const s6 = (v: unknown) => new Money(String(v)).toFixed(6);
const line = async (runId: string, investmentId: string) => {
  const r = (await db.query("SELECT * FROM reward_run_lines WHERE run_id = $1 AND investment_id = $2", [runId, investmentId])).rows[0];
  return r && {
    n: s6(r.attributable),
    rec: s6(r.loss_recovered),
    e: s6(r.eligible),
    q: s6(r.reserve_contribution),
    reward: s6(r.reward),
    L: s6(r.loss_close),
    V: s6(r.reserve_close),
    r: s6(r.reserve_applied),
  };
};
const calcPost = async (poolId: string) => {
  const id = await calculateRun(db, adminId, { poolStrategyId: poolId });
  await postRun(db, adminId, id);
  return id;
};

async function strategyAndInstrument() {
  const inst = await scriptedInstrument(db);
  const strategyId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, params: MOMENTUM_1 });
  return { inst, strategyId };
}
async function funded() {
  const u = await createTestUser(db);
  await fund(db, u.id, "10000");
  return u.id;
}

describe("per-investment loss recovery on daily UTC periods (worked example of rewards-accounting-v2.md)", () => {
  let poolId: string;
  let alice: { user: string; inv: string };
  let bob: { user: string; inv: string };
  const runs: string[] = [];

  beforeAll(async () => {
    const { inst, strategyId } = await strategyAndInstrument();
    poolId = strategyId;
    await backdatedCapital(db, strategyId, "10000", at(-4, 5));
    await backdatedPool(db, adminId, strategyId, { startAt: at(-4, 6), capacity: "10000", periodMode: "daily_utc" });
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId });
    const a = await funded();
    const b = await funded();
    alice = { user: a, inv: await backdatedInvestment(db, { userId: a, productId, poolId, amount: "5000", startAt: at(-4, 6), maturityAt: at(-1, 12) }) };
    bob = { user: b, inv: await backdatedInvestment(db, { userId: b, productId, poolId, amount: "5000", startAt: at(-2, 0), maturityAt: at(5, 0) }) };
    await backdatedRoundTrip(db, strategyId, inst.id, at(-3, 12), "1000", "800"); // day -3: R = -200
    await backdatedRoundTrip(db, strategyId, inst.id, at(-2, 12), "1000", "1300"); // day -2: R = +300
    await backdatedRoundTrip(db, strategyId, inst.id, at(-1, 6), "1000", "900"); // day -1: R = -100
  });

  it("aligns the first period to UTC midnight, then runs one closed UTC day per run", async () => {
    runs.push(await calcPost(poolId));
    const stub = await runRow(runs[0]!);
    expect(stub.period_start.getTime()).toBe(at(-4, 6).getTime());
    expect(stub.period_end.getTime()).toBe(utcMidnight(-3).getTime());
    expect(stub.loss_model).toBe("investment_v2");
    expect(s6(stub.net_realised)).toBe("0.000000");
  });

  it("charges the existing investor for a loss during her participation", async () => {
    runs.push(await calcPost(poolId));
    expect((await runRow(runs[1]!)).period_end.getTime()).toBe(utcMidnight(-2).getTime());
    expect(await line(runs[1]!, alice.inv)).toMatchObject({ n: "-100.000000", L: "100.000000", reward: "0.000000" });
    expect(await line(runs[1]!, bob.inv)).toBeUndefined(); // Bob had not joined yet
  });

  it("a new investor is not charged for losses before he joined; the existing investor recovers her own first", async () => {
    runs.push(await calcPost(poolId));
    expect(await line(runs[2]!, alice.inv)).toEqual({ n: "150.000000", rec: "100.000000", e: "50.000000", q: "5.000000", reward: "45.000000", L: "0.000000", V: "5.000000", r: "0.000000" });
    expect(await line(runs[2]!, bob.inv)).toEqual({ n: "150.000000", rec: "0.000000", e: "150.000000", q: "15.000000", reward: "135.000000", L: "0.000000", V: "15.000000", r: "0.000000" });
    expect(await usdt(alice.user)).toMatchObject({ rewardPending: "45.000000" });
    expect(await usdt(bob.user)).toMatchObject({ rewardPending: "135.000000" });
    await expectLedgerOk();
  });

  it("partial participation: each investment's own reserve absorbs its own share of a later loss", async () => {
    runs.push(await calcPost(poolId));
    // Alice participated half of day -1 (matured at 12:00): n = floor(-100 x 2,500/10,000) = -25.
    expect(await line(runs[3]!, alice.inv)).toMatchObject({ n: "-25.000000", r: "5.000000", L: "20.000000", V: "0.000000" });
    expect(await line(runs[3]!, bob.inv)).toMatchObject({ n: "-50.000000", r: "15.000000", L: "35.000000", V: "0.000000" });
    const r3 = await runRow(runs[3]!);
    expect(s6(r3.reserve_applied)).toBe("20.000000");
    expect(r3.reserve_release_entry_id).not.toBeNull();
    expect(s6((await db.query("SELECT balance FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = 'pool_reserve'", [poolId])).rows[0].balance)).toBe("0.000000");
    await expectLedgerOk();
  });

  it("refuses to calculate a UTC day that has not closed, or a non-daily period end", async () => {
    await expect(calculateRun(db, adminId, { poolStrategyId: poolId })).rejects.toThrow(/has not closed yet/);
    await expect(calculateRun(db, adminId, { poolStrategyId: poolId, periodEnd: at(0, 12).toISOString() })).rejects.toThrow(/daily UTC periods/);
  });

  it("releases rewards at maturity and settles: the unrecovered loss expires, nothing is paid for it", async () => {
    await settleMaturedInvestments(db, { asOf: new Date() });
    expect(await usdt(alice.user)).toMatchObject({ available: "10045.000000", invested: "0.000000", rewardPending: "0.000000" });
    const view = await poolSettlementView(db, poolId);
    expect(view.allocations.find((a) => a.investmentId === alice.inv)).toMatchObject({ state: "settleable", lossBalance: "20.000000000000000000" });
    expect(view.allocations.find((a) => a.investmentId === bob.inv)!.state).toBe("participating");
    const res = await settlePoolReserves(db, adminId, poolId);
    expect(res.settled).toEqual([{ allocationId: expect.any(String), reserveReleased: "0", lossExpired: "20", entryId: null }]);
    expect(await usdt(alice.user)).toMatchObject({ available: "10045.000000" }); // an expired loss is never a payable
    // Settling again settles nothing.
    expect((await settlePoolReserves(db, adminId, poolId)).settled).toEqual([]);
    await expectLedgerOk();
  });

  it("recalculating a closed day reproduces it exactly (cancelled runs leave no trace)", async () => {
    const { inst, strategyId } = await strategyAndInstrument();
    await backdatedCapital(db, strategyId, "10000", at(-3, 0));
    await backdatedPool(db, adminId, strategyId, { startAt: at(-2, 0), capacity: "10000", periodMode: "daily_utc" });
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId });
    const u = await funded();
    await backdatedInvestment(db, { userId: u, productId, poolId: strategyId, amount: "3000", startAt: at(-2, 3), maturityAt: at(9, 0) });
    await backdatedRoundTrip(db, strategyId, inst.id, at(-2, 15), "700", "777.777777", "0.5");
    const cols = "period_start, period_end, source_trade_count, net_realised, capital_integral, allocation_integral, attributable, eligible_profit, reserve_contribution, total_rewards, attribution_residual";
    const a = await calculateRun(db, adminId, { poolStrategyId: strategyId });
    const first = (await db.query(`SELECT ${cols} FROM reward_runs WHERE id = $1`, [a])).rows[0];
    const firstLines = (await db.query("SELECT allocation_id, attributable, reward, loss_close, reserve_close FROM reward_run_lines WHERE run_id = $1", [a])).rows;
    const entries = (await db.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n;
    await cancelRun(db, adminId, a, "reproducibility check");
    const b = await calculateRun(db, adminId, { poolStrategyId: strategyId });
    expect((await db.query(`SELECT ${cols} FROM reward_runs WHERE id = $1`, [b])).rows[0]).toEqual(first);
    expect((await db.query("SELECT allocation_id, attributable, reward, loss_close, reserve_close FROM reward_run_lines WHERE run_id = $1", [b])).rows).toEqual(firstLines);
    expect((await db.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n).toBe(entries);
    // Independent recomputation of the documented formula from the stored inputs.
    const run = await runRow(b);
    const l = (await db.query("SELECT * FROM reward_run_lines WHERE run_id = $1", [b])).rows[0];
    const n = new Money(run.net_realised).times(l.weighted_allocation).div(run.capital_integral).toDecimalPlaces(6, Money.ROUND_FLOOR);
    const q = Money.min(n, n.times("0.1").toDecimalPlaces(6, Money.ROUND_CEIL));
    expect([s6(l.attributable), s6(l.reserve_contribution), s6(l.reward)]).toEqual([n.toFixed(6), q.toFixed(6), n.minus(q).toFixed(6)]);
    await postRun(db, adminId, b);
    await expectLedgerOk();
  });
});

describe("reserve ownership, settlement and pool closure", () => {
  it("closing releases nothing; the owned reserve is returned only by an approved final settlement", async () => {
    const { inst, strategyId } = await strategyAndInstrument();
    await backdatedCapital(db, strategyId, "10000", at(-4, 0));
    await backdatedPool(db, adminId, strategyId, { startAt: at(-3, 0), capacity: "10000", periodMode: "daily_utc" });
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId });
    const u = await funded();
    const inv = await backdatedInvestment(db, { userId: u, productId, poolId: strategyId, amount: "5000", startAt: at(-3, 0), maturityAt: at(-2, 0) });
    await backdatedRoundTrip(db, strategyId, inst.id, at(-3, 12), "1000", "1300");
    const r1 = await calcPost(strategyId);
    expect(await line(r1, inv)).toMatchObject({ n: "150.000000", q: "15.000000", reward: "135.000000", V: "15.000000" });

    await assignProductToPool(db, adminId, { productId, poolStrategyId: null });
    await updatePool(db, adminId, strategyId, { status: "closed" });
    const reserve = async () => s6((await db.query("SELECT balance FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = 'pool_reserve'", [strategyId])).rows[0].balance);
    expect(await reserve()).toBe("15.000000"); // closing did not release it
    expect((await poolSettlementView(db, strategyId)).poolState).toBe("closed_settling");

    // Not settleable until the investment has matured (which also releases its posted rewards).
    expect((await poolSettlementView(db, strategyId)).allocations[0]).toMatchObject({ state: "participating", reason: "investment not matured" });
    expect((await settlePoolReserves(db, adminId, strategyId)).settled).toEqual([]);
    await settleMaturedInvestments(db, { asOf: new Date() });
    expect(await usdt(u)).toMatchObject({ available: "10135.000000", rewardPending: "0.000000" });

    // Concurrent settlements: exactly one returns the reserve.
    const [a, b] = await Promise.all([settlePoolReserves(db, adminId, strategyId), settlePoolReserves(db, adminId, strategyId)]);
    expect([...a.settled, ...b.settled]).toEqual([{ allocationId: expect.any(String), reserveReleased: "15", lossExpired: "0", entryId: expect.any(String) }]);
    expect(await usdt(u)).toMatchObject({ available: "10150.000000" });
    expect(await reserve()).toBe("0.000000");
    expect((await poolSettlementView(db, strategyId)).poolState).toBe("closed_settled");
    await expect(db.query("DELETE FROM reserve_settlements")).rejects.toThrow(/append-only/);
    await expectLedgerOk();
  });

  it("posting a run concurrently produces exactly one posting", async () => {
    const { inst, strategyId } = await strategyAndInstrument();
    await backdatedCapital(db, strategyId, "10000", at(-3, 0));
    await backdatedPool(db, adminId, strategyId, { startAt: at(-2, 0), capacity: "10000", periodMode: "daily_utc" });
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId });
    await backdatedInvestment(db, { userId: await funded(), productId, poolId: strategyId, amount: "4000", startAt: at(-2, 0), maturityAt: at(9, 0) });
    await backdatedRoundTrip(db, strategyId, inst.id, at(-2, 9), "500", "650");
    const id = await calculateRun(db, adminId, { poolStrategyId: strategyId });
    const results = await Promise.allSettled([postRun(db, adminId, id), postRun(db, adminId, id), postRun(db, adminId, id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS n FROM journal_entries WHERE entry_type = 'reward_distribution' AND reference_id = $1", [id])).rows[0].n).toBe(1);
    await expectLedgerOk();
  });

  it("settlement is idempotent over HTTP and admin-only", async () => {
    const app: FastifyInstance = await makeApp(db, true);
    try {
      const { strategyId } = await strategyAndInstrument();
      await backdatedCapital(db, strategyId, "1000", at(-3, 0));
      await backdatedPool(db, adminId, strategyId, { startAt: at(-2, 0), capacity: "1000", periodMode: "daily_utc" });
      const admin = await sessionCookie(db, adminId);
      const user = await sessionCookie(db, (await createTestUser(db)).id);
      const url = `/api/admin/rewards/pools/${strategyId}/settle-reserves`;
      expect((await app.inject({ method: "POST", url, headers: { "content-type": "application/json", "idempotency-key": key(), ...user }, payload: {} })).statusCode).toBe(403);
      const headers = { "content-type": "application/json", "idempotency-key": key(), ...admin };
      const first = await app.inject({ method: "POST", url, headers, payload: {} });
      const replay = await app.inject({ method: "POST", url, headers, payload: {} });
      expect(first.statusCode).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json()).toEqual(first.json());
      const view = await app.inject({ method: "GET", url: `/api/admin/rewards/pools/${strategyId}/settlement`, headers: admin });
      expect(view.json()).toMatchObject({ simulated: true, lossModel: "investment_v2" });
    } finally {
      await app.close();
    }
  });
});

describe("legacy pools and historical data preservation", () => {
  it("a legacy pool with pool-level balances cannot be switched silently; its history is never rewritten", async () => {
    const { strategyId } = await strategyAndInstrument();
    await backdatedCapital(db, strategyId, "10000", at(-3, 0));
    await registerLegacyV1Pool(db, adminId, strategyId, "10000");
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId });
    const u = await funded();
    const { createInvestment } = await import("../src/services/investments.js");
    await createInvestment(db, { userId: u, productId, amount: "5000", idempotencyKey: key(), allowDevOnly: false });
    // A legacy loss: pool-level carry-forward > 0 under v1 rules.
    const lossEntry = await db.query("SELECT id FROM market_instruments WHERE id = (SELECT instrument_id FROM strategies WHERE id = $1)", [strategyId]);
    await backdatedRoundTrip(db, strategyId, lossEntry.rows[0].id, new Date(), "1000", "900");
    const legacyRun = await calcPost(strategyId);
    const legacy = await runRow(legacyRun);
    expect(legacy.loss_model).toBe("pool_v1");
    expect(new Money(legacy.cf_close).gt(0)).toBe(true);

    // Snapshot of the historical run and its lines, as text, to prove nothing is rewritten.
    const digest = async () =>
      (await db.query("SELECT r::text AS t FROM reward_runs r WHERE r.id = $1", [legacyRun])).rows[0].t +
      (await db.query("SELECT string_agg(l::text, '|' ORDER BY l.id) AS t FROM reward_run_lines l WHERE l.run_id = $1", [legacyRun])).rows[0].t;
    const before = await digest();

    await expect(switchToInvestmentModel(db, adminId, strategyId)).rejects.toThrow(/founder decision/);
    const pool = (await db.query("SELECT loss_model FROM reward_pools WHERE strategy_id = $1", [strategyId])).rows[0];
    expect(pool.loss_model).toBe("pool_v1");
    await expect(db.query("UPDATE reward_pools SET loss_model = 'pool_v1' WHERE loss_model = 'investment_v2'")).rejects.toThrow(/cannot move back/);
    expect(await digest()).toBe(before);
    const lines = (await db.query("SELECT loss_open FROM reward_run_lines WHERE run_id = $1", [legacyRun])).rows;
    expect(lines.every((l) => l.loss_open === null)).toBe(true); // historical lines carry no v2 memo
    await expectLedgerOk();
  });

  it("a legacy pool with zero legacy balances switches, keeps its v1 history byte-identical, and continues on v2", async () => {
    const { strategyId } = await strategyAndInstrument();
    await backdatedCapital(db, strategyId, "10000", at(-3, 0));
    await registerLegacyV1Pool(db, adminId, strategyId, "10000");
    const v1Run = await calcPost(strategyId); // zero-activity period: CF 0, reserve 0
    const snap = async () => (await db.query("SELECT r::text AS t FROM reward_runs r WHERE r.id = $1", [v1Run])).rows[0].t;
    const before = await snap();
    await switchToInvestmentModel(db, adminId, strategyId);
    const v2Run = await calcPost(strategyId);
    expect((await runRow(v2Run)).loss_model).toBe("investment_v2");
    expect(await snap()).toBe(before);
    await expectLedgerOk();
  });
});
