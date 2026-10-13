import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { Money } from "../src/lib/money.js";
import { appendScriptedTicks } from "../src/market/market.js";
import { attributeLegacyLoss, transitionLegacyPool, type EvidenceRun } from "../src/rewards/legacy-transition.js";
import { assignProductToPool } from "../src/rewards/pools.js";
import { calculateRun, postRun } from "../src/rewards/runs.js";
import { createInvestment } from "../src/services/investments.js";
import { runEngine } from "../src/strategy/engine.js";
import { createTestProduct, createTestUser, fund, key, testDb } from "./helpers.js";
import { MOMENTUM_1, makeStrategy, registerLegacyV1Pool, scriptedInstrument } from "./strategy-helpers.js";

const m = (v: string) => new Money(v);
const run = (id: string, cfOpen: string, cfClose: string, attributable: string, lines: Array<[string, string]>, extra: Partial<EvidenceRun> = {}): EvidenceRun => ({
  id,
  cfOpen: m(cfOpen),
  cfClose: m(cfClose),
  attributable: m(attributable),
  cfRecovered: m("0"),
  reserveApplied: m("0"),
  lines: lines.map(([allocationId, w]) => ({ allocationId, weightedAllocation: m(w) })),
  ...extra,
});
const allocs = [
  { allocationId: "alice", investmentId: "inv-alice", userId: "u-alice" },
  { allocationId: "bob", investmentId: "inv-bob", userId: "u-bob" },
];

describe("Option A attribution (pure)", () => {
  it("attributes the whole carry-forward, exactly, to the single responsible investment", () => {
    const plan = attributeLegacyLoss({
      postedV1Runs: [run("r1", "0", "15.174414000000000000", "-15.174414", [["alice", "37707232000"]])],
      allocations: allocs,
      expectedCarryForward: m("15.174414"),
    });
    expect(plan.lines).toEqual([{ allocationId: "alice", investmentId: "inv-alice", userId: "u-alice", lossAmount: "15.174414", contributingRuns: ["r1"] }]);
  });

  it("never attributes to investors who only joined after the loss (no carry-forward change while they were in)", () => {
    const plan = attributeLegacyLoss({
      postedV1Runs: [
        run("r1", "0", "15.174414", "-15.174414", [["alice", "100"]]),
        run("r2", "15.174414", "15.174414", "0", [["alice", "100"], ["bob", "100"]]), // flat period, Bob present
      ],
      allocations: allocs,
      expectedCarryForward: m("15.174414"),
    });
    expect(plan.lines.map((l) => l.allocationId)).toEqual(["alice"]);
    expect(plan.contributingRuns).toEqual(["r1"]);
  });

  it("aborts on an incorrect approved amount, at full decimal precision", () => {
    const runs = [run("r1", "0", "15.174414", "-15.174414", [["alice", "1"]])];
    expect(() => attributeLegacyLoss({ postedV1Runs: runs, allocations: allocs, expectedCarryForward: m("15.17441") })).toThrow(/not the approved/);
    expect(() => attributeLegacyLoss({ postedV1Runs: runs, allocations: allocs, expectedCarryForward: m("15.174415") })).toThrow(/not the approved/);
    expect(() => attributeLegacyLoss({ postedV1Runs: runs, allocations: allocs, expectedCarryForward: m("15.1744139999") })).toThrow(/not the approved/);
    // Trailing zeros are the same number: no rounding is involved anywhere.
    expect(attributeLegacyLoss({ postedV1Runs: runs, allocations: allocs, expectedCarryForward: m("15.17441400000") }).lines[0]!.lossAmount).toBe("15.174414");
  });

  it("aborts when more than one investment is responsible (ambiguous)", () => {
    expect(() =>
      attributeLegacyLoss({
        postedV1Runs: [run("r1", "0", "30", "-30", [["alice", "1"], ["bob", "1"]])],
        allocations: allocs,
        expectedCarryForward: m("30"),
      }),
    ).toThrow(/2 investments/);
    // Also when different investments drove different contributing runs (e.g. loss then partial recovery).
    expect(() =>
      attributeLegacyLoss({
        postedV1Runs: [run("r1", "0", "30", "-30", [["alice", "1"]]), run("r2", "30", "20", "10", [["bob", "1"]], { cfRecovered: m("10") })],
        allocations: allocs,
        expectedCarryForward: m("20"),
      }),
    ).toThrow(/ambiguous|2 investments/);
  });

  it("aborts when the responsible investment cannot be found", () => {
    expect(() =>
      attributeLegacyLoss({ postedV1Runs: [run("r1", "0", "5", "-5", [["ghost", "1"]])], allocations: allocs, expectedCarryForward: m("5") }),
    ).toThrow(/no matching investment/);
  });

  it("aborts on a broken carry-forward chain, on zero, and without history", () => {
    expect(() =>
      attributeLegacyLoss({ postedV1Runs: [run("r1", "1", "5", "-4", [["alice", "1"]])], allocations: allocs, expectedCarryForward: m("5") }),
    ).toThrow(/opens at/);
    expect(() =>
      attributeLegacyLoss({ postedV1Runs: [run("r1", "0", "0", "0", [["alice", "1"]])], allocations: allocs, expectedCarryForward: m("0") }),
    ).toThrow(/zero/);
    expect(() => attributeLegacyLoss({ postedV1Runs: [], allocations: allocs, expectedCarryForward: m("1") })).toThrow(/no posted/);
  });
});

