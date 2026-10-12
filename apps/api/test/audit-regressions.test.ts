import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { Money } from "../src/lib/money.js";
import { appendScriptedTicks } from "../src/market/market.js";
import { assignProductToPool, registerPool, updatePool } from "../src/rewards/pools.js";
import { calculateRun, cancelRun, postRun } from "../src/rewards/runs.js";
import { getUserBalances } from "../src/services/accounts.js";
import { createInvestment, listProducts, settleMaturedInvestments } from "../src/services/investments.js";
import { pauseStrategy, resumeStrategy } from "../src/strategy/strategies.js";
import { runEngine } from "../src/strategy/engine.js";
import { createTestProduct, createTestUser, fund, key, testDb } from "./helpers.js";
import { MOMENTUM_1, makeStrategy, scriptedInstrument } from "./strategy-helpers.js";

/**
 * Regression tests for defects found in the milestone-3 audit
 * (docs/milestone-3-audit.md). Each test names the defect it covers.
 */

const db = testDb();
let adminId: string;
beforeAll(async () => {
  adminId = (await createTestUser(db, "admin")).id;
});
afterAll(() => db.end());

const expectLedgerOk = async () => expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const usdt = async (userId: string) => (await getUserBalances(db, userId)).find((b) => b.asset === "USDT")!;
const runRow = async (id: string) => (await db.query("SELECT * FROM reward_runs WHERE id = $1", [id])).rows[0];

async function pool(o: { capacity?: string; limits?: Record<string, string>; termMinutes?: number } = {}) {
  const inst = await scriptedInstrument(db, { feeBps: "10" });
  const strategyId = await makeStrategy(db, adminId, {
    type: "trading",
    instrumentSymbol: inst.symbol,
    capital: "10000",
    params: MOMENTUM_1,
    limits: o.limits,
  });
  // Model-independent regressions; run on the default investment_v2 model with ad hoc periods.
  await registerPool(db, adminId, { strategyId, customerCapacity: o.capacity ?? "10000", periodMode: "ad_hoc" });
  const productId = await createTestProduct(db, { termMinutes: o.termMinutes ?? 30 * 1440 });
  await assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId });
  return { inst, strategyId, productId };
}
async function invest(productId: string, amount: string) {
  const u = await createTestUser(db);
  await fund(db, u.id, "20000");
  const inv = await createInvestment(db, { userId: u.id, productId, amount, idempotencyKey: key(), allowDevOnly: false });
  return { userId: u.id, investmentId: inv.body.id as string };
}
/** Profitable round trip, then a posted run with eligible profit. */
async function profitablePostedRun(p: { inst: { id: string }; strategyId: string }) {
  await appendScriptedTicks(db, p.inst.id, ["102", "110", "105"]);
  await runEngine(db, { trigger: "test", strategyIds: [p.strategyId] });
  const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
  await postRun(db, adminId, runId);
  return runId;
}

describe("D1: reward distributions must not look like trading losses to the risk monitor", () => {
  it("a strategy is not auto-paused merely because profit was distributed", async () => {
    // Daily loss limit 20 USDT; drawdown limit effectively off (the round trip's own unrealised peak is ~2.4%).
    const p = await pool({ limits: { dailyLossLimit: "20", maxDrawdownRatio: "0.5" } });
    await invest(p.productId, "10000");
    // Day 1 (ticks 1-3): profitable round trip. Flat ticks 4-25 cross midnight, so day 2's
    // loss baseline (set at tick 24) already includes the realised profit.
    await appendScriptedTicks(db, p.inst.id, ["102", "110", "105", ...Array.from({ length: 22 }, () => "105")]);
    await runEngine(db, { trigger: "test", strategyIds: [p.strategyId] });
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    await postRun(db, adminId, runId); // payout mid-day 2
    const swept = new Money((await runRow(runId)).eligible_profit);
    expect(swept.gt(20)).toBe(true); // the payout alone exceeds the daily loss limit

    await appendScriptedTicks(db, p.inst.id, ["105"]); // tick 26, still day 2, flat
    await runEngine(db, { trigger: "test", strategyIds: [p.strategyId] });
    const s = await db.query("SELECT status, pause_reason FROM strategies WHERE id = $1", [p.strategyId]);
    expect(s.rows[0]).toEqual({ status: "active", pause_reason: null });
    const breaches = await db.query("SELECT 1 FROM strategy_events WHERE strategy_id = $1 AND event_type = 'risk_breach'", [p.strategyId]);
    expect(breaches.rowCount).toBe(0);
    await expectLedgerOk();
  });
});

