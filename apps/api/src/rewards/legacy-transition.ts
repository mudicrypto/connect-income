import { createHash } from "node:crypto";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import { Money, type Money as MoneyT } from "../lib/money.js";
import { checkLedgerIntegrity } from "../ledger/integrity.js";
import { audit } from "../services/audit.js";
import { recomputeRunMismatches } from "./runs.js";

/**
 * Legacy pool transition, founder decision "Option A" (docs/rewards-accounting-v2.md §7,
 * runbook docs/runbooks/legacy-pool-transition.md).
 *
 * A pool_v1 pool's remaining pool-wide loss carry-forward is attributed to the
 * investment(s) RESPONSIBLE for it, i.e. the allocations that took part in the
 * legacy periods in which the carry-forward arose. It becomes their opening
 * loss-recovery balance under investment_v2. Nothing historical is modified.
 *
 * Supported attribution is deliberately narrow: exactly ONE responsible
 * allocation, so the attribution is exact. Anything else is ambiguous and aborts.
 */

export const TRANSITION_METHOD = "option_a_responsible_investments";
export const TRANSITION_FORMULA =
  "Legacy CF = last posted pool_v1 cf_close, verified as a continuous chain (cf_open(1) = 0; cf_open(k) = cf_close(k-1)). " +
  "Responsible allocations = allocations with weighted participation > 0 in every posted pool_v1 run whose carry-forward " +
  "changed (attributable != 0, recovery != 0 or reserve applied != 0). If exactly one, it receives 100% of the legacy CF " +
  "(loss_amount = CF, exact, no rounding); otherwise the attribution is ambiguous and the transition aborts.";

export class TransitionAbort extends AppError {
  constructor(code: string, message: string, public readonly details?: unknown) {
    super(422, code, message);
  }
}

// ---------------------------------------------------------------------------
// Pure attribution (testable without a database)
// ---------------------------------------------------------------------------

export interface EvidenceRun {
  id: string;
  cfOpen: MoneyT;
  cfClose: MoneyT;
  attributable: MoneyT;
  cfRecovered: MoneyT;
  reserveApplied: MoneyT;
  lines: Array<{ allocationId: string; weightedAllocation: MoneyT }>;
}
export interface EvidenceAllocation {
  allocationId: string;
  investmentId: string | null;
  userId: string | null;
}

export interface AttributionPlan {
  sourceRunId: string;
  sourceCarryForward: string;
  lines: Array<{ allocationId: string; investmentId: string; userId: string; lossAmount: string; contributingRuns: string[] }>;
  contributingRuns: string[];
}

export function attributeLegacyLoss(input: {
  postedV1Runs: EvidenceRun[]; // ordered by period_end
  allocations: EvidenceAllocation[];
  expectedCarryForward: MoneyT;
}): AttributionPlan {
  const runs = input.postedV1Runs;
  if (runs.length === 0) throw new TransitionAbort("no_legacy_history", "The pool has no posted pool_v1 run; there is no legacy carry-forward to attribute");
  // 1. The carry-forward must be a continuous chain from zero.
  let prev = new Money(0);
  for (const r of runs) {
    if (!r.cfOpen.eq(prev)) {
      throw new TransitionAbort("carry_forward_chain_broken", `Run ${r.id} opens at ${r.cfOpen.toFixed()} but the previous run closed at ${prev.toFixed()}`);
    }
    prev = r.cfClose;
  }
  const last = runs[runs.length - 1]!;
  // 2. The amount must reconcile exactly to the approved figure.
  if (!last.cfClose.eq(input.expectedCarryForward)) {
    throw new TransitionAbort(
      "carry_forward_mismatch",
      `Legacy carry-forward is ${last.cfClose.toFixed()}, not the approved ${input.expectedCarryForward.toFixed()}; nothing was changed`,
    );
  }
  if (last.cfClose.lte(0)) throw new TransitionAbort("nothing_to_attribute", "Legacy carry-forward is zero; use the plain model switch instead");
  // 3. Responsible allocations: participants of every run in which the carry-forward changed.
  const contributing = runs.filter((r) => !r.attributable.isZero() || !r.cfRecovered.isZero() || !r.reserveApplied.isZero() || !r.cfClose.eq(r.cfOpen));
  const responsible = new Map<string, string[]>();
  for (const r of contributing) {
    const participants = r.lines.filter((l) => l.weightedAllocation.gt(0));
    if (participants.length === 0) {
      throw new TransitionAbort("no_participants", `Run ${r.id} changed the carry-forward but has no participating allocation`);
    }
    for (const l of participants) responsible.set(l.allocationId, [...(responsible.get(l.allocationId) ?? []), r.id]);
  }
  if (responsible.size !== 1) {
    throw new TransitionAbort(
      "ambiguous_attribution",
      `The legacy carry-forward arose from ${responsible.size} investments; Option A attribution is only exact for one. Aborted.`,
      { responsible: [...responsible.keys()] },
    );
  }
  const [allocationId, runIds] = [...responsible.entries()][0]!;
  const alloc = input.allocations.find((a) => a.allocationId === allocationId);
  if (!alloc || !alloc.investmentId || !alloc.userId) {
    throw new TransitionAbort("missing_investment", `Responsible allocation ${allocationId} has no matching investment; aborted`);
  }
  return {
    sourceRunId: last.id,
    sourceCarryForward: last.cfClose.toFixed(),
    contributingRuns: contributing.map((r) => r.id),
    lines: [{ allocationId, investmentId: alloc.investmentId, userId: alloc.userId, lossAmount: last.cfClose.toFixed(), contributingRuns: runIds }],
  };
}

