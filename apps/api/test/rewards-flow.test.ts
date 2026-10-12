import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { Money } from "../src/lib/money.js";
import { appendScriptedTicks } from "../src/market/market.js";
import { assignProductToPool, registerPool } from "../src/rewards/pools.js";
import { calculateRun, cancelRun, postRun } from "../src/rewards/runs.js";
import { getUserBalances } from "../src/services/accounts.js";
import { createInvestment, settleMaturedInvestments } from "../src/services/investments.js";
import { runEngine } from "../src/strategy/engine.js";
import { pauseStrategy, resumeStrategy } from "../src/strategy/strategies.js";
import { createTestProduct, createTestUser, fund, key, makeApp, sessionCookie, testDb } from "./helpers.js";
import { MOMENTUM_1, makeStrategy, scriptedInstrument } from "./strategy-helpers.js";

const db = testDb();
let adminId: string;
beforeAll(async () => {
  adminId = (await createTestUser(db, "admin")).id;
});
afterAll(() => db.end());

const expectLedgerOk = async () => expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
const usdt = async (userId: string) => (await getUserBalances(db, userId)).find((b) => b.asset === "USDT")!;
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const accountBalance = async (strategyId: string, purpose: string) =>
  (
    await db.query<{ b: string }>(
      "SELECT COALESCE(sum(balance), 0)::text AS b FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = $2",
      [strategyId, purpose],
    )
  ).rows[0]!.b;
const runRow = async (id: string) => (await db.query("SELECT * FROM reward_runs WHERE id = $1", [id])).rows[0];
const lines = async (runId: string) =>
  (await db.query("SELECT * FROM reward_run_lines WHERE run_id = $1 ORDER BY id", [runId])).rows;

/** A momentum strategy pool with paper capital, a pool-backed product, and funded users. */
async function setupPool(o: { capital?: string; capacity?: string; params?: Record<string, unknown>; termMinutes?: number } = {}) {
  const inst = await scriptedInstrument(db, { feeBps: "10" });
  const strategyId = await makeStrategy(db, adminId, {
    type: "trading",
    instrumentSymbol: inst.symbol,
    capital: o.capital ?? "10000",
    params: o.params ?? MOMENTUM_1,
  });
  await registerPool(db, adminId, { strategyId, customerCapacity: o.capacity ?? "5000" });
  const productId = await createTestProduct(db, { termMinutes: o.termMinutes ?? 30 * 1440 });
  await assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId, reason: "test" });
  return { inst, strategyId, productId };
}

async function investor(productId: string, amount: string) {
  const user = await createTestUser(db);
  await fund(db, user.id, "10000");
  const inv = await createInvestment(db, { userId: user.id, productId, amount, idempotencyKey: key(), allowDevOnly: false });
  return { userId: user.id, investmentId: inv.body.id };
}

