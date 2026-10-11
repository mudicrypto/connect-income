import { createHash } from "node:crypto";
import type { Tx } from "../db/pool.js";
import { badRequest, unprocessable } from "../lib/errors.js";

const KEY_RE = /^[A-Za-z0-9_\-:]{8,128}$/;

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw badRequest(
      "idempotency_key_required",
      "An Idempotency-Key header (8-128 chars of A-Z a-z 0-9 _ - :) is required for this operation",
    );
  }
  return key;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

/**
 * Execute `fn` at most once per (user, key) inside the caller's transaction.
 *
 * The key row is inserted first; a concurrent request with the same key blocks
 * on the unique index until the first transaction finishes, then sees its
 * stored response. If the first transaction rolls back, the key is free again.
 */
export async function runIdempotent<T>(
  tx: Tx,
  scope: { userId: string; key: string; operation: string; request: unknown },
  fn: () => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const requestHash = createHash("sha256").update(stableStringify(scope.request)).digest("hex");
  const inserted = await tx.query(
    `INSERT INTO idempotency_keys (user_id, key, operation, request_hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING key`,
    [scope.userId, scope.key, scope.operation, requestHash],
  );

  if (!inserted.rowCount) {
    const { rows } = await tx.query<{ operation: string; request_hash: string; status_code: number; response: T }>(
      "SELECT operation, request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2",
      [scope.userId, scope.key],
    );
    const row = rows[0]!;
    if (row.operation !== scope.operation || row.request_hash !== requestHash) {
      throw unprocessable(
        "idempotency_key_reused",
        "This Idempotency-Key was already used for a different request",
      );
    }
    return { statusCode: row.status_code, body: row.response, replayed: true };
  }

  const result = await fn();
  await tx.query("UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2", [
    scope.userId,
    scope.key,
    result.statusCode,
    JSON.stringify(result.body),
  ]);
  return { ...result, replayed: false };
}