// ---------------------------------------------------------------------------
// Database scenarios mirroring MOMO-BTC: one investor in a losing v1 period,
// then a second investor who joined after the loss.
// ---------------------------------------------------------------------------

const db = testDb();
let adminId: string;
beforeAll(async () => {
  adminId = (await createTestUser(db, "admin")).id;
});
afterAll(() => db.end());

const expectLedgerOk = async () => expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function legacyPool(o: { lossInvestors?: number } = {}) {
  const inst = await scriptedInstrument(db, { feeBps: "10" });
  const poolId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params: MOMENTUM_1 });
  await registerLegacyV1Pool(db, adminId, poolId, "10000");
  const productId = await createTestProduct(db);
  await assignProductToPool(db, adminId, { productId, poolStrategyId: poolId });
  const invest = async (amount: string) => {
    const u = await createTestUser(db);
    await fund(db, u.id, "10000");
    const inv = await createInvestment(db, { userId: u.id, productId, amount, idempotencyKey: key(), allowDevOnly: false });
    return { userId: u.id, investmentId: inv.body.id as string };
  };
  const post = async () => {
    await sleep(5);
    const id = await calculateRun(db, adminId, { poolStrategyId: poolId });
    await postRun(db, adminId, id);
    return id;
  };
  const responsible = [];
  for (let i = 0; i < (o.lossInvestors ?? 1); i++) responsible.push(await invest("3000"));
  await appendScriptedTicks(db, inst.id, ["107", "95"]); // a realised loss
  await runEngine(db, { trigger: "test", strategyIds: [poolId] });
  const lossRun = await post();
  const later = await invest("2000"); // joined after the loss
  const flatRun = await post(); // flat period with both: carry-forward unchanged
  const cf = (await db.query("SELECT cf_close::text FROM reward_runs WHERE id = $1", [flatRun])).rows[0].cf_close as string;
  return { inst, poolId, responsible, later, lossRun, flatRun, cf };
}

/** Byte-level snapshot of the pool's history: runs, lines and the strategy's ledger postings. */
async function snapshot(poolId: string) {
  const q = async (sql: string) => (await db.query(sql, [poolId])).rows.map((r) => r.t).join("\n");
  return [
    await q("SELECT r::text AS t FROM reward_runs r WHERE r.pool_strategy_id = $1 ORDER BY r.id"),
    await q("SELECT l::text AS t FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id WHERE r.pool_strategy_id = $1 ORDER BY l.id"),
    await q("SELECT p::text AS t FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE a.owner_strategy_id = $1 ORDER BY p.id"),
  ].join("\n--\n");
}
/** Result shape of a non-dry-run transition. */
type Executed = { replayed: boolean; transition: { id: string; sourceRunId: string; method: string }; lines: Array<Record<string, string>> };
const transitionsFor = async (poolId: string) =>
  (await db.query("SELECT count(*)::int AS n FROM legacy_loss_transitions WHERE pool_strategy_id = $1", [poolId])).rows[0].n as number;
const modelOf = async (poolId: string) => (await db.query("SELECT loss_model, transition_required FROM reward_pools WHERE strategy_id = $1", [poolId])).rows[0];
const base = (poolId: string, expected: string, k = key()) => ({
  poolStrategyId: poolId,
  expectedCarryForward: expected,
  transitionKey: k,
  approvalReference: "Founder decision: Option A (test)",
  approvedBy: adminId,
});