describe("customer-to-pool allocation", () => {
  it("records an immutable, audited allocation matching the investment's term", async () => {
    const { strategyId, productId } = await setupPool();
    const { investmentId } = await investor(productId, "3000");
    const a = await db.query(
      `SELECT pa.weight::text, pa.amount::text, pa.effective_from = i.start_at AS from_ok, pa.effective_to = i.maturity_at AS to_ok, pa.pool_strategy_id
         FROM pool_allocations pa JOIN investments i ON i.id = pa.investment_id WHERE pa.investment_id = $1`,
      [investmentId],
    );
    expect(a.rows[0]).toMatchObject({ from_ok: true, to_ok: true, pool_strategy_id: strategyId });
    expect(new Money(a.rows[0].weight).eq(1) && new Money(a.rows[0].amount).eq(3000)).toBe(true);
    const audit = await db.query("SELECT 1 FROM audit_logs WHERE action = 'pool.allocation_created' AND details->>'investmentId' = $1", [investmentId]);
    expect(audit.rowCount).toBe(1);
    await expect(db.query("UPDATE pool_allocations SET amount = 1 WHERE investment_id = $1", [investmentId])).rejects.toThrow(/append-only/);
  });

  it("never exceeds pool capacity, even under concurrent investments, and rejects atomically", async () => {
    const { productId, strategyId } = await setupPool({ capacity: "5000" });
    const users = await Promise.all(Array.from({ length: 6 }, () => createTestUser(db)));
    for (const u of users) await fund(db, u.id, "2000");
    const results = await Promise.allSettled(
      users.map((u) => createInvestment(db, { userId: u.id, productId, amount: "1000", idempotencyKey: key(), allowDevOnly: false })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/full/);
    const total = await db.query("SELECT sum(amount)::text AS t FROM pool_allocations WHERE pool_strategy_id = $1", [strategyId]);
    expect(new Money(total.rows[0].t).eq(5000)).toBe(true);
    // The rejected user's money never moved.
    const balances = await Promise.all(users.map((u) => usdt(u.id)));
    expect(balances.filter((b) => b.available === "2000.000000")).toHaveLength(1);
    await expectLedgerOk();
  });

  it("caps allocations at the pool's paper capital and refuses paused pools", async () => {
    const { productId, strategyId } = await setupPool({ capital: "1000", capacity: "5000" });
    const u = await createTestUser(db);
    await fund(db, u.id, "5000");
    await expect(createInvestment(db, { userId: u.id, productId, amount: "1000.000001", idempotencyKey: key(), allowDevOnly: false })).rejects.toThrow(
      /full/,
    );
    await pauseStrategy(db, adminId, strategyId, "test");
    await expect(createInvestment(db, { userId: u.id, productId, amount: "100", idempotencyKey: key(), allowDevOnly: false })).rejects.toThrow(
      /not accepting/,
    );
    await resumeStrategy(db, adminId, strategyId);
    expect((await createInvestment(db, { userId: u.id, productId, amount: "100", idempotencyKey: key(), allowDevOnly: false })).statusCode).toBe(201);
    expect((await usdt(u.id)).available).toBe("4900.000000");
  });
});

describe("reward runs", () => {
  it("calculates without touching the ledger, posts exact rewards from realised profit, and releases them at maturity", async () => {
    const { inst, strategyId, productId } = await setupPool();
    const a = await investor(productId, "3000");
    const b = await investor(productId, "1000");
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]); // profitable round trip
    expect((await runEngine(db, { trigger: "test", strategyIds: [strategyId] })).trades).toBe(2);
    const cashBefore = await accountBalance(strategyId, "strategy_cash");
    const entriesBefore = (await db.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n;

    const runId = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    const run = await runRow(runId);
    expect(run.status).toBe("calculated");
    expect((await db.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n).toBe(entriesBefore);
    expect(run.source_trade_count).toBe(2);
    expect(new Money(run.net_realised).toFixed(6)).toBe("136.774989"); // 146.911911 gain - 10.136922 fees
    const eligible = new Money(run.eligible_profit);
    expect(eligible.gt(0)).toBe(true);
    // Recompute the documented formula from the stored inputs.
    const expectedAttr = new Money(run.net_realised).times(run.allocation_integral).div(run.capital_integral).toDecimalPlaces(6, Money.ROUND_FLOOR);
    expect(new Money(run.attributable).eq(expectedAttr)).toBe(true);
    const ls = await lines(runId);
    expect(ls).toHaveLength(2);
    for (const l of ls) {
      const expected = new Money(run.distributable).times(l.weighted_allocation).div(run.allocation_integral).toDecimalPlaces(6, Money.ROUND_FLOOR);
      expect(new Money(l.reward).eq(expected)).toBe(true);
    }
    expect(new Money(run.total_rewards).plus(run.reserve_contribution).eq(eligible)).toBe(true);

    await postRun(db, adminId, runId);
    expect((await runRow(runId)).status).toBe("posted");
    const rewardA = new Money(ls.find((l) => l.investment_id === a.investmentId)!.reward);
    const rewardB = new Money(ls.find((l) => l.investment_id === b.investmentId)!.reward);
    expect(rewardA.gt(rewardB)).toBe(true); // 3x the allocation
    expect(await usdt(a.userId)).toMatchObject({ available: "7000.000000", invested: "3000.000000", rewardPending: rewardA.toFixed(6) });
    expect(new Money(await accountBalance(strategyId, "strategy_cash")).eq(new Money(cashBefore).minus(eligible))).toBe(true);
    expect(new Money(await accountBalance(strategyId, "strategy_distributions")).eq(eligible)).toBe(true);
    expect(new Money(await accountBalance(strategyId, "pool_reserve")).eq(run.reserve_contribution)).toBe(true);
    await expectLedgerOk();

    // Maturity: principal plus posted rewards become available, exactly once.
    const far = new Date(Date.now() + 31 * 86400_000);
    await settleMaturedInvestments(db, { asOf: far });
    await settleMaturedInvestments(db, { asOf: far });
    expect(await usdt(a.userId)).toMatchObject({
      available: new Money("10000").plus(rewardA).toFixed(6),
      invested: "0.000000",
      rewardPending: "0.000000",
    });
    await expectLedgerOk();
  });

  it("applies the reserve to later losses, carries the rest forward, and recovers before paying again", async () => {
    const { inst, strategyId, productId } = await setupPool({ capacity: "10000" });
    await investor(productId, "10000"); // customers hold the whole pool capital
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]); // profit
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const r1 = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    await postRun(db, adminId, r1);
    const reserve1 = new Money((await runRow(r1)).reserve_contribution);
    expect(reserve1.gt(0)).toBe(true);

    await sleep(5);
    await appendScriptedTicks(db, inst.id, ["107", "95"]); // buy at 107, sell at 95: loss
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const r2 = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    const run2 = await runRow(r2);
    expect(new Money(run2.attributable).lt(0)).toBe(true);
    expect(new Money(run2.reserve_applied).eq(reserve1)).toBe(true); // loss larger than the reserve
    expect(new Money(run2.cf_close).eq(new Money(run2.attributable).neg().minus(reserve1))).toBe(true);
    expect(new Money(run2.total_rewards).isZero()).toBe(true);
    await postRun(db, adminId, r2);
    expect(new Money(await accountBalance(strategyId, "pool_reserve")).isZero()).toBe(true);
    await expectLedgerOk();

    await sleep(5);
    await appendScriptedTicks(db, inst.id, ["97", "99", "98"]); // buy 97, exit 98: small profit, smaller than the carried loss
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const r3 = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    const run3 = await runRow(r3);
    expect(new Money(run3.attributable).gt(0)).toBe(true);
    expect(new Money(run3.cf_recovered).eq(run3.attributable)).toBe(true);
    expect(new Money(run3.eligible_profit).isZero()).toBe(true); // recovery is never paid out
    await postRun(db, adminId, r3);
    await expectLedgerOk();
  });

  it("records zero-profit periods, including unrealised-only gains, without distributing anything", async () => {
    const { inst, strategyId, productId } = await setupPool();
    await investor(productId, "2000");
    await appendScriptedTicks(db, inst.id, ["102", "120"]); // open position, large unrealised gain, nothing sold
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const runId = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    const run = await runRow(runId);
    expect(new Money(run.net_realised).lt(0)).toBe(true); // only the buy fee is realised
    expect(new Money(run.total_rewards).isZero()).toBe(true);
    await postRun(db, adminId, runId);
    expect((await runRow(runId)).distribution_entry_id).toBeNull();
    await expectLedgerOk();
  });

  it("prevents double payment: one pending run, no re-post, contiguous periods, unique sources", async () => {
    const { inst, strategyId, productId } = await setupPool();
    await investor(productId, "2000");
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const runId = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    await expect(calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() })).rejects.toThrow(/already has a calculated run/);

    const results = await Promise.allSettled([postRun(db, adminId, runId), postRun(db, adminId, runId), postRun(db, adminId, runId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(postRun(db, adminId, runId)).rejects.toThrow(/only calculated runs/);
    const dist = await db.query("SELECT count(*)::int AS n FROM journal_entries WHERE entry_type = 'reward_distribution' AND reference_id = $1", [runId]);
    expect(dist.rows[0].n).toBe(1);

    // The next run starts exactly where the posted one ended and sees no old trades.
    await sleep(5);
    const next = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    const [a, b] = [await runRow(runId), await runRow(next)];
    expect(b.period_start.getTime()).toBe(a.period_end.getTime());
    expect(b.source_trade_count).toBe(0);
    const trade = await db.query("SELECT trade_id FROM reward_run_sources WHERE run_id = $1 LIMIT 1", [runId]);
    await expect(db.query("INSERT INTO reward_run_sources (run_id, trade_id) VALUES ($1, $2)", [next, trade.rows[0].trade_id])).rejects.toThrow(
      /duplicate key/,
    );
    await expect(db.query("UPDATE reward_runs SET total_rewards = 0 WHERE id = $1", [runId])).rejects.toThrow(/final/);
    await cancelRun(db, adminId, next, "test");
    await expectLedgerOk();
  });

  it("rejects future periods and periods that do not move forward", async () => {
    const { strategyId } = await setupPool();
    await expect(calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(
      /future/,
    );
    await expect(calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: "2020-01-01T00:00:00Z" })).rejects.toThrow(/after the period start/);
  });

  it("an interrupted post leaves nothing behind and can be retried", async () => {
    const { inst, strategyId, productId } = await setupPool();
    const a = await investor(productId, "2000");
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const runId = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    await expect(
      postRun(db, adminId, runId, null, () => {
        throw new Error("simulated crash");
      }),
    ).rejects.toThrow(/simulated crash/);
    expect((await runRow(runId)).status).toBe("calculated");
    expect((await usdt(a.userId)).rewardPending).toBe("0.000000");
    expect((await db.query("SELECT count(*)::int AS n FROM reward_run_sources WHERE run_id = $1", [runId])).rows[0].n).toBe(0);
    await expectLedgerOk();

    await postRun(db, adminId, runId);
    expect((await runRow(runId)).status).toBe("posted");
    expect(new Money((await usdt(a.userId)).rewardPending).gt(0)).toBe(true);
    await expectLedgerOk();
  });

  it("fails reconciliation when source data changed after calculation; a fresh run succeeds", async () => {
    const { inst, strategyId, productId } = await setupPool();
    await investor(productId, "2000");
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });

    // A capital allocation whose transaction started before periodEnd but commits after calculation.
    const late = await db.connect();
    try {
      await late.query("BEGIN");
      await late.query("SELECT now()");
      await sleep(5);
      const runId = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
      const accts = await late.query(
        "SELECT id, purpose FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose IN ('strategy_cash', 'strategy_capital')",
        [strategyId],
      );
      const id = (p: string) => accts.rows.find((r) => r.purpose === p).id;
      const e = await late.query(
        "INSERT INTO journal_entries (entry_type, idempotency_key, description) VALUES ('strategy_capital_allocation', $1, 'late') RETURNING id",
        [key()],
      );
      await late.query("INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'debit', 5000, 0)", [e.rows[0].id, id("strategy_cash")]);
      await late.query("INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'credit', 5000, 0)", [e.rows[0].id, id("strategy_capital")]);
      await late.query("COMMIT");

      await expect(postRun(db, adminId, runId)).rejects.toThrow(/Source data changed/);
      const failed = await runRow(runId);
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/reconciliation_failed/);
      expect(failed.distribution_entry_id).toBeNull();
    } finally {
      late.release();
    }
    const retry = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    await postRun(db, adminId, retry);
    expect((await runRow(retry)).status).toBe("posted");
    await expectLedgerOk();
  });

  it("fails cleanly when realised profit is tied up in open positions", async () => {
    const { inst, strategyId, productId } = await setupPool({
      params: { ...MOMENTUM_1, targetExposure: "1" },
    });
    await investor(productId, "5000");
    await appendScriptedTicks(db, inst.id, ["102", "110", "105", "107"]); // profit, then re-enter with all cash
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const runId = await calculateRun(db, adminId, { poolStrategyId: strategyId, periodEnd: nowIso() });
    if (new Money((await runRow(runId)).eligible_profit).isZero()) throw new Error("scenario must produce eligible profit");
    await expect(postRun(db, adminId, runId)).rejects.toThrow(/positions must be closed/);
    expect((await runRow(runId)).status).toBe("failed");
    expect((await runRow(runId)).error).toMatch(/insufficient_pool_cash/);
    await expectLedgerOk();
  });
});

