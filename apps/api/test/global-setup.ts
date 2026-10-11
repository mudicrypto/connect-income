import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { TEST_DATABASE_URL } from "./env.js";

export default async function setup() {
  const db = createPool(TEST_DATABASE_URL);
  try {
    // Fresh schema per test run. Ledger tables reject TRUNCATE/DELETE by design,
    // so the whole schema is dropped instead.
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
  } finally {
    await db.end();
  }
}
