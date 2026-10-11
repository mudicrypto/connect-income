import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { conflict, unauthorized } from "../lib/errors.js";
import { hashPassword, unusablePasswordHash, verifyPassword } from "../lib/password.js";
import { ensureUserAccounts } from "../ledger/accounts.js";
import { audit } from "./audit.js";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
}

export const DEMO_USER_EMAIL = "demo@connect-income.local";

export const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
  displayName: z.string().trim().min(1).max(80),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(200),
});

const hashToken = (token: string) => createHash("sha256").update(token).digest();

async function createUser(
  tx: Tx,
  input: { email: string; displayName: string; passwordHash: string; role?: "user" | "admin" },
): Promise<SessionUser> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [input.email, input.displayName, input.passwordHash, input.role ?? "user"],
  );
  if (!res.rows[0]) throw conflict("email_taken", "An account with this email already exists");
  const id = res.rows[0].id;
  // Every user gets segregated USDT accounts up front.
  await ensureUserAccounts(tx, id, "USDT");
  return { id, email: input.email, displayName: input.displayName, role: input.role ?? "user" };
}

export async function register(db: Db, raw: unknown, ip: string | null): Promise<SessionUser> {
  const input = registerSchema.parse(raw);
  const passwordHash = await hashPassword(input.password);
  return withTransaction(db, async (tx) => {
    const user = await createUser(tx, { email: input.email, displayName: input.displayName, passwordHash });
    await audit(tx, { actorUserId: user.id, action: "user.register", targetType: "user", targetId: user.id, ip });
    return user;
  });
}

// Verified against when the email is unknown so response time doesn't reveal account existence.
let dummyHash: Promise<string> | undefined;

export async function login(db: Db, raw: unknown, ip: string | null): Promise<SessionUser> {
  const input = loginSchema.parse(raw);
  const { rows } = await db.query<SessionUser & { password_hash: string; display_name: string }>(
    "SELECT id, email, display_name, role, password_hash FROM users WHERE lower(email) = $1",
    [input.email],
  );
  const row = rows[0];
  dummyHash ??= hashPassword("not-a-real-password");
  const ok = await verifyPassword(input.password, row?.password_hash ?? (await dummyHash));
  if (!row || !ok) {
    await audit(db, { actorUserId: row?.id ?? null, action: "user.login_failed", details: { email: input.email }, ip });
    throw unauthorized("Invalid email or password");
  }
  await audit(db, { actorUserId: row.id, action: "user.login", targetType: "user", targetId: row.id, ip });
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
}

/** Development-only: sign in as a synthetic demo user without a password. */
export async function devLogin(db: Db, ip: string | null): Promise<SessionUser> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; email: string; display_name: string; role: "user" | "admin" }>(
      "SELECT id, email, display_name, role FROM users WHERE lower(email) = $1",
      [DEMO_USER_EMAIL],
    );
    const user = rows[0]
      ? { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name, role: rows[0].role }
      : await createUser(tx, {
          email: DEMO_USER_EMAIL,
          displayName: "Demo User",
          passwordHash: unusablePasswordHash(),
        });
    await audit(tx, { actorUserId: user.id, action: "user.dev_login", targetType: "user", targetId: user.id, ip });
    return user;
  });
}

export async function createSession(db: Db, userId: string, ttlHours: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
    userId,
    hashToken(token),
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function getSessionUser(db: Db, token: string): Promise<SessionUser | null> {
  const { rows } = await db.query<{ id: string; email: string; display_name: string; role: "user" | "admin" }>(
    `SELECT u.id, u.email, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  return r ? { id: r.id, email: r.email, displayName: r.display_name, role: r.role } : null;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
    hashToken(token),
  ]);
}