describe("reward HTTP access control", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp(db, true);
  });
  afterAll(() => app.close());

  it("admin reward routes reject anonymous and non-admin callers", async () => {
    const user = await sessionCookie(db, (await createTestUser(db)).id);
    const id = "00000000-0000-0000-0000-000000000000";
    for (const [method, url] of [
      ["GET", "/api/admin/rewards/pools"],
      ["POST", "/api/admin/rewards/pools"],
      ["PATCH", `/api/admin/rewards/pools/${id}`],
      ["POST", "/api/admin/rewards/product-assignments"],
      ["POST", "/api/admin/rewards/policies"],
      ["GET", "/api/admin/rewards/runs"],
      ["GET", `/api/admin/rewards/runs/${id}`],
      ["POST", "/api/admin/rewards/runs"],
      ["POST", `/api/admin/rewards/runs/${id}/post`],
      ["POST", `/api/admin/rewards/runs/${id}/cancel`],
    ] as const) {
      const payload = method === "GET" ? undefined : {};
      const headers = { "content-type": "application/json", "idempotency-key": key() };
      expect((await app.inject({ method, url, headers, payload })).statusCode, `anon ${url}`).toBe(401);
      expect((await app.inject({ method, url, headers: { ...headers, ...user }, payload })).statusCode, `user ${url}`).toBe(403);
    }
  });

  it("an investor can read only their own reward statement; the admin flow works over HTTP", async () => {
    const { inst, strategyId, productId } = await setupPool();
    const a = await investor(productId, "2000");
    const other = await sessionCookie(db, (await createTestUser(db)).id);
    const mine = await sessionCookie(db, a.userId);
    expect((await app.inject({ method: "GET", url: `/api/investments/${a.investmentId}/rewards`, headers: other })).statusCode).toBe(404);

    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [strategyId] });
    const admin = await sessionCookie(db, adminId);
    const headers = { "content-type": "application/json", "idempotency-key": key(), ...admin };
    const payload = { poolStrategyId: strategyId, periodEnd: nowIso() };
    const calc = await app.inject({ method: "POST", url: "/api/admin/rewards/runs", headers, payload });
    expect(calc.statusCode).toBe(201);
    const replay = await app.inject({ method: "POST", url: "/api/admin/rewards/runs", headers, payload });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().run.id).toBe(calc.json().run.id);
    const post = await app.inject({ method: "POST", url: `/api/admin/rewards/runs/${calc.json().run.id}/post`, headers: { "content-type": "application/json", ...admin }, payload: {} });
    expect(post.json()).toMatchObject({ status: "posted", simulated: true });

    const statement = await app.inject({ method: "GET", url: `/api/investments/${a.investmentId}/rewards`, headers: mine });
    expect(statement.json()).toMatchObject({ simulated: true, periods: [{ policyVersion: 1 }] });
    const products = await app.inject({ method: "GET", url: "/api/products", headers: mine });
    expect(products.json().products.find((p: { id: string }) => p.id === productId).pool.poolId).toBe(strategyId);
    await expectLedgerOk();
  });
});