// ---------------------------------------------------------------------------
// Evidence gathering and execution
// ---------------------------------------------------------------------------

/**
 * SHA-256 over every historical record the transition must not change: the pool's runs, run
 * lines and run sources, its allocations and their investments, its reserve settlements, and
 * every journal entry and posting touching the strategy's (or pool's) accounts. Rendered with a
 * fixed TimeZone/DateStyle so the stored digest can be recomputed later from any session.
 */
export async function historyDigest(tx: Tx, poolId: string): Promise<string> {
  await tx.query("SET LOCAL TimeZone = 'UTC'");
  await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await tx.query("SET LOCAL IntervalStyle = 'iso_8601'");
  await tx.query("SET LOCAL extra_float_digits = 3");
  const parts: string[] = [];
  for (const sql of [
    "SELECT r::text AS t FROM reward_runs r WHERE r.pool_strategy_id = $1 ORDER BY r.id",
    "SELECT l::text AS t FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id WHERE r.pool_strategy_id = $1 ORDER BY l.id",
    "SELECT s::text AS t FROM reward_run_sources s JOIN reward_runs r ON r.id = s.run_id WHERE r.pool_strategy_id = $1 ORDER BY s.run_id, s.trade_id",
    "SELECT a::text AS t FROM pool_allocations a WHERE a.pool_strategy_id = $1 ORDER BY a.id",
    "SELECT i::text AS t FROM investments i WHERE i.id IN (SELECT investment_id FROM pool_allocations WHERE pool_strategy_id = $1) ORDER BY i.id",
    "SELECT x::text AS t FROM reserve_settlements x WHERE x.pool_strategy_id = $1 ORDER BY x.id",
    `SELECT e::text AS t FROM journal_entries e WHERE e.id IN (SELECT p.entry_id FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id
       WHERE a.owner_strategy_id = $1) ORDER BY e.id`,
    `SELECT p::text AS t FROM ledger_postings p WHERE p.entry_id IN (SELECT q.entry_id FROM ledger_postings q JOIN ledger_accounts a ON a.id = q.account_id
       WHERE a.owner_strategy_id = $1) ORDER BY p.id`,
  ]) {
    parts.push((await tx.query<{ t: string }>(sql, [poolId])).rows.map((r) => r.t).join("\n"));
  }
  return createHash("sha256").update(parts.join("\n--\n")).digest("hex");
}

export async function gatherEvidence(tx: Tx, poolId: string) {
  const runs = await tx.query<{ id: string; cf_open: string; cf_close: string; attributable: string; cf_recovered: string; reserve_applied: string }>(
    `SELECT id, cf_open::text, cf_close::text, attributable::text, cf_recovered::text, reserve_applied::text
       FROM reward_runs WHERE pool_strategy_id = $1 AND status = 'posted' AND loss_model = 'pool_v1' ORDER BY period_end`,
    [poolId],
  );
  const lines = await tx.query<{ run_id: string; allocation_id: string; weighted_allocation: string }>(
    `SELECT l.run_id, l.allocation_id, l.weighted_allocation::text FROM reward_run_lines l
      WHERE l.run_id = ANY($1::uuid[])`,
    [runs.rows.map((r) => r.id)],
  );
  const allocations = await tx.query<{ id: string; investment_id: string | null; user_id: string | null }>(
    `SELECT pa.id, i.id AS investment_id, u.id AS user_id FROM pool_allocations pa
       LEFT JOIN investments i ON i.id = pa.investment_id LEFT JOIN users u ON u.id = pa.user_id
      WHERE pa.pool_strategy_id = $1`,
    [poolId],
  );
  const reserve = await tx.query<{ b: string }>(
    "SELECT COALESCE(sum(balance), 0)::text AS b FROM ledger_accounts WHERE owner_strategy_id = $1 AND purpose = 'pool_reserve'",
    [poolId],
  );
  return {
    postedV1Runs: runs.rows.map((r) => ({
      id: r.id,
      cfOpen: new Money(r.cf_open),
      cfClose: new Money(r.cf_close),
      attributable: new Money(r.attributable),
      cfRecovered: new Money(r.cf_recovered),
      reserveApplied: new Money(r.reserve_applied),
      lines: lines.rows.filter((l) => l.run_id === r.id).map((l) => ({ allocationId: l.allocation_id, weightedAllocation: new Money(l.weighted_allocation) })),
    })),
    allocations: allocations.rows.map((a) => ({ allocationId: a.id, investmentId: a.investment_id, userId: a.user_id })),
    reserve: new Money(reserve.rows[0]!.b),
  };
}

