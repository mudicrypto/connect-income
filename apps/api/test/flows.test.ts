import { afterAll, describe, expect, it } from "vitest";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { Money } from "../src/lib/money.js";
import { getUserBalances } from "../src/services/accounts.js";
import { simulatedDeposit } from "../src/services/deposits.js";
import { createInvestment, listInvestments, settleMaturedInvestments } from "../src/services/investments.js";
import { listTransactions } from "../src/services/transactions.js";
import { createTestProduct, createTestUser, fund, key, testDb } from "./helpers.js";

const db = testDb();
afterAll(() => db.end());

const usdt = async (userId: string) => (await getUserBalances(db, userId)).find((b) => b.asset === "USDT")!;
const expectLedgerOk = async () => expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
const invest = (userId: string, productId: string, amount: string, idempotencyKey = key()) =>
  createInvestment(db, { userId, productId, amount, idempotencyKey, allowDevOnly: false });

describe("simulated deposit", () => {
  it("credits the user's available balance through a balanced entry", async () => {
    const user = await createTestUser(db);
    const res = await fund(db, user.id, "1000.25");
    expect(res.statusCode).toBe(201);
    expect(res.body.availableBalance).toBe("1000.250000");
    expect(await usdt(user.id)).toEqual({ asset: "USDT", available: "1000.250000", invested: "0.000000", total: "1000.250000" });
    await expectLedgerOk();
  });

  it("replays the same idempotency key without double-crediting", async () => {
    const user = await createTestUser(db);
    const k = key();
    const a = await simulatedDeposit(db, { userId: user.id, amount: "50", idempotencyKey: k });
    const b = await simulatedDeposit(db, { userId: user.id, amount: "50", idempotencyKey: k });
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    expect((await usdt(user.id)).available).toBe("50.000000");
  });

  it("rejects reuse of a key with a different amount", async () => {
    const user = await createTestUser(db);
    const k = key();
    await simulatedDeposit(db, { userId: user.id, amount: "50", idempotencyKey: k });
    await expect(simulatedDeposit(db, { userId: user.id, amount: "60", idempotencyKey: k })).rejects.toThrow(
      /different request/,
    );
  });

  it("handles concurrent requests with the same key exactly once", async () => {
    const user = await createTestUser(db);
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => simulatedDeposit(db, { userId: user.id, amount: "25", idempotencyKey: k })),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await usdt(user.id)).available).toBe("25.000000");
    await expectLedgerOk();
  });

  it("rejects invalid and oversized amounts", async () => {
    const user = await createTestUser(db);
    await expect(fund(db, user.id, "-5")).rejects.toThrow(/positive decimal/);
    await expect(fund(db, user.id, "1.1234567")).rejects.toThrow(/6 decimal/);
    await expect(fund(db, user.id, "1000000.000001")).rejects.toThrow(/limited/);
  });
});

