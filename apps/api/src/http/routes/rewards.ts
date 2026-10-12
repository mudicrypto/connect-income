import type { FastifyPluginAsync } from "fastify";
import { withTransaction } from "../../db/pool.js";
import { runIdempotent, validateIdempotencyKey } from "../../services/idempotency.js";
import {
  assignProductToPool,
  createPolicy,
  listPolicies,
  listPools,
  registerPool,
  updatePool,
} from "../../rewards/pools.js";
import { calculateRunTx, cancelRun, getRun, listRuns, postRun } from "../../rewards/runs.js";
import { poolSettlementView, setPeriodMode, settlePoolReservesTx, switchToInvestmentModel } from "../../rewards/settlement.js";
import { requireAdmin, type AppDeps } from "../app.js";

/** Admin-only reward pool and reward run controls. All SIMULATED. */
export const rewardAdminRoutes =
  ({ db }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      requireAdmin(req);
    });

    app.get("/pools", async () => ({ simulated: true, pools: await listPools(db), policies: await listPolicies(db) }));

    app.post("/pools", async (req, reply) => {
      const admin = requireAdmin(req);
      await registerPool(db, admin.id, req.body, req.ip);
      return reply.status(201).send({ simulated: true, pools: await listPools(db) });
    });

    app.patch("/pools/:id", async (req) => {
      const admin = requireAdmin(req);
      await updatePool(db, admin.id, (req.params as { id: string }).id, req.body, req.ip);
      return { simulated: true, pools: await listPools(db) };
    });

    app.get("/pools/:id/settlement", async (req) => poolSettlementView(db, (req.params as { id: string }).id));

    // Final reserve settlement is a financial operation: explicit approval + Idempotency-Key.
    app.post("/pools/:id/settle-reserves", async (req, reply) => {
      const admin = requireAdmin(req);
      const key = validateIdempotencyKey(req.headers["idempotency-key"]);
      const id = (req.params as { id: string }).id;
      const result = await withTransaction(db, (tx) =>
        runIdempotent(tx, { userId: admin.id, key, operation: "reserve_settlement", request: { poolId: id } }, async () => ({
          statusCode: 200,
          body: await settlePoolReservesTx(tx, admin.id, id, req.ip),
        })),
      );
      reply.header("Idempotent-Replayed", String(result.replayed));
      return reply.status(result.statusCode).send(result.body);
    });

    app.post("/pools/:id/switch-loss-model", async (req) => {
      const admin = requireAdmin(req);
      await switchToInvestmentModel(db, admin.id, (req.params as { id: string }).id, req.ip);
      return { simulated: true, pools: await listPools(db) };
    });

    app.post("/pools/:id/period-mode", async (req) => {
      const admin = requireAdmin(req);
      await setPeriodMode(db, admin.id, (req.params as { id: string }).id, (req.body as { periodMode?: unknown } | undefined)?.periodMode, req.ip);
      return { simulated: true, pools: await listPools(db) };
    });

    app.post("/product-assignments", async (req, reply) => {
      const admin = requireAdmin(req);
      const id = await assignProductToPool(db, admin.id, req.body, req.ip);
      return reply.status(201).send({ assignmentId: id });
    });

    app.post("/policies", async (req, reply) => {
      const admin = requireAdmin(req);
      const version = await createPolicy(db, admin.id, req.body, req.ip);
      return reply.status(201).send({ version, policies: await listPolicies(db) });
    });

    app.get("/runs", async (req) => {
      const q = req.query as { poolId?: string };
      const poolId = q.poolId && /^[0-9a-f-]{36}$/i.test(q.poolId) ? q.poolId : undefined;
      return { simulated: true, runs: await listRuns(db, poolId) };
    });

    app.get("/runs/:id", async (req) => getRun(db, (req.params as { id: string }).id));

    // Calculation writes no ledger entries; the key still guards against double-submits.
    app.post("/runs", async (req, reply) => {
      const admin = requireAdmin(req);
      const key = validateIdempotencyKey(req.headers["idempotency-key"]);
      // The run and its idempotency record commit atomically.
      const result = await withTransaction(db, (tx) =>
        runIdempotent(tx, { userId: admin.id, key, operation: "reward_run_calculate", request: req.body ?? {} }, async () => ({
          statusCode: 201,
          body: { runId: await calculateRunTx(tx, admin.id, req.body, req.ip) },
        })),
      );
      reply.header("Idempotent-Replayed", String(result.replayed));
      return reply.status(result.statusCode).send(await getRun(db, result.body.runId));
    });

    // Posting is guarded by the run's status + row lock and per-run journal keys.
    app.post("/runs/:id/post", async (req) => {
      const admin = requireAdmin(req);
      const id = (req.params as { id: string }).id;
      const result = await postRun(db, admin.id, id, req.ip);
      return { ...result, ...(await getRun(db, id)) };
    });

    app.post("/runs/:id/cancel", async (req) => {
      const admin = requireAdmin(req);
      const id = (req.params as { id: string }).id;
      await cancelRun(db, admin.id, id, (req.body as { reason?: unknown } | undefined)?.reason, req.ip);
      return getRun(db, id);
    });
  };
