import type { FastifyPluginAsync } from "fastify";
import { notFound } from "../../lib/errors.js";
import { createSession, devLogin, login, register, revokeSession } from "../../services/auth.js";
import { SESSION_COOKIE, setSessionCookie, type AppDeps } from "../app.js";

export const authRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const authRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

    app.post("/register", { config: authRateLimit }, async (req, reply) => {
      const user = await register(db, req.body, req.ip);
      const session = await createSession(db, user.id, config.sessionTtlHours);
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return reply.status(201).send({ user });
    });

    app.post("/login", { config: authRateLimit }, async (req, reply) => {
      const user = await login(db, req.body, req.ip);
      const session = await createSession(db, user.id, config.sessionTtlHours);
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return { user };
    });

    app.post("/dev-login", { config: authRateLimit }, async (req, reply) => {
      if (!config.devMode) throw notFound();
      const user = await devLogin(db, req.ip);
      const session = await createSession(db, user.id, config.sessionTtlHours);
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return { user };
    });

    app.post("/logout", async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await revokeSession(db, token);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    });

    app.get("/me", async (req) => ({ user: req.user, devMode: config.devMode }));
  };