export interface TransitionInput {
  poolStrategyId: string;
  expectedCarryForward: string;
  transitionKey: string;
  approvalReference: string;
  approvedBy: string;
  dryRun?: boolean;
  /** TEST ONLY: replaces the ledger integrity checker (to exercise the failure path). */
  integrityCheck?: (tx: Tx) => Promise<string[]>;
}

export async function transitionLegacyPool(db: Db, input: TransitionInput) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.poolStrategyId)) throw notFound("Pool not found");
  if (!/^\d{1,20}(\.\d{1,18})?$/.test(input.expectedCarryForward)) {
    throw new TransitionAbort("invalid_amount", "expectedCarryForward must be a decimal string");
  }
  const approval = input.approvalReference.trim();
  if (approval.length < 5 || approval.length > 500) throw badRequest("invalid_approval", "approvalReference must be 5-500 characters");
  const expected = new Money(input.expectedCarryForward);
  const integrity = input.integrityCheck ?? (async (tx: Tx) => (await checkLedgerIntegrity(tx)).problems);

  return withTransaction(db, async (tx) => {
    // Lock order as for reward posting: pool first.
    const pool = await tx.query<{ loss_model: string; transition_required: boolean }>(
      "SELECT loss_model, transition_required FROM reward_pools WHERE strategy_id = $1 FOR UPDATE",
      [input.poolStrategyId],
    );
    if (!pool.rows[0]) throw notFound("Pool not found");
    // Then the strategy (rule 22 order), so no engine tick or capital allocation can commit
    // new strategy postings while the history digest is taken.
    await tx.query("SELECT 1 FROM strategies WHERE id = $1 FOR UPDATE", [input.poolStrategyId]);

    // Idempotency: a retry with the same key AND the same parameters returns the recorded
    // transition; a different key, different parameters or a dry run are refused (409).
    const existing = await tx.query<{ id: string; transition_key: string; source_carry_forward: string; approval_reference: string; approved_by: string }>(
      `SELECT id, transition_key, source_carry_forward::text, approval_reference, approved_by
         FROM legacy_loss_transitions WHERE pool_strategy_id = $1`,
      [input.poolStrategyId],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.transition_key !== input.transitionKey) {
        throw conflict("already_transitioned", "This pool has already been transitioned under a different key");
      }
      if (input.dryRun) throw conflict("already_transitioned", "This pool has already been transitioned; a dry run is no longer possible");
      if (!new Money(prior.source_carry_forward).eq(expected) || prior.approval_reference !== approval || prior.approved_by !== input.approvedBy) {
        throw conflict("idempotency_key_reused", "This transition key was used with different parameters; nothing was changed");
      }
      return { replayed: true, dryRun: false, ...(await describeTransition(tx, prior.id)) };
    }
    const keyUsed = await tx.query("SELECT 1 FROM legacy_loss_transitions WHERE transition_key = $1", [input.transitionKey]);
    if (keyUsed.rowCount) throw conflict("idempotency_key_reused", "This transition key was already used for another pool");
    if (pool.rows[0].loss_model !== "pool_v1") throw new TransitionAbort("not_legacy", "Pool is not on the legacy pool_v1 model");
    const pending = await tx.query("SELECT 1 FROM reward_runs WHERE pool_strategy_id = $1 AND status = 'calculated'", [input.poolStrategyId]);
    if (pending.rowCount) throw new TransitionAbort("run_pending", "Cancel or post the pending run first");

    const before = await integrity(tx);
    if (before.length) throw new TransitionAbort("integrity_failed_before", "Ledger integrity problems exist; transition aborted", before);

    const ev = await gatherEvidence(tx, input.poolStrategyId);
    if (!ev.reserve.isZero()) {
      throw new TransitionAbort("legacy_reserve_nonzero", `Legacy reserve ${ev.reserve.toFixed()} is not covered by Option A; aborted`);
    }
    // Every legacy run must still reproduce from the ledger and source records.
    const recomputed: Record<string, unknown> = {};
    for (const r of ev.postedV1Runs) {
      const mismatches = await recomputeRunMismatches(tx, r.id);
      if (mismatches.length) throw new TransitionAbort("legacy_run_not_reproducible", `Legacy run ${r.id} no longer reconciles to the ledger`, mismatches);
      recomputed[r.id] = "reproduced exactly from ledger trades, capital postings and allocations";
    }
    const plan = attributeLegacyLoss({ postedV1Runs: ev.postedV1Runs, allocations: ev.allocations, expectedCarryForward: expected });
    const digestBefore = await historyDigest(tx, input.poolStrategyId);
    const evidence = {
      chain: ev.postedV1Runs.map((r) => ({ run: r.id, cfOpen: r.cfOpen.toFixed(), cfClose: r.cfClose.toFixed(), attributable: r.attributable.toFixed() })),
      contributingRuns: plan.contributingRuns,
      allocationsEverInPool: ev.allocations.length,
      legacyReserve: ev.reserve.toFixed(),
      recomputation: recomputed,
      historyDigestSha256: digestBefore,
    };
    if (input.dryRun) return { replayed: false, dryRun: true, plan, evidence, method: TRANSITION_METHOD, formula: TRANSITION_FORMULA };

    const t = await tx
      .query<{ id: string; created_at: Date }>(
        `INSERT INTO legacy_loss_transitions (pool_strategy_id, transition_key, method, source_run_id, source_carry_forward, source_reserve,
           formula, evidence, approval_reference, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at`,
        [
          input.poolStrategyId,
          input.transitionKey,
          TRANSITION_METHOD,
          plan.sourceRunId,
          plan.sourceCarryForward,
          ev.reserve.toFixed(),
          TRANSITION_FORMULA,
          JSON.stringify(evidence),
          approval,
          input.approvedBy,
        ],
      )
      .catch((err: { code?: string }) => {
        // A concurrent transition of another pool took the same key first.
        if (err.code === "23505") throw conflict("idempotency_key_reused", "This transition key was already used for another pool");
        throw err;
      });
    const transitionId = t.rows[0]!.id;
    for (const l of plan.lines) {
      await tx.query(
        `INSERT INTO legacy_loss_transition_lines (transition_id, allocation_id, investment_id, user_id, loss_amount, evidence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [transitionId, l.allocationId, l.investmentId, l.userId, l.lossAmount, JSON.stringify({ contributingRuns: l.contributingRuns, share: "100%" })],
      );
    }
    await tx.query("UPDATE reward_pools SET loss_model = 'investment_v2', transition_required = FALSE WHERE strategy_id = $1", [input.poolStrategyId]);

    // History must be byte-identical and the books clean, or everything rolls back.
    const digestAfter = await historyDigest(tx, input.poolStrategyId);
    if (digestAfter !== digestBefore) throw new TransitionAbort("history_changed", "Historical records changed during the transition; rolled back");
    const after = await integrity(tx);
    if (after.length) throw new TransitionAbort("integrity_failed_after", "Ledger integrity problems after transition; rolled back", after);
    // Run the database's commit-time reconciliation now, so a failure is reported here.
    await tx.query("SET CONSTRAINTS ALL IMMEDIATE");

    await audit(tx, {
      actorUserId: input.approvedBy,
      action: "pool.legacy_transition",
      targetType: "strategy",
      targetId: input.poolStrategyId,
      details: {
        transitionId,
        transitionKey: input.transitionKey,
        method: TRANSITION_METHOD,
        sourceRunId: plan.sourceRunId,
        sourceCarryForward: plan.sourceCarryForward,
        lines: plan.lines.map((l) => ({ investmentId: l.investmentId, lossAmount: l.lossAmount })),
        approvalReference: approval,
        historyDigestSha256: digestBefore,
      },
    });
    return { replayed: false, dryRun: false, ...(await describeTransition(tx, transitionId)) };
  });
}

export async function describeTransition(db: Db | Tx, transitionId: string) {
  const t = await db.query(
    `SELECT t.id, t.pool_strategy_id AS "poolStrategyId", s.code AS "poolCode", t.transition_key AS "transitionKey", t.method,
            t.source_run_id AS "sourceRunId", t.source_carry_forward::text AS "sourceCarryForward", t.source_reserve::text AS "sourceReserve",
            t.formula, t.evidence, t.approval_reference AS "approvalReference", u.email AS "approvedBy", t.created_at AS "createdAt"
       FROM legacy_loss_transitions t JOIN strategies s ON s.id = t.pool_strategy_id JOIN users u ON u.id = t.approved_by
      WHERE t.id = $1`,
    [transitionId],
  );
  const lines = await db.query(
    `SELECT allocation_id AS "allocationId", investment_id AS "investmentId", loss_amount::text AS "lossAmount", evidence
       FROM legacy_loss_transition_lines WHERE transition_id = $1 ORDER BY allocation_id`,
    [transitionId],
  );
  return { transition: t.rows[0], lines: lines.rows };
}
