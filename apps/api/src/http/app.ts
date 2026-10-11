import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { AppError, forbidden, unauthorized } from "../lib/errors.js";
import { getSessionUser, type SessionUser } from "../services/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/user.js";

export const SESSION_COOKIE = "ci_session";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface AppDeps {
  db: Db;
  config: Config;
}

export async function buildApp(deps: AppDeps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024, trustProxy: false });

  // JSON only. Removing the text/plain parser means a cross-site "simple"
  // form/text POST can never reach a handler (CSRF defence alongside
  // SameSite=Strict cookies).
  app.removeContentTypeParser("text/plain");

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? await getSessionUser(deps.db, token) : null;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return reply.status(400).send({ error: { code: "validation_error", message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  app.get("/api/health", async () => ({ ok: true }));
  await app.register(authRoutes(deps), { prefix: "/api/auth" });
  await app.register(userRoutes(deps), { prefix: "/api" });
  await app.register(adminRoutes(deps), { prefix: "/api/admin" });
  return app;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.role !== "admin") throw forbidden("Administrator role required");
  return user;
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    expires: expiresAt,
  });
}
