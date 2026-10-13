import type { FastifyPluginAsync } from "fastify";
import { badRequest } from "../../lib/errors.js";
import { advanceMarketTx, listInstruments } from "../../market/market.js";
import { audit } from "../../services/audit.js";
import { runIdempotent, validateIdempotencyKey } from "../../services/idempotency.js";
import { withTransaction } from "../../db/pool.js";
import { runEngine } from "../../strategy/engine.js";
import {
  allocateCapital,
  createStrategy,
  getKillSwitch,
  getStrategyDetail,
  listRuns,
  listStrategies,
  pauseStrategy,
  resumeStrategy,
  setKillSwitch,
} from "../../strategy/strategies.js";
import { requireAdmin, type AppDeps } from "../app.js";

/** Admin-only strategy engine controls. Every response concerns SIMULATED activity. */
export const strategyRoutes =
  ({ db }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // Every route in this plugin requires the admin role.
    app.addHook("preHandler", async (req) => {
      requireAdmin(req);
    });

    app.get("/strategies", async () => ({ simulated: true, strategies: await listStrategies(db) }));

    app.post("/strategies", async (req, reply) => {
      const admin = requireAdmin(req);
      const id = await createStrategy(db, admin.id, req.body, req.ip);
      return reply.status(201).send({ simulated: true, ...(await getStrategyDetail(db, id)) });
    });

    app.get("/strategies/:id", async (req) => {
      const { id } = req.params as { id: string };
      return { simulated: true, ...(await getStrategyDetail(db, id)) };
    });

    app.post("/strategies/:id/pause", async (req) => {
      const admin = requireAdmin(req);
      const { id } = req.params as { id: string };
      await pauseStrategy(db, admin.id, id, (req.body as { reason?: unknown } | undefined)?.reason, req.ip);
      return { simulated: true, ...(await getStrategyDetail(db, id)) };
    });

    app.post("/strategies/:id/resume", async (req) => {
      const admin = requireAdmin(req);
      const { id } = req.params as { id: string };
      await resumeStrategy(db, admin.id, id, req.ip);
      return { simulated: true, ...(await getStrategyDetail(db, id)) };
    });

    app.post("/strategies/:id/allocations", async (req, reply) => {
      const admin = requireAdmin(req);
      const key = validateIdempotencyKey(req.headers["idempotency-key"]);
      const { id } = req.params as { id: string };
      const result = await allocateCapital(db, {
        actorUserId: admin.id,
        strategyId: id,
        amount: (req.body as { amount?: unknown } | undefined)?.amount,
        idempotencyKey: key,
        ip: req.ip,
      });
      reply.header("Idempotent-Replayed", String(result.replayed));
      return reply.status(result.statusCode).send(result.body);
    });

    app.get("/engine", async () => ({
      simulated: true,
      killSwitch: await getKillSwitch(db),
      runs: await listRuns(db),
      instruments: await listInstruments(db),
    }));

    app.post("/engine/kill-switch", async (req) => {
      const admin = requireAdmin(req);
      const body = (req.body ?? {}) as { enabled?: unknown; reason?: unknown };
      return { killSwitch: await setKillSwitch(db, admin.id, body.enabled, body.reason, req.ip) };
    });

    // Processing is naturally idempotent (per-strategy cursor), so no key is required.
    app.post("/engine/run", async (req) => {
      const admin = requireAdmin(req);
      const summary = await runEngine(db, { trigger: "admin", actorUserId: admin.id });
      await audit(db, { actorUserId: admin.id, action: "engine.run", details: { ...summary }, ip: req.ip });
      return { simulated: true, ...summary };
    });

    // Generating synthetic data is not idempotent by nature, so a key prevents double-advancing on retries.
    app.post("/market/advance", async (req, reply) => {
      const admin = requireAdmin(req);
      const key = validateIdempotencyKey(req.headers["idempotency-key"]);
      const ticks = (req.body as { ticks?: unknown } | undefined)?.ticks;
      if (typeof ticks !== "number" || !Number.isInteger(ticks) || ticks < 1 || ticks > 1000) {
        throw badRequest("invalid_ticks", "ticks must be an integer between 1 and 1000");
      }
      // The audit row commits with the ticks, once: a replayed request writes nothing.
      const result = await withTransaction(db, (tx) =>
        runIdempotent(tx, { userId: admin.id, key, operation: "market_advance", request: { ticks } }, async () => {
          const advanced = await advanceMarketTx(tx, ticks);
          await audit(tx, { actorUserId: admin.id, action: "market.advance", details: { ticks }, ip: req.ip });
          return { statusCode: 201, body: { simulated: true, advanced } };
        }),
      );
      reply.header("Idempotent-Replayed", String(result.replayed));
      return reply.status(result.statusCode).send(result.body);
    });
  };
