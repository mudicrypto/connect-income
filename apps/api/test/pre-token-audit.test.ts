import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pendingMigrations } from "../src/db/migrate.js";
import { parseTransitionArgs } from "../src/db/legacy-transition-args.js";
import { withTransaction } from "../src/db/pool.js";
import { ensureAccount, ensureStrategyAccounts } from "../src/ledger/accounts.js";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { postEntry } from "../src/ledger/ledger.js";
import { Money } from "../src/lib/money.js";
import { appendScriptedTicks } from "../src/market/market.js";
import { calculateRewardsV2 } from "../src/rewards/calc.js";
import { transitionLegacyPool } from "../src/rewards/legacy-transition.js";
import { assignProductToPool, registerPool } from "../src/rewards/pools.js";
import { calculateRun, postRun, recomputeRunMismatches } from "../src/rewards/runs.js";
import { createInvestment } from "../src/services/investments.js";
import { allocateCapital } from "../src/strategy/strategies.js";
import { runEngine } from "../src/strategy/engine.js";
import { createTestProduct, createTestUser, fund, key, makeApp, sessionCookie, testDb } from "./helpers.js";
import { MOMENTUM_1, makeStrategy, registerLegacyV1Pool, scriptedInstrument } from "./strategy-helpers.js";

/**
 * Regression tests for the defects confirmed by the pre-token audit
 * (docs/pre-token-audit.md). Each test names the finding it covers.
 */

