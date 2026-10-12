import type { FastifyPluginAsync } from "fastify";
import { getUserBalances } from "../../services/accounts.js";
import { simulatedDeposit } from "../../services/deposits.js";
import { validateIdempotencyKey } from "../../services/idempotency.js";
import { createInvestment, listInvestments, listProducts } from "../../services/investments.js";
import { listTransactions } from "../../services/transactions.js";
import { investmentRewardStatement } from "../../rewards/runs.js";
import { requireUser, type AppDeps } from "../app.js";

export const userRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const financialRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

    app.get("/balances", async (req) => {
      const user = requireUser(req);
      return { balances: await getUserBalances(db, user.id) };
    });

    app.get("/dashboard", async (req) => {
      const user = requireUser(req);
      const [balances, investments, recent] = await Promise.all([
        getUserBalances(db, user.id),
        listInvestments(db, user.id),
        listTransactions(db, user.id, { limit: 5 }),
      ]);
      const active = investments.filter((i) => i.status === "active");
      const nextMaturity = active.map((i) => i.maturityAt).sort()[0] ?? null;
      return {
        user,
        balances,
        activeInvestmentCount: active.length,
        nextMaturityAt: nextMaturity,
        recentTransactions: recent.items,
      };
    });

    app.post("/deposits/simulated", { config: financialRateLimit }, async (req, reply) => {
      const user = requireUser(req);
      const key = validateIdempotencyKey(req.headers["idempotency-key"]);
      const body = (req.body ?? {}) as { amount?: unknown };
      const result = await simulatedDeposit(db, { userId: user.id, amount: body.amount, idempotencyKey: key, ip: req.ip });
      reply.header("Idempotent-Replayed", String(result.replayed));
      return reply.status(result.statusCode).send(result.body);
    });

    app.get("/products", async (req) => {
      requireUser(req);
      return { products: await listProducts(db, { includeDevOnly: config.devMode }) };
    });

    app.get("/investments", async (req) => {
      const user = requireUser(req);
      return { investments: await listInvestments(db, user.id) };
    });

    app.post("/investments", { config: financialRateLimit }, async (req, reply) => {
      const user = requireUser(req);
      const key = validateIdempotencyKey(req.headers["idempotency-key"]);
      const body = (req.body ?? {}) as { productId?: unknown; amount?: unknown };
      const result = await createInvestment(db, {
        userId: user.id,
        productId: body.productId,
        amount: body.amount,
        idempotencyKey: key,
        allowDevOnly: config.devMode,
        ip: req.ip,
      });
      reply.header("Idempotent-Replayed", String(result.replayed));
      return reply.status(result.statusCode).send(result.body);
    });

    // Per-investment performance statement (owner only; SIMULATED rewards).
    app.get("/investments/:id/rewards", async (req) => {
      const user = requireUser(req);
      return investmentRewardStatement(db, user.id, (req.params as { id: string }).id);
    });

    app.get("/transactions", async (req) => {
      const user = requireUser(req);
      const q = req.query as { limit?: string; before?: string };
      return listTransactions(db, user.id, { limit: q.limit ? Number(q.limit) || 50 : 50, before: q.before });
    });
  };