describe("fixed-term investments", () => {
  it("moves principal from available to invested and sets a maturity date", async () => {
    const user = await createTestUser(db);
    const product = await createTestProduct(db, { termMinutes: 30 * 1440 });
    await fund(db, user.id, "500");
    const res = await invest(user.id, product, "200.5");
    expect(res.statusCode).toBe(201);
    const inv = res.body;
    expect(inv.principal).toBe("200.500000");
    expect(inv.status).toBe("active");
    const termMs = new Date(inv.maturityAt).getTime() - new Date(inv.startAt).getTime();
    expect(termMs).toBe(30 * 86400_000);
    expect(await usdt(user.id)).toEqual({ asset: "USDT", available: "299.500000", invested: "200.500000", total: "500.000000" });

    const tx = await listTransactions(db, user.id);
    // Newest entry first; legs within one entry have no meaningful order.
    expect(tx.items.map((t) => t.entryType)).toEqual(["investment_open", "investment_open", "simulated_deposit"]);
    expect(tx.items.map((t) => [t.account, t.amount, t.balanceAfter]).sort()).toEqual([
      ["available", "-200.500000", "299.500000"],
      ["available", "500.000000", "500.000000"],
      ["invested", "200.500000", "200.500000"],
    ]);
    await expectLedgerOk();
  });

  it("rejects investments exceeding the available balance and leaves the ledger untouched", async () => {
    const user = await createTestUser(db);
    const product = await createTestProduct(db);
    await fund(db, user.id, "100");
    await expect(invest(user.id, product, "100.000001")).rejects.toThrow(/Insufficient/);
    expect(await usdt(user.id)).toMatchObject({ available: "100.000000", invested: "0.000000" });
    expect(await listInvestments(db, user.id)).toHaveLength(0);
    // A failed attempt must not consume the idempotency key permanently.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id = $1", [user.id]);
    expect(rows[0].n).toBe(1); // only the deposit
  });

  it("enforces product min, max and status", async () => {
    const user = await createTestUser(db);
    await fund(db, user.id, "10000");
    const product = await createTestProduct(db, { min: "100", max: "1000" });
    await expect(invest(user.id, product, "99.999999")).rejects.toThrow(/Minimum/);
    await expect(invest(user.id, product, "1000.000001")).rejects.toThrow(/Maximum/);
    const paused = await createTestProduct(db, { status: "paused" });
    await expect(invest(user.id, paused, "100")).rejects.toThrow(/not accepting/);
    const devOnly = await createTestProduct(db, { devOnly: true });
    await expect(invest(user.id, devOnly, "100")).rejects.toThrow(/not found/);
  });

  it("is idempotent per key", async () => {
    const user = await createTestUser(db);
    const product = await createTestProduct(db);
    await fund(db, user.id, "100");
    const k = key();
    const a = await invest(user.id, product, "40", k);
    const b = await invest(user.id, product, "40", k);
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect(await listInvestments(db, user.id)).toHaveLength(1);
    expect((await usdt(user.id)).available).toBe("60.000000");
  });

  it("never overspends under concurrent investment requests", async () => {
    const user = await createTestUser(db);
    const product = await createTestProduct(db);
    await fund(db, user.id, "100");
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => invest(user.id, product, "20")));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(5);
    for (const r of results) {
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/Insufficient/);
    }
    expect(await usdt(user.id)).toMatchObject({ available: "0.000000", invested: "100.000000" });
    await expectLedgerOk();
  });

  it("settles at maturity by returning principal exactly once", async () => {
    const user = await createTestUser(db);
    const product = await createTestProduct(db, { termMinutes: 60 });
    await fund(db, user.id, "300");
    const { body: inv } = await invest(user.id, product, "120");

    // Not yet mature.
    let res = await settleMaturedInvestments(db, { asOf: new Date(new Date(inv.maturityAt).getTime() - 1000) });
    expect(res.settled).not.toContain(inv.id);

    const after = new Date(new Date(inv.maturityAt).getTime() + 1000);
    const [r1, r2] = await Promise.all([
      settleMaturedInvestments(db, { asOf: after }),
      settleMaturedInvestments(db, { asOf: after }),
    ]);
    expect([...r1.settled, ...r2.settled].filter((id) => id === inv.id)).toHaveLength(1);
    res = await settleMaturedInvestments(db, { asOf: after });
    expect(res.settled).not.toContain(inv.id);

    const [settled] = await listInvestments(db, user.id);
    expect(settled!.status).toBe("matured");
    expect(settled!.settleEntryId).not.toBeNull();
    // Principal only: no reward is paid until strategy performance exists.
    expect(await usdt(user.id)).toEqual({ asset: "USDT", available: "300.000000", invested: "0.000000", total: "300.000000" });
    await expectLedgerOk();
  });

  it("matured investments cannot be modified", async () => {
    const { rows } = await db.query("SELECT id FROM investments WHERE status = 'matured' LIMIT 1");
    await expect(db.query("UPDATE investments SET status = 'active' WHERE id = $1", [rows[0].id])).rejects.toThrow(/final/);
    await expect(db.query("UPDATE investments SET principal = 1")).rejects.toThrow(/immutable|final/);
  });
});

describe("ledger consistency under a random workload", () => {
  it("keeps balances equal to the sum of postings and principal equal to positions", async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => createTestUser(db)));
    const product = await createTestProduct(db, { min: "0.000001", max: null, termMinutes: 10 });
    // Deterministic pseudo-random sequence (LCG) so failures are reproducible.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const expected = new Map(users.map((u) => [u.id, new Money(0)]));

    for (let i = 0; i < 60; i++) {
      const user = users[Math.floor(rand() * users.length)]!;
      const amount = new Money(Math.floor(rand() * 1_000_000_000)).div(1_000_000).toFixed(6);
      if (amount === "0.000000") continue;
      const op = rand();
      if (op < 0.4) {
        await fund(db, user.id, amount);
        expected.set(user.id, expected.get(user.id)!.plus(amount));
      } else if (op < 0.85) {
        await invest(user.id, product, amount).catch((e) => expect(String(e)).toMatch(/Insufficient/));
      } else {
        await settleMaturedInvestments(db, { asOf: new Date(Date.now() + 3600_000) });
      }
    }
    for (const u of users) {
      // Simulated deposits are the only inflow; investing and maturing only move funds between a user's own accounts.
      expect((await usdt(u.id)).total).toBe(expected.get(u.id)!.toFixed(6));
    }
    await expectLedgerOk();
  });
});