describe("D2: posting a run concurrently with maturity settlement must not strand rewards", () => {
  it("rewards are released even when the investment matures while the run is being posted", async () => {
    const p = await pool();
    const inv = await invest(p.productId, "5000");
    await appendScriptedTicks(db, p.inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [p.strategyId] });
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });

    // Emulate settlement in progress: lock the investment, return principal and mark it matured
    // (exactly what settleMaturedInvestments does), but do not commit yet.
    const settle = await db.connect();
    let posting: Promise<unknown> | undefined;
    try {
      await settle.query("BEGIN");
      await settle.query("SELECT 1 FROM investments WHERE id = $1 FOR UPDATE", [inv.investmentId]);
      const accts = await settle.query("SELECT id, purpose FROM ledger_accounts WHERE owner_user_id = $1", [inv.userId]);
      const acct = (purpose: string) => accts.rows.find((r) => r.purpose === purpose).id;
      const e = await settle.query(
        "INSERT INTO journal_entries (entry_type, idempotency_key, description) VALUES ('investment_mature', $1, 'emulated') RETURNING id",
        [`investment:${inv.investmentId}:mature`],
      );
      await settle.query("INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'debit', 5000, 0)", [e.rows[0].id, acct("user_invested")]);
      await settle.query("INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'credit', 5000, 0)", [e.rows[0].id, acct("user_available")]);
      await settle.query("UPDATE investments SET status = 'matured', settle_entry_id = $2, settled_at = now() WHERE id = $1", [inv.investmentId, e.rows[0].id]);
      // Settlement's own release query sees no posted run yet, so it releases nothing.

      posting = postRun(db, adminId, runId);
      await sleep(300); // let the post reach the point where it decides what to release
      await settle.query("COMMIT");
      await posting;
    } finally {
      settle.release();
    }
    const pending = await db.query(
      "SELECT count(*)::int AS n FROM reward_run_lines WHERE run_id = $1 AND reward > 0 AND released_entry_id IS NULL",
      [runId],
    );
    expect(pending.rows[0].n).toBe(0);
    expect((await usdt(inv.userId)).rewardPending).toBe("0.000000");
    await expectLedgerOk();
  });

  it("the integrity checker flags rewards stranded on a matured investment", async () => {
    // Covered by checkLedgerIntegrity() in every scenario above; asserted explicitly here.
    const problems = (await checkLedgerIntegrity(db)).problems.filter((p) => p.includes("matured investment"));
    expect(problems).toEqual([]);
  });
});

