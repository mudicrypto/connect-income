import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

// Postgres error codes that are safe to retry the whole transaction on.
const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected

/**
 * Run `fn` inside a single database transaction. Every financial operation
 * goes through here so ledger postings and business-state changes commit or
 * roll back together. Deferred ledger constraints are checked at COMMIT.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < maxAttempts) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
