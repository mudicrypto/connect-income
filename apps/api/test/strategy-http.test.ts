import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, key, makeApp, sessionCookie, testDb } from "./helpers.js";
import { scriptedInstrument } from "./strategy-helpers.js";

const db = testDb();
let app: FastifyInstance;
let admin: { cookie: string };
let user: { cookie: string };
beforeAll(async () => {
  app = await makeApp(db, true);
  admin = await sessionCookie(db, (await createTestUser(db, "admin")).id);
  user = await sessionCookie(db, (await createTestUser(db)).id);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const json = { "content-type": "application/json" };
const ZERO_ID = "00000000-0000-0000-0000-000000000000";
const PROTECTED = [
  ["GET", "/api/admin/strategies"],
  ["POST", "/api/admin/strategies"],
  ["GET", `/api/admin/strategies/${ZERO_ID}`],
  ["POST", `/api/admin/strategies/${ZERO_ID}/pause`],
  ["POST", `/api/admin/strategies/${ZERO_ID}/resume`],
  ["POST", `/api/admin/strategies/${ZERO_ID}/allocations`],
  ["GET", "/api/admin/engine"],
  ["POST", "/api/admin/engine/run"],
  ["POST", "/api/admin/engine/kill-switch"],
  ["POST", "/api/admin/market/advance"],
] as const;

describe("strategy admin authorization", () => {
  it("rejects anonymous callers with 401 and non-admin users with 403", async () => {
    for (const [method, url] of PROTECTED) {
      const payload = method === "POST" ? {} : undefined;
      const headers = { ...json, "idempotency-key": key() };
      const anon = await app.inject({ method, url, headers, payload });
      expect(anon.statusCode, `anon ${method} ${url}`).toBe(401);
      const asUser = await app.inject({ method, url, headers: { ...headers, ...user }, payload });
      expect(asUser.statusCode, `user ${method} ${url}`).toBe(403);
    }
    // Nothing happened as a side effect of the rejected calls.
    const ks = await db.query("SELECT kill_switch FROM engine_settings");
    expect(ks.rows[0].kill_switch).toBe(false);
  });
});

describe("strategy admin workflow", () => {
  it("creates, funds, runs, pauses and resumes a strategy over HTTP", async () => {
    const inst = await scriptedInstrument(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/admin/strategies",
      headers: { ...json, ...admin },
      payload: {
        code: "HTTP-MOMO",
        name: "HTTP momentum",
        type: "trading",
        instrumentSymbol: inst.symbol,
        maxAllocation: "5000",
        maxPositionValue: "4000",
        maxExposureRatio: "0.8",
        dailyLossLimit: "500",
        maxDrawdownRatio: "0.2",
        params: { lookbackTicks: 1 },
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().strategy.id;
    expect(create.json()).toMatchObject({ simulated: true, strategy: { status: "active", allocatedCapital: "0.000000" } });

    const noKey = await app.inject({ method: "POST", url: `/api/admin/strategies/${id}/allocations`, headers: { ...json, ...admin }, payload: { amount: "1000" } });
    expect(noKey.statusCode).toBe(400);
    const over = await app.inject({
      method: "POST",
      url: `/api/admin/strategies/${id}/allocations`,
      headers: { ...json, ...admin, "idempotency-key": key() },
      payload: { amount: "5000.01" },
    });
    expect(over.statusCode).toBe(422);
    const alloc = await app.inject({
      method: "POST",
      url: `/api/admin/strategies/${id}/allocations`,
      headers: { ...json, ...admin, "idempotency-key": key() },
      payload: { amount: "1000" },
    });
    expect(alloc.statusCode).toBe(201);

    const runRes = await app.inject({ method: "POST", url: "/api/admin/engine/run", headers: { ...json, ...admin }, payload: {} });
    expect(runRes.json()).toMatchObject({ simulated: true, status: "completed" });

    const pause = await app.inject({ method: "POST", url: `/api/admin/strategies/${id}/pause`, headers: { ...json, ...admin }, payload: { reason: "review" } });
    expect(pause.json().strategy).toMatchObject({ status: "paused", pauseReason: "review" });
    const resume = await app.inject({ method: "POST", url: `/api/admin/strategies/${id}/resume`, headers: { ...json, ...admin }, payload: {} });
    expect(resume.json().strategy.status).toBe("active");
    const events = resume.json().events.map((e: { eventType: string }) => e.eventType);
    expect(events).toEqual(expect.arrayContaining(["created", "capital_allocated", "paused", "resumed"]));

    const integrity = await app.inject({ method: "GET", url: "/api/admin/ledger/integrity", headers: admin });
    expect(integrity.json()).toMatchObject({ ok: true });
  });

  it("validates strategy input on the server", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/strategies",
      headers: { ...json, ...admin },
      payload: {
        code: "BAD",
        name: "x",
        type: "staking",
        instrumentSymbol: "SIM-BTC-USDT", // spot instrument for a staking strategy
        maxAllocation: "1",
        maxPositionValue: "1",
        maxExposureRatio: "0.5",
        dailyLossLimit: "1",
        maxDrawdownRatio: "0.1",
      },
    });
    expect([404, 422]).toContain(bad.statusCode);
    const floaty = await app.inject({
      method: "POST",
      url: "/api/admin/strategies",
      headers: { ...json, ...admin },
      payload: { code: "BAD2", name: "x", type: "trading", instrumentSymbol: "SIM-BTC-USDT", maxAllocation: 1000 },
    });
    expect(floaty.statusCode).toBe(400);
  });

  it("advances the synthetic market idempotently and toggles the kill switch", async () => {
    const headers = { ...json, ...admin, "idempotency-key": key() };
    const a = await app.inject({ method: "POST", url: "/api/admin/market/advance", headers, payload: { ticks: 3 } });
    const b = await app.inject({ method: "POST", url: "/api/admin/market/advance", headers, payload: { ticks: 3 } });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json()).toEqual(a.json());
    const btc = a.json().advanced.find((x: { symbol: string }) => x.symbol === "SIM-BTC-USDT");
    const latest = await db.query(
      "SELECT max(seq)::int AS s FROM market_ticks t JOIN market_instruments i ON i.id = t.instrument_id WHERE i.symbol = 'SIM-BTC-USDT'",
    );
    expect(latest.rows[0].s).toBe(btc.toSeq);

    const on = await app.inject({ method: "POST", url: "/api/admin/engine/kill-switch", headers: { ...json, ...admin }, payload: { enabled: true, reason: "drill" } });
    expect(on.json().killSwitch).toMatchObject({ enabled: true, reason: "drill" });
    const off = await app.inject({ method: "POST", url: "/api/admin/engine/kill-switch", headers: { ...json, ...admin }, payload: { enabled: false } });
    expect(off.json().killSwitch.enabled).toBe(false);
  });
});
