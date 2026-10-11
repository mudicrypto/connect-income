import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createPool, withTransaction, type Db } from "../src/db/pool.js";
import { buildApp, SESSION_COOKIE } from "../src/http/app.js";
import { unusablePasswordHash } from "../src/lib/password.js";
import { ensureUserAccounts } from "../src/ledger/accounts.js";
import { createSession } from "../src/services/auth.js";
import { simulatedDeposit } from "../src/services/deposits.js";
import { TEST_DATABASE_URL } from "./env.js";

export const testDb = (): Db => createPool(TEST_DATABASE_URL);
export const key = () => `test-${randomUUID()}`;

export async function createTestUser(db: Db, role: "user" | "admin" = "user") {
  return withTransaction(db, async (tx) => {
    const email = `${randomUUID()}@test.local`;
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, 'Test', $2, $3) RETURNING id",
      [email, unusablePasswordHash(), role],
    );
    const id = rows[0]!.id;
    const accounts = await ensureUserAccounts(tx, id, "USDT");
    return { id, email, accounts };
  });
}

export async function createTestProduct(
  db: Db,
  o: { termMinutes?: number; min?: string; max?: string | null; devOnly?: boolean; status?: string } = {},
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO investment_products
       (code, name, description, asset, term_minutes, min_amount, max_amount, strategy_description, risk_disclosure, dev_only, status)
     VALUES ($1, 'Test product', 'test', 'USDT', $2, $3, $4, 'none', 'test risk', $5, $6) RETURNING id`,
    [
      `T-${randomUUID().slice(0, 8).toUpperCase()}`,
      o.termMinutes ?? 30 * 1440,
      o.min ?? "10",
      o.max === undefined ? "100000" : o.max,
      o.devOnly ?? false,
      o.status ?? "active",
    ],
  );
  return rows[0]!.id;
}

export async function fund(db: Db, userId: string, amount: string) {
  return simulatedDeposit(db, { userId, amount, idempotencyKey: key() });
}

export async function accountBalance(db: Db, accountId: string): Promise<string> {
  const { rows } = await db.query<{ balance: string }>("SELECT balance::text FROM ledger_accounts WHERE id = $1", [
    accountId,
  ]);
  return rows[0]!.balance;
}

export async function makeApp(db: Db, devMode = true) {
  return buildApp({ db, config: loadConfig({ databaseUrl: TEST_DATABASE_URL, devMode }) });
}

export async function sessionCookie(db: Db, userId: string) {
  const { token } = await createSession(db, userId, 1);
  return { cookie: `${SESSION_COOKIE}=${token}` };
}
