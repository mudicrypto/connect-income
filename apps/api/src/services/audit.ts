import type { Db, Tx } from "../db/pool.js";

export interface AuditEvent {
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/** Append to the immutable audit log. Pass the transaction so it commits with the action. */
export async function audit(db: Db | Tx, e: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.actorUserId, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.details ?? {}), e.ip ?? null],
  );
}
