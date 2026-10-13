import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";
import { transitionLegacyPool } from "../rewards/legacy-transition.js";

/**
 * Runbook entry point: docs/runbooks/legacy-pool-transition.md
 *   npm run transition:legacy -w apps/api -- --pool MOMO-BTC --expected 15.174414 \
 *     --key <transition-key> --approval "<reference>" --approver admin@example [--dry-run]
 * Never migrates: the schema (0008) must already be applied by `npm run migrate`.
 */
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--dry-run") args.set("dry-run", "true");
  else if (a.startsWith("--")) args.set(a.slice(2), argv[++i] ?? "");
}
const need = (k: string) => {
  const v = args.get(k);
  if (!v) throw new Error(`missing --${k}`);
  return v;
};

const db = createPool(loadConfig().databaseUrl);
try {
  const applied = await db.query("SELECT 1 FROM schema_migrations WHERE name = '0008_legacy_loss_transition.sql'");
  if (!applied.rowCount) throw new Error("migration 0008 is not applied; run `npm run migrate` first (this tool never migrates)");
  const pool = await db.query<{ id: string }>("SELECT s.id FROM strategies s JOIN reward_pools rp ON rp.strategy_id = s.id WHERE s.code = $1", [need("pool")]);
  if (!pool.rows[0]) throw new Error(`no reward pool with strategy code ${need("pool")}`);
  const approver = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1) AND role = 'admin'", [need("approver")]);
  if (!approver.rows[0]) throw new Error(`approver ${need("approver")} is not an admin user`);
  const result = await transitionLegacyPool(db, {
    poolStrategyId: pool.rows[0].id,
    expectedCarryForward: need("expected"),
    transitionKey: need("key"),
    approvalReference: need("approval"),
    approvedBy: approver.rows[0].id,
    dryRun: args.get("dry-run") === "true",
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  const e = err as { code?: string; message: string; details?: unknown };
  console.error(JSON.stringify({ aborted: true, code: e.code ?? "error", message: e.message, details: e.details ?? null }, null, 2));
  process.exitCode = 1;
} finally {
  await db.end();
}
