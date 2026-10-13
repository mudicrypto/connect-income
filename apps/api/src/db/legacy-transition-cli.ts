import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";
import { transitionLegacyPool } from "../rewards/legacy-transition.js";
import { parseTransitionArgs } from "./legacy-transition-args.js";
import { assertSchemaCurrent } from "./migrate.js";

/**
 * Runbook entry point: docs/runbooks/legacy-pool-transition.md
 *   npm run transition:legacy -w apps/api -- --pool MOMO-BTC --expected 15.174414 \
 *     --key <transition-key> --approval "<reference>" --approver admin@example [--execute]
 * Without --execute this is a DRY RUN (writes nothing). Never migrates: the
 * schema (0008) must already be applied by `npm run migrate`.
 */
const args = parseTransitionArgs(process.argv.slice(2));
const db = createPool(loadConfig().databaseUrl);
try {
  // This tool never migrates: the schema must already be current (`npm run migrate`).
  await assertSchemaCurrent(db);
  const pool = await db.query<{ id: string }>("SELECT s.id FROM strategies s JOIN reward_pools rp ON rp.strategy_id = s.id WHERE s.code = $1", [args.pool]);
  if (!pool.rows[0]) throw new Error(`no reward pool with strategy code ${args.pool}`);
  const approver = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1) AND role = 'admin'", [args.approver]);
  if (!approver.rows[0]) throw new Error(`approver ${args.approver} is not an admin user`);
  const result = await transitionLegacyPool(db, {
    poolStrategyId: pool.rows[0].id,
    expectedCarryForward: args.expected,
    transitionKey: args.key,
    approvalReference: args.approval,
    approvedBy: approver.rows[0].id,
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  const e = err as { code?: string; message: string; details?: unknown };
  console.error(JSON.stringify({ aborted: true, code: e.code ?? "error", message: e.message, details: e.details ?? null }, null, 2));
  process.exitCode = 1;
} finally {
  await db.end();
}
