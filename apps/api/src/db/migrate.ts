import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Tx } from "./pool.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * Minimal forward-only SQL migration runner. Each file runs in its own
 * transaction and is recorded in schema_migrations. Applied migrations must
 * never be edited; add a new numbered file instead.
 */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serialise concurrent migrators.
      await client.query("SELECT pg_advisory_xact_lock(727274)");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount) {
        await client.query("COMMIT");
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
      log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

/** Migration files not yet recorded in schema_migrations. Read-only. */
export async function pendingMigrations(db: Db | Tx): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((r) => r.name));
  return files.filter((f) => !done.has(f));
}

/**
 * Refuse to run against a database whose schema is behind the code. The API
 * server and the seed never migrate implicitly (pre-token audit A1): applying
 * a migration is always the explicit `npm run migrate` step.
 */
export async function assertSchemaCurrent(db: Db): Promise<void> {
  const exists = await db.query("SELECT to_regclass('schema_migrations') AS t");
  const pending = exists.rows[0].t ? await pendingMigrations(db) : ["(no schema_migrations table)"];
  if (pending.length) {
    throw new Error(`database schema is behind the code; pending migrations: ${pending.join(", ")}. Run \`npm run migrate\` explicitly first.`);
  }
}
