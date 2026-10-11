import type { FastifyPluginAsync } from "fastify";
import { checkLedgerIntegrity } from "../../ledger/integrity.js";
import { audit } from "../../services/audit.js";
import { settleMaturedInvestments } from "../../services/investments.js";
import { requireAdmin, type AppDeps } from "../app.js";

export const adminRoutes =
  ({ db }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/ledger/integrity", async (req) => {
      requireAdmin(req);
      return checkLedgerIntegrity(db);
    });

    app.post("/investments/settle-matured", async (req) => {
      const admin = requireAdmin(req);
      const result = await settleMaturedInvestments(db, { actorUserId: admin.id });
      await audit(db, {
        actorUserId: admin.id,
        action: "admin.settle_matured",
        details: { settled: result.settled.length },
        ip: req.ip,
      });
      return result;
    });
  };
