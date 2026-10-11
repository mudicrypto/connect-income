import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestProduct, createTestUser, fund, key, makeApp, sessionCookie, testDb } from "./helpers.js";

const db = testDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp(db, true);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const json = { "content-type": "application/json" };

describe("authentication", () => {
  it("rejects unauthenticated access to every protected endpoint", async () => {
    for (const [method, url] of [
      ["GET", "/api/balances"],
      ["GET", "/api/dashboard"],
      ["GET", "/api/products"],
      ["GET", "/api/investments"],
      ["GET", "/api/transactions"],
      ["POST", "/api/deposits/simulated"],
      ["POST", "/api/investments"],
      ["GET", "/api/admin/ledger/integrity"],
      ["POST", "/api/admin/investments/settle-matured"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { ...json, "idempotency-key": key() }, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("registers, logs in, and logs out", async () => {
    const email = `alice-${Date.now()}@example.com`;
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: json,
      payload: { email, password: "correct horse battery", displayName: "Alice" },
    });
    expect(reg.statusCode).toBe(201);
    const setCookie = String(reg.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);

    const dup = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: json,
      payload: { email: email.toUpperCase(), password: "correct horse battery", displayName: "Alice2" },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({ method: "POST", url: "/api/auth/login", headers: json, payload: { email, password: "wrong password!" } });
    expect(bad.statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: json, payload: { email, password: "correct horse battery" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "ci_session")!;
    const headers = { cookie: `ci_session=${cookie.value}` };
    expect((await app.inject({ method: "GET", url: "/api/balances", headers })).statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    expect((await app.inject({ method: "GET", url: "/api/balances", headers })).statusCode).toBe(401);
  });

  it("rejects weak passwords and malformed emails", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: json,
      payload: { email: "not-an-email", password: "short", displayName: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("dev login works only in dev mode", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: json, payload: {} })).statusCode).toBe(200);
    const prod = await makeApp(db, false);
    expect((await prod.inject({ method: "POST", url: "/api/auth/dev-login", headers: json, payload: {} })).statusCode).toBe(404);
    await prod.close();
  });
});

describe("authorization and isolation", () => {
  it("users only see their own investments and transactions", async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const product = await createTestProduct(db);
    await fund(db, alice.id, "100");
    const aliceCookie = await sessionCookie(db, alice.id);
    const bobCookie = await sessionCookie(db, bob.id);
    const created = await app.inject({
      method: "POST",
      url: "/api/investments",
      headers: { ...json, ...aliceCookie, "idempotency-key": key() },
      payload: { productId: product, amount: "60" },
    });
    expect(created.statusCode).toBe(201);

    const bobInv = await app.inject({ method: "GET", url: "/api/investments", headers: bobCookie });
    expect(bobInv.json().investments).toEqual([]);
    const bobTx = await app.inject({ method: "GET", url: "/api/transactions", headers: bobCookie });
    expect(bobTx.json().items).toEqual([]);
    const bobBal = await app.inject({ method: "GET", url: "/api/balances", headers: bobCookie });
    expect(bobBal.json().balances[0]).toMatchObject({ available: "0.000000", invested: "0.000000" });

    // Bob cannot spend Alice's funds: investing uses only the caller's accounts.
    const bobAttempt = await app.inject({
      method: "POST",
      url: "/api/investments",
      headers: { ...json, ...bobCookie, "idempotency-key": key() },
      payload: { productId: product, amount: "10" },
    });
    expect(bobAttempt.statusCode).toBe(422);
  });

  it("admin endpoints require the admin role", async () => {
    const user = await createTestUser(db);
    const admin = await createTestUser(db, "admin");
    const userRes = await app.inject({ method: "GET", url: "/api/admin/ledger/integrity", headers: await sessionCookie(db, user.id) });
    expect(userRes.statusCode).toBe(403);
    const adminRes = await app.inject({ method: "GET", url: "/api/admin/ledger/integrity", headers: await sessionCookie(db, admin.id) });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json()).toMatchObject({ ok: true, problems: [] });
  });
});

describe("financial endpoint hygiene", () => {
  it("requires an Idempotency-Key header", async () => {
    const user = await createTestUser(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/deposits/simulated",
      headers: { ...json, ...(await sessionCookie(db, user.id)) },
      payload: { amount: "10" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it("rejects non-JSON bodies (CSRF hardening)", async () => {
    const user = await createTestUser(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/deposits/simulated",
      headers: { "content-type": "text/plain", ...(await sessionCookie(db, user.id)), "idempotency-key": key() },
      payload: '{"amount":"10"}',
    });
    expect(res.statusCode).toBe(415);
  });

  it("rejects numeric (float) amounts; amounts must be strings", async () => {
    const user = await createTestUser(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/deposits/simulated",
      headers: { ...json, ...(await sessionCookie(db, user.id)), "idempotency-key": key() },
      payload: { amount: 10.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("replays return the original response with a replay header", async () => {
    const user = await createTestUser(db);
    const headers = { ...json, ...(await sessionCookie(db, user.id)), "idempotency-key": key() };
    const a = await app.inject({ method: "POST", url: "/api/deposits/simulated", headers, payload: { amount: "10" } });
    const b = await app.inject({ method: "POST", url: "/api/deposits/simulated", headers, payload: { amount: "10" } });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json()).toEqual(a.json());
  });
});