describe("D3: nothing may be committed into a reward period that is already posted", () => {
  it("a capital change from a transaction that started before the period ended is rejected for retry", async () => {
    const p = await pool();
    await invest(p.productId, "2000");
    const late = await db.connect();
    try {
      await late.query("BEGIN");
      await late.query("SELECT now()"); // fixes this transaction's timestamp inside the coming period
      await sleep(5);
      const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
      await postRun(db, adminId, runId);

      const accts = await late.query(
        "SELECT id, purpose FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose IN ('strategy_cash', 'strategy_capital')",
        [p.strategyId],
      );
      const id = (purpose: string) => accts.rows.find((r) => r.purpose === purpose).id;
      const e = await late.query(
        "INSERT INTO journal_entries (entry_type, idempotency_key, description) VALUES ('strategy_capital_allocation', $1, 'late') RETURNING id",
        [key()],
      );
      await late.query("INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'debit', 100, 0)", [e.rows[0].id, id("strategy_cash")]);
      await expect(
        late.query("INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'credit', 100, 0)", [e.rows[0].id, id("strategy_capital")]),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await late.query("ROLLBACK").catch(() => {});
      late.release();
    }
    await expectLedgerOk();
  });

  it("a customer allocation dated inside a posted period is rejected for retry", async () => {
    const p = await pool();
    const plain = await createTestProduct(db); // no pool: lets us create an investment to reference
    const u = await createTestUser(db);
    await fund(db, u.id, "1000");
    const inv = await createInvestment(db, { userId: u.id, productId: plain, amount: "100", idempotencyKey: key(), allowDevOnly: false });
    const assignment = await db.query("SELECT id FROM product_pool_assignments WHERE pool_strategy_id = $1 LIMIT 1", [p.strategyId]);

    const late = await db.connect();
    try {
      await late.query("BEGIN");
      await late.query("SELECT now()");
      await sleep(5);
      const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
      await postRun(db, adminId, runId);
      await expect(
        late.query(
          `INSERT INTO pool_allocations (investment_id, user_id, pool_strategy_id, assignment_id, weight, amount, effective_from, effective_to)
           VALUES ($1, $2, $3, $4, 1, 100, now(), now() + interval '1 day')`,
          [inv.body.id, u.id, p.strategyId, assignment.rows[0].id],
        ),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await late.query("ROLLBACK").catch(() => {});
      late.release();
    }
  });
});

describe("D4: pool closure must not silently break products or strand obligations", () => {
  it("a pool cannot be closed while products are still assigned to it or a run is pending", async () => {
    const p = await pool();
    await expect(updatePool(db, adminId, p.strategyId, { status: "closed" })).rejects.toThrow(/assigned/);
    await assignProductToPool(db, adminId, { productId: p.productId, poolStrategyId: null, reason: "closing" });
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    await expect(updatePool(db, adminId, p.strategyId, { status: "closed" })).rejects.toThrow(/pending/);
    await cancelRun(db, adminId, runId, "closing");
    await updatePool(db, adminId, p.strategyId, { status: "closed" });
    const s = await db.query("SELECT status FROM reward_pools WHERE strategy_id = $1", [p.strategyId]);
    expect(s.rows[0].status).toBe("closed");
  });

  it("a closed pool keeps paying out obligations: runs still post and pending rewards still release at maturity", async () => {
    const p = await pool({ termMinutes: 60 });
    const inv = await invest(p.productId, "5000");
    await profitablePostedRun(p);
    const pendingBefore = new Money((await usdt(inv.userId)).rewardPending);
    expect(pendingBefore.gt(0)).toBe(true);
    await assignProductToPool(db, adminId, { productId: p.productId, poolStrategyId: null });
    await updatePool(db, adminId, p.strategyId, { status: "closed" });
    await sleep(5);
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    await postRun(db, adminId, runId);
    await settleMaturedInvestments(db, { asOf: new Date(Date.now() + 2 * 3600_000) });
    expect(await usdt(inv.userId)).toMatchObject({
      rewardPending: "0.000000",
      available: new Money("20000").plus(pendingBefore).toFixed(6),
    });
    await expectLedgerOk();
  });
});

describe("coverage gaps found in the audit", () => {
  it("a run posted after an investment matured releases its reward immediately", async () => {
    const p = await pool({ termMinutes: 1 });
    const inv = await invest(p.productId, "5000");
    await appendScriptedTicks(db, p.inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [p.strategyId] });
    await settleMaturedInvestments(db, { asOf: new Date(Date.now() + 120_000) });
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    await postRun(db, adminId, runId);
    const line = await db.query("SELECT reward::text, released_entry_id FROM reward_run_lines WHERE run_id = $1", [runId]);
    expect(new Money(line.rows[0].reward).gt(0)).toBe(true);
    expect(line.rows[0].released_entry_id).not.toBeNull();
    expect((await usdt(inv.userId)).rewardPending).toBe("0.000000");
    await expectLedgerOk();
  });

  it("D5: reassigning a product affects only new investments (even after 10+ assignments); existing participation is immutable", async () => {
    const p1 = await pool();
    const p2 = await pool();
    const productId = p1.productId;
    const first = await invest(productId, "1000");
    // Make the reassignment's id the first with one more digit than the current assignment's
    // (e.g. 57 -> 100). Text order would then pick "57" over "100": the D5 bug condition.
    const cur = async () =>
      Number((await db.query("SELECT max(a.id)::text AS m FROM product_pool_assignments a WHERE a.product_id = $1", [productId])).rows[0].m);
    if (/^10*$/.test(String(await cur()))) await assignProductToPool(db, adminId, { productId, poolStrategyId: p1.strategyId });
    const filler = await createTestProduct(db);
    const target = 10 ** String(await cur()).length;
    const next = Number((await db.query("SELECT max(a.id)::text AS m FROM product_pool_assignments a")).rows[0].m) + 1;
    for (let i = next; i < target; i++) await assignProductToPool(db, adminId, { productId: filler, poolStrategyId: null });
    await assignProductToPool(db, adminId, { productId, poolStrategyId: p2.strategyId, reason: "move" });
    const ids = await db.query("SELECT a.id::text AS id FROM product_pool_assignments a WHERE a.product_id = $1 ORDER BY a.id", [productId]);
    expect(ids.rows.at(-1)!.id).toBe(String(target));
    const second = await invest(productId, "1000");
    const allocs = await db.query(
      "SELECT investment_id, pool_strategy_id FROM pool_allocations WHERE investment_id = ANY($1::uuid[])",
      [[first.investmentId, second.investmentId]],
    );
    const poolOf = (id: string) => allocs.rows.find((r) => r.investment_id === id).pool_strategy_id;
    expect(poolOf(first.investmentId)).toBe(p1.strategyId);
    expect(poolOf(second.investmentId)).toBe(p2.strategyId);
    await expect(db.query("UPDATE pool_allocations SET pool_strategy_id = $1 WHERE investment_id = $2", [p2.strategyId, first.investmentId])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("DELETE FROM pool_allocations WHERE investment_id = $1", [first.investmentId])).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE product_pool_assignments SET pool_strategy_id = NULL")).rejects.toThrow(/append-only/);
  });

  it("partial-period participation is weighted by the exact overlap in microseconds", async () => {
    const p = await pool();
    await sleep(30);
    const early = await invest(p.productId, "1000");
    await sleep(60);
    const late = await invest(p.productId, "1000");
    await sleep(30);
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    const ls = await db.query(
      `SELECT l.investment_id, l.overlap_us::text,
              ((extract(epoch from r.period_end) - extract(epoch from i.start_at)) * 1000000)::numeric(30,0)::text AS expected
         FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id JOIN investments i ON i.id = l.investment_id
        WHERE l.run_id = $1`,
      [runId],
    );
    for (const l of ls.rows) expect(l.overlap_us).toBe(l.expected);
    const ov = (id: string) => new Money(ls.rows.find((r) => r.investment_id === id).overlap_us);
    expect(ov(early.investmentId).gt(ov(late.investmentId))).toBe(true);
    await cancelRun(db, adminId, runId, "test");
  });

  it("a cancelled run writes nothing and the next run covers the same period start", async () => {
    const p = await pool();
    await invest(p.productId, "1000");
    const entries = (await db.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n;
    const a = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    await cancelRun(db, adminId, a, "test");
    expect((await db.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n).toBe(entries);
    await sleep(5);
    const b = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    expect((await runRow(b)).period_start.getTime()).toBe((await runRow(a)).period_start.getTime());
    await expect(postRun(db, adminId, a)).rejects.toThrow(/only calculated runs/);
    await cancelRun(db, adminId, b, "test");
  });
});

describe("D8: the product listing tells investors when the backing pool is not accepting", () => {
  it("reports accepting=false while the pool strategy is paused", async () => {
    const p = await pool();
    const flag = async () => (await listProducts(db, { includeDevOnly: false })).find((x) => x.id === p.productId)!.pool!.accepting;
    expect(await flag()).toBe(true);
    await pauseStrategy(db, adminId, p.strategyId, "test");
    expect(await flag()).toBe(false);
    await resumeStrategy(db, adminId, p.strategyId);
    expect(await flag()).toBe(true);
  });
});

describe("D6: the reward period end comes from the server clock by default", () => {
  it("calculating without periodEnd uses the database clock (no client clock skew)", async () => {
    const p = await pool();
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId });
    const r = await db.query("SELECT period_end <= now() AS past, period_end > period_start AS ordered FROM reward_runs WHERE id = $1", [runId]);
    expect(r.rows[0]).toEqual({ past: true, ordered: true });
    await cancelRun(db, adminId, runId, "test");
  });
});

describe("database guards added by the audit", () => {
  it("D7: an investment's pool participation can never exceed its principal", async () => {
    const p1 = await pool();
    const p2 = await pool();
    const inv = await invest(p1.productId, "1000");
    const owner = (await db.query("SELECT user_id FROM investments WHERE id = $1", [inv.investmentId])).rows[0].user_id;
    const a2 = (await db.query("SELECT id FROM product_pool_assignments WHERE pool_strategy_id = $1 LIMIT 1", [p2.strategyId])).rows[0].id;
    const insert = (weight: string, amount: string) =>
      db.query(
        `INSERT INTO pool_allocations (investment_id, user_id, pool_strategy_id, assignment_id, weight, amount, effective_from, effective_to)
         SELECT id, $2, $3, $4, $5, $6, start_at, maturity_at FROM investments WHERE id = $1`,
        [inv.investmentId, owner, p2.strategyId, a2, weight, amount],
      );
    await expect(insert("1", "1000")).rejects.toThrow(/> 100%/); // second full allocation to another pool
    await expect(insert("0.5", "600")).rejects.toThrow(/must equal principal/);
  });

  it("a posted run with eligible profit must reference its distribution entry", async () => {
    const p = await pool();
    await invest(p.productId, "5000");
    await appendScriptedTicks(db, p.inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [p.strategyId] });
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    await expect(db.query("UPDATE reward_runs SET status = 'posted', posted_at = now() WHERE id = $1", [runId])).rejects.toThrow(
      /reward_runs_posted_entries/,
    );
    await cancelRun(db, adminId, runId, "test");
  });

  it("a reward line can only be released once its run is posted", async () => {
    const p = await pool();
    await invest(p.productId, "5000");
    const runId = await calculateRun(db, adminId, { poolStrategyId: p.strategyId, periodEnd: nowIso() });
    const entry = await db.query("SELECT id FROM journal_entries LIMIT 1");
    await expect(
      db.query("UPDATE reward_run_lines SET released_entry_id = $2, released_at = now() WHERE run_id = $1", [runId, entry.rows[0].id]),
    ).rejects.toThrow(/not posted/);
    await cancelRun(db, adminId, runId, "test");
  });
});