const db = testDb();
let adminId: string;
let app: FastifyInstance;
beforeAll(async () => {
  adminId = (await createTestUser(db, "admin")).id;
  app = await makeApp(db, true);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const json = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expectLedgerOk = async () => expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
const m = (v: string) => new Money(v);

describe("A1 startup never applies migrations implicitly", () => {
  it("reports pending migrations without applying them", async () => {
    expect(await pendingMigrations(db)).toEqual([]);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM schema_migrations WHERE name = '0008_legacy_loss_transition.sql'");
      expect(await pendingMigrations(client)).toEqual(["0008_legacy_loss_transition.sql"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("A2 legacy transition CLI defaults to a dry run and rejects unknown flags", () => {
  const base = ["--pool", "MOMO-BTC", "--expected", "15.174414", "--key", "k-12345678", "--approval", "Founder ok", "--approver", "a@x"];
  it("is a dry run unless --execute is given", () => {
    expect(parseTransitionArgs(base).dryRun).toBe(true);
    expect(parseTransitionArgs([...base, "--dry-run"]).dryRun).toBe(true);
    expect(parseTransitionArgs([...base, "--execute"]).dryRun).toBe(false);
  });
  it("rejects mistyped or ambiguous flags instead of executing", () => {
    expect(() => parseTransitionArgs([...base, "--dry-run=true"])).toThrow(/unknown/i);
    expect(() => parseTransitionArgs([...base, "--dryrun"])).toThrow(/unknown/i);
    expect(() => parseTransitionArgs([...base, "--execute", "--dry-run"])).toThrow(/both/i);
    expect(() => parseTransitionArgs(base.slice(0, -1))).toThrow(/approver/);
  });
});

describe("A3/A4/A5 legacy transition HTTP route", () => {
  async function legacyPoolWithLoss() {
    const inst = await scriptedInstrument(db, { feeBps: "10" });
    const poolId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params: MOMENTUM_1 });
    await registerLegacyV1Pool(db, adminId, poolId, "10000");
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: poolId });
    const u = await createTestUser(db);
    await fund(db, u.id, "10000");
    await createInvestment(db, { userId: u.id, productId, amount: "3000", idempotencyKey: key(), allowDevOnly: false });
    await appendScriptedTicks(db, inst.id, ["107", "95"]);
    await runEngine(db, { trigger: "test", strategyIds: [poolId] });
    await sleep(5);
    const run = await calculateRun(db, adminId, { poolStrategyId: poolId });
    await postRun(db, adminId, run);
    const cf = (await db.query("SELECT cf_close::text FROM reward_runs WHERE id = $1", [run])).rows[0].cf_close as string;
    return { poolId, cf: new Money(cf).toFixed() };
  }
  const post = async (poolId: string, headers: Record<string, string>, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/admin/rewards/pools/${poolId}/legacy-transition`, headers: { ...json, ...headers }, payload: payload as object });

  it("requires an admin session and an Idempotency-Key", async () => {
    const p = await legacyPoolWithLoss();
    const body = { expectedCarryForward: p.cf, approvalReference: "Founder approval ref", dryRun: true };
    expect((await post(p.poolId, { "idempotency-key": key() }, body)).statusCode).toBe(401);
    const user = await sessionCookie(db, (await createTestUser(db)).id);
    expect((await post(p.poolId, { ...user, "idempotency-key": key() }, body)).statusCode).toBe(403);
    const admin = await sessionCookie(db, adminId);
    expect((await post(p.poolId, admin, body)).statusCode).toBe(400);
  });

  it("rejects a non-boolean or missing dryRun instead of executing", async () => {
    const p = await legacyPoolWithLoss();
    const admin = await sessionCookie(db, adminId);
    for (const dryRun of ["true", undefined, 1]) {
      const res = await post(p.poolId, { ...admin, "idempotency-key": key() }, { expectedCarryForward: p.cf, approvalReference: "Founder approval ref", dryRun });
      expect(res.statusCode, String(dryRun)).toBe(400);
    }
    expect((await db.query("SELECT loss_model FROM reward_pools WHERE strategy_id = $1", [p.poolId])).rows[0].loss_model).toBe("pool_v1");
  });

  it("validates input as 400s, never 500s", async () => {
    const p = await legacyPoolWithLoss();
    const admin = await sessionCookie(db, adminId);
    const short = await post(p.poolId, { ...admin, "idempotency-key": key() }, { expectedCarryForward: p.cf, approvalReference: "ok", dryRun: false });
    expect(short.statusCode).toBe(400);
    const badId = await post("not-a-uuid", { ...admin, "idempotency-key": key() }, { expectedCarryForward: p.cf, approvalReference: "Founder approval ref", dryRun: true });
    expect([400, 404]).toContain(badId.statusCode);
  });

  it("refuses a replay whose parameters differ, and a key reused on another pool", async () => {
    const p = await legacyPoolWithLoss();
    const q = await legacyPoolWithLoss();
    const admin = await sessionCookie(db, adminId);
    const k = key();
    const body = { expectedCarryForward: p.cf, approvalReference: "Founder approval ref", dryRun: false };
    expect((await post(p.poolId, { ...admin, "idempotency-key": k }, body)).statusCode).toBe(200);
    const replay = await post(p.poolId, { ...admin, "idempotency-key": k }, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const wrongAmount = await post(p.poolId, { ...admin, "idempotency-key": k }, { ...body, expectedCarryForward: "1" });
    expect(wrongAmount.statusCode).toBe(409);
    const wrongApproval = await post(p.poolId, { ...admin, "idempotency-key": k }, { ...body, approvalReference: "Another approval" });
    expect(wrongApproval.statusCode).toBe(409);
    const dry = await post(p.poolId, { ...admin, "idempotency-key": k }, { ...body, dryRun: true });
    expect(dry.statusCode).toBe(409);
    const otherPool = await post(q.poolId, { ...admin, "idempotency-key": k }, { ...body, expectedCarryForward: q.cf });
    expect(otherPool.statusCode).toBe(409);
    expect((await db.query("SELECT loss_model FROM reward_pools WHERE strategy_id = $1", [q.poolId])).rows[0].loss_model).toBe("pool_v1");
    await expectLedgerOk();
  });
});

describe("A6 legacy runs reproduce from their own opening balances", () => {
  it("recomputes a v1 run that applied the reserve, and the pool can then be transitioned", async () => {
    const inst = await scriptedInstrument(db, { feeBps: "10" });
    const poolId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "10000", params: MOMENTUM_1 });
    await registerLegacyV1Pool(db, adminId, poolId, "10000");
    const productId = await createTestProduct(db);
    await assignProductToPool(db, adminId, { productId, poolStrategyId: poolId });
    const u = await createTestUser(db);
    await fund(db, u.id, "10000");
    await createInvestment(db, { userId: u.id, productId, amount: "5000", idempotencyKey: key(), allowDevOnly: false });
    const post = async () => {
      await sleep(5);
      const id = await calculateRun(db, adminId, { poolStrategyId: poolId });
      await postRun(db, adminId, id);
      return id;
    };
    await appendScriptedTicks(db, inst.id, ["102", "110", "105"]); // profit: builds a reserve
    await runEngine(db, { trigger: "test", strategyIds: [poolId] });
    const profitRun = await post();
    await appendScriptedTicks(db, inst.id, ["107", "95"]); // loss larger than the reserve
    await runEngine(db, { trigger: "test", strategyIds: [poolId] });
    const lossRun = await post();
    const r = (await db.query("SELECT reserve_applied::text, cf_close::text FROM reward_runs WHERE id = $1", [lossRun])).rows[0];
    expect(m(r.reserve_applied).gt(0)).toBe(true);
    expect(m(r.cf_close).gt(0)).toBe(true);
    await withTransaction(db, async (tx) => {
      expect(await recomputeRunMismatches(tx, profitRun)).toEqual([]);
      expect(await recomputeRunMismatches(tx, lossRun)).toEqual([]);
    });
    const res = await transitionLegacyPool(db, {
      poolStrategyId: poolId,
      expectedCarryForward: m(r.cf_close).toFixed(),
      transitionKey: key(),
      approvalReference: "Test approval reference",
      approvedBy: adminId,
      dryRun: false,
    });
    expect(res.dryRun).toBe(false);
    await expectLedgerOk();
  });
});

describe("C1 capital allocation journal key collision", () => {
  it("never shifts risk baselines or reports an allocation that posted nothing", async () => {
    const inst = await scriptedInstrument(db);
    const strategyId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    const otherAdmin = (await createTestUser(db, "admin")).id;
    const k = key();
    await allocateCapital(db, { actorUserId: adminId, strategyId, amount: "1000", idempotencyKey: k });
    const before = (await db.query("SELECT peak_equity::text, day_start_equity::text, last_equity::text FROM strategies WHERE id = $1", [strategyId])).rows[0];
    // Another admin happens to use the same key: either a separate, real allocation or a refusal — never a phantom.
    await allocateCapital(db, { actorUserId: otherAdmin, strategyId, amount: "5000", idempotencyKey: k }).catch(() => null);
    const after = (await db.query("SELECT peak_equity::text, day_start_equity::text, last_equity::text FROM strategies WHERE id = $1", [strategyId])).rows[0];
    const capital = (await db.query("SELECT balance::text AS b FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = 'strategy_capital'", [strategyId])).rows[0].b;
    const shift = m(after.peak_equity).minus(before.peak_equity);
    expect(shift.eq(m(capital).minus("2000"))).toBe(true); // baselines moved exactly as much as capital did
    expect(m(after.day_start_equity).minus(before.day_start_equity).eq(shift)).toBe(true);
    await expectLedgerOk();
  });
});

describe("R2 v2 attribution never exceeds the pool's realised P&L", () => {
  const alloc = (id: string, amount: string, overlap: string) => ({
    allocationId: id, investmentId: id, userId: id, amount: m(amount), overlapUs: m(overlap), lossOpen: m("0"), reserveOpen: m("0"),
  });
  for (const pnl of ["100", "-100"]) {
    it(`caps Σ attribution at R when allocations exceed paper capital (R = ${pnl})`, () => {
      // Paper capital integral 1000 × 1000 µs; allocations 1100 × 1000 µs (a race can admit this).
      const r = calculateRewardsV2({
        trades: [{ realisedPnl: m(pnl), fee: m("0") }],
        capitalIntegral: m("1000000"),
        allocations: [alloc("a", "600", "1000"), alloc("b", "500", "1000")],
        reserveRatio: m("0.1"),
        scale: 6,
      });
      // Profits are never over-attributed; losses only by the spec's rounding against the
      // investor (at most 1e-6 per line). Without the cap the excess was ~10% of R.
      expect(r.attributable.abs().lte(m(pnl).abs().plus(m("0.000001").times(r.lines.length)))).toBe(true);
      if (m(pnl).gt(0)) expect(r.attributable.lte(m(pnl))).toBe(true);
      expect(r.customerFraction.lte(1)).toBe(true);
    });
  }
});

describe("R4 a pool being closed cannot receive a product assignment", () => {
  it("assignment waits for the closing transaction and then refuses", async () => {
    const inst = await scriptedInstrument(db);
    const strategyId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    await registerPool(db, adminId, { strategyId, customerCapacity: "1000", periodMode: "ad_hoc" });
    const productId = await createTestProduct(db);
    const closer = await db.connect();
    try {
      await closer.query("BEGIN");
      await closer.query("SELECT 1 FROM reward_pools WHERE strategy_id = $1 FOR UPDATE", [strategyId]);
      await closer.query("UPDATE reward_pools SET status = 'closed' WHERE strategy_id = $1", [strategyId]);
      const assign = assignProductToPool(db, adminId, { productId, poolStrategyId: strategyId }).then(
        () => "assigned",
        (e: Error) => e.message,
      );
      await sleep(150);
      await closer.query("COMMIT");
      expect(await assign).toMatch(/closed pool/);
    } finally {
      closer.release();
    }
  });
});

describe("L5 posting ids follow the account lock order", () => {
  it("keeps each account's running balance monotonic in id order under concurrency", async () => {
    const u = await createTestUser(db);
    const a = await db.connect();
    const b = await db.connect();
    try {
      const custody = await withTransaction(db, (tx) => ensureAccount(tx, "platform_sim_custody", "USDT"));
      const deposit = (tx: typeof a, amount: string) =>
        postEntry(tx, {
          entryType: "simulated_deposit",
          idempotencyKey: key(),
          description: "test",
          postings: [
            { accountId: custody, direction: "debit", amount: m(amount) },
            { accountId: u.accounts.available, direction: "credit", amount: m(amount) },
          ],
        });
      await a.query("BEGIN");
      await deposit(a, "1");
      await b.query("BEGIN");
      const blocked = deposit(b, "100"); // takes a posting id now, then waits for A's account locks
      await sleep(150);
      await deposit(a, "10"); // A's second posting on the same account
      await a.query("COMMIT");
      await blocked;
      await b.query("COMMIT");
    } finally {
      a.release();
      b.release();
    }
    const rows = (
      await db.query("SELECT balance_after::text AS b FROM ledger_postings WHERE account_id = $1 ORDER BY id", [u.accounts.available])
    ).rows.map((r) => m(r.b).toFixed());
    expect(rows).toEqual(["1", "11", "111"]);
    await expectLedgerOk();
  });
});

describe("L3/L4/L6/L9 database guards on the ledger shape", () => {
  const rawEntry = async (entryType: string, postings: Array<[string, "debit" | "credit", string]>) =>
    withTransaction(db, async (tx) => {
      const e = await tx.query<{ id: string }>(
        "INSERT INTO journal_entries (entry_type, idempotency_key, description) VALUES ($1, $2, 'raw test') RETURNING id",
        [entryType, key()],
      );
      for (const [acct, dir, amt] of postings) {
        const asset = (await tx.query("SELECT asset FROM ledger_accounts WHERE id = $1", [acct])).rows[0].asset;
        await tx.query(
          "INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, $3, $4, $5, 0)",
          [e.rows[0]!.id, acct, asset, dir, amt],
        );
      }
    });

  it("rejects an entry type touching accounts it may not touch", async () => {
    const u = await createTestUser(db);
    await fund(db, u.id, "100");
    const custody = await withTransaction(db, (tx) => ensureAccount(tx, "platform_sim_custody", "USDT"));
    // A "deposit" straight into invested principal, and a "reward release" funded by custody.
    await expect(rawEntry("simulated_deposit", [[custody, "debit", "5"], [u.accounts.invested, "credit", "5"]])).rejects.toThrow(/not allowed/);
    await expect(rawEntry("reward_release", [[custody, "debit", "5"], [u.accounts.available, "credit", "5"]])).rejects.toThrow(/not allowed/);
    await expectLedgerOk();
  });

  it("rejects an entry that touches two strategies' accounts", async () => {
    const i1 = await scriptedInstrument(db);
    const s1 = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: i1.symbol, capital: "100", params: MOMENTUM_1 });
    const s2 = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: i1.symbol, capital: "100", params: MOMENTUM_1 });
    const a1 = await withTransaction(db, (tx) => ensureStrategyAccounts(tx, s1, "USDT"));
    const a2 = await withTransaction(db, (tx) => ensureStrategyAccounts(tx, s2, "USDT"));
    await expect(rawEntry("strategy_capital_allocation", [[a1.cash, "debit", "5"], [a2.capital, "credit", "5"]])).rejects.toThrow(/more than one strategy/);
  });

  it("rejects amounts beyond the asset scale, in postEntry and in the database", async () => {
    const u = await createTestUser(db);
    const custody = await withTransaction(db, (tx) => ensureAccount(tx, "platform_sim_custody", "USDT"));
    const posting = (amount: string) => [
      { accountId: custody, direction: "debit" as const, amount: m(amount) },
      { accountId: u.accounts.available, direction: "credit" as const, amount: m(amount) },
    ];
    await expect(
      withTransaction(db, (tx) => postEntry(tx, { entryType: "simulated_deposit", idempotencyKey: key(), description: "t", postings: posting("1.0000001") })),
    ).rejects.toThrow(/scale/);
    await expect(rawEntry("simulated_deposit", [[custody, "debit", "1.0000001"], [u.accounts.available, "credit", "1.0000001"]])).rejects.toThrow(/scale/);
  });

  it("rejects account rows that could hide an overdraft or start with a balance", async () => {
    const u = await createTestUser(db);
    await expect(db.query("UPDATE ledger_accounts SET allow_negative = TRUE WHERE id = $1", [u.accounts.available])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE ledger_accounts SET code = code || 'x' WHERE id = $1", [u.accounts.available])).rejects.toThrow(/immutable/);
    const v = await createTestUser(db, "user");
    await expect(
      db.query(
        `INSERT INTO ledger_accounts (code, name, category, normal_balance, purpose, asset, owner_user_id, balance)
         VALUES ($1, 'x', 'liability', 'credit', 'user_reward_pending', 'USDT', $2, 1000)`,
        [`TEST-${key()}`, v.id],
      ),
    ).rejects.toThrow(/zero balance/);
    await expect(
      db.query(
        `INSERT INTO ledger_accounts (code, name, category, normal_balance, purpose, asset, owner_user_id)
         VALUES ($1, 'x', 'liability', 'debit', 'user_reward_pending', 'USDT', $2)`,
        [`TEST-${key()}`, v.id],
      ),
    ).rejects.toThrow(/purpose/);
  });
});

describe("R7 calculated runs are frozen", () => {
  it("rejects changing loss_model or attribution_residual on a calculated run", async () => {
    const inst = await scriptedInstrument(db);
    const strategyId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    await registerPool(db, adminId, { strategyId, customerCapacity: "1000", periodMode: "ad_hoc" });
    await sleep(5);
    const run = await calculateRun(db, adminId, { poolStrategyId: strategyId });
    await expect(db.query("UPDATE reward_runs SET loss_model = 'pool_v1' WHERE id = $1", [run])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE reward_runs SET attribution_residual = 1 WHERE id = $1", [run])).rejects.toThrow(/immutable/);
  });
});

describe("S1 simulated deposit faucet follows DEV_MODE", () => {
  it("returns 404 when DEV_MODE is off", async () => {
    const prod = await makeApp(db, false);
    try {
      const u = await createTestUser(db);
      const res = await prod.inject({
        method: "POST",
        url: "/api/deposits/simulated",
        headers: { ...json, ...(await sessionCookie(db, u.id)), "idempotency-key": key() },
        payload: { amount: "1000000" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });
});

describe("S4 malformed identifiers are client errors, not 500s", () => {
  it("answers 400/404 for malformed ids and cursors", async () => {
    const u = await sessionCookie(db, (await createTestUser(db)).id);
    const admin = await sessionCookie(db, adminId);
    const fake = "a".repeat(36);
    const cases: Array<[string, string, Record<string, string>, unknown]> = [
      ["GET", `/api/investments/${fake}/rewards`, u, undefined],
      ["POST", "/api/investments", { ...u, "idempotency-key": key() }, { productId: fake, amount: "10" }],
      ["GET", "/api/transactions?before=99999999999999999999999", u, undefined],
      ["GET", `/api/admin/rewards/pools/${fake}/settlement`, admin, undefined],
      ["POST", `/api/admin/rewards/pools/not-a-uuid/settle-reserves`, { ...admin, "idempotency-key": key() }, {}],
      ["POST", `/api/admin/rewards/pools/not-a-uuid/period-mode`, admin, { periodMode: "daily_utc" }],
      ["PATCH", `/api/admin/rewards/pools/not-a-uuid`, admin, { status: "closed" }],
    ];
    for (const [method, url, headers, payload] of cases) {
      const res = await app.inject({ method: method as "GET", url, headers: { ...json, ...headers }, payload: payload as object });
      expect([400, 404], `${method} ${url}: ${res.body}`).toContain(res.statusCode);
    }
  });
});

describe("S6 market advance replay writes no second audit row", () => {
  it("audits once per idempotent request", async () => {
    const admin2 = (await createTestUser(db, "admin")).id;
    const cookie = await sessionCookie(db, admin2);
    const k = key();
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/api/admin/market/advance", headers: { ...json, ...cookie, "idempotency-key": k }, payload: { ticks: 1 } });
      expect(res.statusCode).toBe(201);
    }
    const n = (await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id = $1 AND action = 'market.advance'", [admin2])).rows[0].n;
    expect(n).toBe(1);
  });
});

describe("A6b the history digest is reproducible from any session", () => {
  it("does not depend on the session TimeZone or DateStyle", async () => {
    const { historyDigest } = await import("../src/rewards/legacy-transition.js");
    const inst = await scriptedInstrument(db);
    const strategyId = await makeStrategy(db, adminId, { type: "trading", instrumentSymbol: inst.symbol, capital: "1000", params: MOMENTUM_1 });
    const digest = (tz: string) =>
      withTransaction(db, async (tx) => {
        await tx.query(`SET LOCAL TimeZone = '${tz}'`);
        await tx.query("SET LOCAL DateStyle = 'SQL, DMY'");
        return historyDigest(tx, strategyId);
      });
    expect(await digest("Pacific/Auckland")).toBe(await digest("America/Los_Angeles"));
  });
});
