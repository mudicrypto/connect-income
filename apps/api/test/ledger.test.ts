import { afterAll, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/pool.js";
import { ensureAccount } from "../src/ledger/accounts.js";
import { checkLedgerIntegrity } from "../src/ledger/integrity.js";
import { postEntry } from "../src/ledger/ledger.js";
import { Money } from "../src/lib/money.js";
import { accountBalance, createTestUser, key, testDb } from "./helpers.js";

const db = testDb();
afterAll(() => db.end());

const m = (v: string) => new Money(v);

async function custodyAccount() {
  return withTransaction(db, (tx) => ensureAccount(tx, "platform_sim_custody", "USDT"));
}

describe("double-entry ledger", () => {
  it("posts a balanced entry and updates cached and running balances", async () => {
    const user = await createTestUser(db);
    const custody = await custodyAccount();
    const { entryId, created } = await withTransaction(db, (tx) =>
      postEntry(tx, {
        entryType: "simulated_deposit",
        idempotencyKey: key(),
        description: "test",
        postings: [
          { accountId: custody, direction: "debit", amount: m("250.5") },
          { accountId: user.accounts.available, direction: "credit", amount: m("250.5") },
        ],
      }),
    );
    expect(created).toBe(true);
    expect(await accountBalance(db, user.accounts.available)).toBe("250.500000000000000000");
    const { rows } = await db.query("SELECT balance_after::text FROM ledger_postings WHERE entry_id = $1 AND account_id = $2", [
      entryId,
      user.accounts.available,
    ]);
    expect(rows[0].balance_after).toBe("250.500000000000000000");
    expect((await checkLedgerIntegrity(db)).problems).toEqual([]);
  });

  it("is idempotent on the entry key", async () => {
    const user = await createTestUser(db);
    const custody = await custodyAccount();
    const k = key();
    const post = () =>
      withTransaction(db, (tx) =>
        postEntry(tx, {
          entryType: "simulated_deposit",
          idempotencyKey: k,
          description: "test",
          postings: [
            { accountId: custody, direction: "debit", amount: m("10") },
            { accountId: user.accounts.available, direction: "credit", amount: m("10") },
          ],
        }),
      );
    const a = await post();
    const b = await post();
    expect(b.created).toBe(false);
    expect(b.entryId).toBe(a.entryId);
    expect(await accountBalance(db, user.accounts.available)).toBe("10.000000000000000000");
  });

  it("rejects unbalanced and single-sided entries in application code", async () => {
    const user = await createTestUser(db);
    const custody = await custodyAccount();
    await expect(
      withTransaction(db, (tx) =>
        postEntry(tx, {
          entryType: "simulated_deposit",
          idempotencyKey: key(),
          description: "unbalanced",
          postings: [
            { accountId: custody, direction: "debit", amount: m("10") },
            { accountId: user.accounts.available, direction: "credit", amount: m("9.99") },
          ],
        }),
      ),
    ).rejects.toThrow(/unbalanced/);
    await expect(
      withTransaction(db, (tx) =>
        postEntry(tx, {
          entryType: "simulated_deposit",
          idempotencyKey: key(),
          description: "one leg",
          postings: [{ accountId: custody, direction: "debit", amount: m("10") }],
        }),
      ),
    ).rejects.toThrow(/at least two/);
  });

  it("database rejects an unbalanced entry even if application checks are bypassed", async () => {
    const user = await createTestUser(db);
    const custody = await custodyAccount();
    await expect(
      withTransaction(db, async (tx) => {
        const { rows } = await tx.query(
          "INSERT INTO journal_entries (entry_type, idempotency_key, description) VALUES ('simulated_deposit', $1, 'raw') RETURNING id",
          [key()],
        );
        await tx.query(
          "INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'debit', 5, 0)",
          [rows[0].id, custody],
        );
        await tx.query(
          "INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'USDT', 'credit', 4, 0)",
          [rows[0].id, user.accounts.available],
        );
      }),
    ).rejects.toThrow(/unbalanced/);
    expect(await accountBalance(db, user.accounts.available)).toBe("0.000000000000000000");
  });

  it("database rejects an entry with no postings", async () => {
    await expect(
      withTransaction(db, (tx) =>
        tx.query(
          "INSERT INTO journal_entries (entry_type, idempotency_key, description) VALUES ('simulated_deposit', $1, 'empty')",
          [key()],
        ),
      ),
    ).rejects.toThrow(/at least two postings/);
  });

  it("database prevents overdrafts", async () => {
    const user = await createTestUser(db);
    await expect(
      withTransaction(db, (tx) =>
        postEntry(tx, {
          entryType: "investment_open",
          idempotencyKey: key(),
          description: "overdraw",
          postings: [
            { accountId: user.accounts.available, direction: "debit", amount: m("1") },
            { accountId: user.accounts.invested, direction: "credit", amount: m("1") },
          ],
        }),
      ),
    ).rejects.toThrow(/ledger_accounts_no_overdraft/);
  });

  it("ledger history is append-only and balances cannot be edited directly", async () => {
    const { rows } = await db.query("SELECT id, entry_id FROM ledger_postings LIMIT 1");
    expect(rows.length).toBe(1);
    await expect(db.query("UPDATE ledger_postings SET amount = 1 WHERE id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM ledger_postings WHERE id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE journal_entries SET description = 'x' WHERE id = $1", [rows[0].entry_id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("TRUNCATE ledger_postings CASCADE")).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE ledger_accounts SET balance = balance + 1000")).rejects.toThrow(/only change through/);
    await expect(db.query("DELETE FROM ledger_accounts")).rejects.toThrow(/cannot be deleted/);
    await db.query("INSERT INTO audit_logs (action) VALUES ('test.event')");
    await expect(db.query("UPDATE audit_logs SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_logs")).rejects.toThrow(/append-only/);
  });

  it("rejects postings whose asset differs from the account asset", async () => {
    await db.query("INSERT INTO assets (code, name, scale) VALUES ('TST', 'Test asset', 6) ON CONFLICT DO NOTHING");
    const user = await createTestUser(db);
    const custody = await custodyAccount();
    await expect(
      withTransaction(db, async (tx) => {
        const { rows } = await tx.query(
          "INSERT INTO journal_entries (entry_type, idempotency_key, description) VALUES ('simulated_deposit', $1, 'raw') RETURNING id",
          [key()],
        );
        await tx.query(
          "INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'TST', 'debit', 5, 0)",
          [rows[0].id, custody],
        );
        await tx.query(
          "INSERT INTO ledger_postings (entry_id, account_id, asset, direction, amount, balance_after) VALUES ($1, $2, 'TST', 'credit', 5, 0)",
          [rows[0].id, user.accounts.available],
        );
      }),
    ).rejects.toThrow(/foreign key/);
  });
});