describe("legacy pool transition (database)", () => {
  it("dry run plans the transition without writing anything", async () => {
    const p = await legacyPool();
    expect(new Money(p.cf).gt(0)).toBe(true);
    const before = await snapshot(p.poolId);
    const res = await transitionLegacyPool(db, { ...base(p.poolId, p.cf), dryRun: true });
    expect(res).toMatchObject({ dryRun: true, plan: { lines: [{ investmentId: p.responsible[0]!.investmentId, lossAmount: new Money(p.cf).toFixed() }] } });
    expect(await transitionsFor(p.poolId)).toBe(0);
    expect((await modelOf(p.poolId)).loss_model).toBe("pool_v1");
    expect(await snapshot(p.poolId)).toBe(before);
  });

  it("aborts on an incorrect source amount and changes nothing", async () => {
    const p = await legacyPool();
    const wrong = new Money(p.cf).plus("0.000001").toFixed();
    await expect(transitionLegacyPool(db, base(p.poolId, wrong))).rejects.toThrow(/not the approved/);
    expect(await transitionsFor(p.poolId)).toBe(0);
    expect(await modelOf(p.poolId)).toEqual({ loss_model: "pool_v1", transition_required: false });
  });

  it("attributes the carry-forward to the responsible investment only, preserves history byte-for-byte, and is idempotent", async () => {
    const p = await legacyPool();
    const before = await snapshot(p.poolId);
    const k = key();
    const res = (await transitionLegacyPool(db, base(p.poolId, p.cf, k))) as Executed;
    expect(res).toMatchObject({ replayed: false, transition: { sourceRunId: p.flatRun, method: "option_a_responsible_investments" } });
    expect(res.lines).toEqual([expect.objectContaining({ investmentId: p.responsible[0]!.investmentId, lossAmount: p.cf })]);
    // Reconciliation: Σ per-investment balances = original carry-forward; the later investor gets nothing.
    const lines = (await db.query("SELECT investment_id, loss_amount::text FROM legacy_loss_transition_lines")).rows.filter(
      (l) => l.investment_id === p.responsible[0]!.investmentId || l.investment_id === p.later.investmentId,
    );
    expect(lines).toEqual([{ investment_id: p.responsible[0]!.investmentId, loss_amount: p.cf }]);
    expect(await modelOf(p.poolId)).toEqual({ loss_model: "investment_v2", transition_required: false });
    expect(await snapshot(p.poolId)).toBe(before);
    // Audit record with evidence, no credentials.
    const auditRow = (await db.query("SELECT details FROM audit_logs WHERE action = 'pool.legacy_transition' AND target_id = $1", [p.poolId])).rows[0];
    expect(new Money(auditRow.details.sourceCarryForward).eq(p.cf)).toBe(true);
    expect(auditRow.details.approvalReference).toBe("Founder decision: Option A (test)");
    expect(JSON.stringify(auditRow.details)).not.toMatch(/password|token|secret/i);
    // Retry with the same key: same result, no second record. Different key: refused.
    const again = await transitionLegacyPool(db, base(p.poolId, p.cf, k));
    expect(again).toMatchObject({ replayed: true, transition: { id: res.transition.id } });
    await expect(transitionLegacyPool(db, base(p.poolId, p.cf))).rejects.toThrow(/already been transitioned/);
    expect(await transitionsFor(p.poolId)).toBe(1);
    await expect(db.query("DELETE FROM legacy_loss_transition_lines")).rejects.toThrow(/append-only/);
    await expectLedgerOk();
  });

  it("concurrent executions produce exactly one transition", async () => {
    const p = await legacyPool();
    const k = key();
    const results = await Promise.allSettled([1, 2, 3].map(() => transitionLegacyPool(db, base(p.poolId, p.cf, k))));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const ok = results.map((r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value);
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await transitionsFor(p.poolId)).toBe(1);
    await expectLedgerOk();
  });

  it("after the transition, the responsible investor recovers their own loss first; the later investor is paid normally", async () => {
    const p = await legacyPool();
    await transitionLegacyPool(db, base(p.poolId, p.cf));
    await appendScriptedTicks(db, p.inst.id, ["97", "99", "98"]); // realised profit
    await runEngine(db, { trigger: "test", strategyIds: [p.poolId] });
    await sleep(5);
    const id = await calculateRun(db, adminId, { poolStrategyId: p.poolId });
    await postRun(db, adminId, id);
    const ls = (await db.query("SELECT investment_id, loss_open::text, loss_recovered::text, attributable::text, reward::text FROM reward_run_lines WHERE run_id = $1", [id])).rows;
    const a = ls.find((l) => l.investment_id === p.responsible[0]!.investmentId)!;
    const b = ls.find((l) => l.investment_id === p.later.investmentId)!;
    expect(a.loss_open).toBe(p.cf); // opening balance = transition amount
    expect(new Money(a.loss_recovered).eq(Money.min(new Money(a.attributable), new Money(p.cf)))).toBe(true);
    expect(b.loss_open).toBe("0.000000000000000000"); // never inherits the legacy loss
    expect(new Money(b.reward).gt(0)).toBe(true);
    await expectLedgerOk();
  });

  it("aborts safely when attribution is ambiguous (two investors in the losing period)", async () => {
    const p = await legacyPool({ lossInvestors: 2 });
    const before = await snapshot(p.poolId);
    await expect(transitionLegacyPool(db, base(p.poolId, p.cf))).rejects.toThrow(/ambiguous|2 investments/);
    expect(await transitionsFor(p.poolId)).toBe(0);
    expect((await modelOf(p.poolId)).loss_model).toBe("pool_v1");
    expect(await snapshot(p.poolId)).toBe(before);
  });

  it("aborts when the pool holds a legacy reserve (not covered by Option A)", async () => {
    // Under v1 a positive carry-forward and a positive reserve cannot coexist (the reserve absorbs
    // losses before the carry-forward grows), so this guard is defence in depth: a profit-only pool.
    const inst = await scriptedInstrument(db, { feeBps: "10" });
    const poolId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params: MOMENTUM_1 });
    await registerLegacyV1Pool(db, adminId, poolId, "10000");
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: poolId });
    const u = await createTestUser(db);
    await fund(db, u.id, "10000");
    await createInvestment(db, { userId: u.id, productId, amount: "5000", idempotencyKey: key(), allowDevOnly: false });
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]);
    await runEngine(db, { trigger: "test", strategyIds: [poolId] });
    const id = await calculateRun(db, adminId, { poolStrategyId: poolId });
    await postRun(db, adminId, id);
    const reserve = (await db.query("SELECT balance::text AS b FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = 'pool_reserve'", [poolId])).rows[0].b;
    expect(new Money(reserve).gt(0)).toBe(true);
    await expect(transitionLegacyPool(db, base(poolId, "1"))).rejects.toThrow(/Legacy reserve/);
    expect(await transitionsFor(poolId)).toBe(0);
    expect((await modelOf(poolId)).loss_model).toBe("pool_v1");
  });

  it("rolls back completely when the ledger integrity check fails", async () => {
    const p = await legacyPool();
    let calls = 0;
    const failing = async () => (++calls === 2 ? ["simulated integrity failure"] : []); // pass before, fail after
    await expect(transitionLegacyPool(db, { ...base(p.poolId, p.cf), integrityCheck: failing })).rejects.toThrow(/integrity problems after/);
    expect(await transitionsFor(p.poolId)).toBe(0);
    expect((await modelOf(p.poolId)).loss_model).toBe("pool_v1");
    await expect(transitionLegacyPool(db, { ...base(p.poolId, p.cf), integrityCheck: async () => ["pre-existing problem"] })).rejects.toThrow(
      /problems exist/,
    );
  });

  it("the database itself rejects a transition that does not reconcile or leaves the pool on v1", async () => {
    const p = await legacyPool();
    const alloc = (await db.query("SELECT id, investment_id, user_id FROM pool_allocations WHERE investment_id = $1", [p.responsible[0]!.investmentId])).rows[0];
    const attempt = async (amount: string, switchPool: boolean) => {
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        const t = await c.query(
          `INSERT INTO legacy_loss_transitions (pool_strategy_id, transition_key, method, source_run_id, source_carry_forward, source_reserve,
             formula, evidence, approval_reference, approved_by)
           VALUES ($1, $2, 'option_a_responsible_investments', $3, $4, 0, 'f', '{}', 'raw attempt', $5) RETURNING id`,
          [p.poolId, key(), p.flatRun, p.cf, adminId],
        );
        await c.query(
          "INSERT INTO legacy_loss_transition_lines (transition_id, allocation_id, investment_id, user_id, loss_amount, evidence) VALUES ($1, $2, $3, $4, $5, '{}')",
          [t.rows[0].id, alloc.id, alloc.investment_id, alloc.user_id, amount],
        );
        if (switchPool) await c.query("UPDATE reward_pools SET loss_model = 'investment_v2', transition_required = FALSE WHERE strategy_id = $1", [p.poolId]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    };
    await expect(attempt(new Money(p.cf).minus("0.000001").toFixed(), true)).rejects.toThrow(/does not reconcile/);
    await expect(attempt(p.cf, false)).rejects.toThrow(/must move to investment_v2/);
    expect(await transitionsFor(p.poolId)).toBe(0);
    await expectLedgerOk();
  });
});
