# Runbook: legacy pool transition (Option A)

Moves a `transition_required` reward pool from `pool_v1` to `investment_v2` by attributing its
remaining pool-wide loss carry-forward (CF) to the **investment responsible for it**. The rules
are in [`rewards-accounting-v2.md` §7](../rewards-accounting-v2.md#7-migration-and-backward-compatibility).
Everything here is SIMULATED.

**Status for MOMO-BTC:** prepared and rehearsed on a clone, **not applied to the development
database**. On 2026-10-13 the founder decided to ship the code only and leave dev unchanged, so
MOMO-BTC stays `pool_v1` with `transition_required = true`, and dev is still on migration 0007.

## What the transition does and does not do

- It **writes no ledger entry and moves no money.** The legacy CF is a memo, not a balance, so
  the transition changes only where future loss recovery is charged.
- It inserts one `legacy_loss_transitions` row, recording the source run, the source CF, the
  source reserve (must be 0), the formula, the evidence JSON, the approval reference, the
  approving admin and a timestamp. It also inserts one `legacy_loss_transition_lines` row per
  responsible allocation, giving the attributed `loss_amount`. Then it sets
  `reward_pools.loss_model = 'investment_v2'` and `transition_required = false`, and writes one
  `audit_log` row (`pool.legacy_transition`) that contains no credentials or secrets.
- It **never edits or deletes** reward runs, run lines, ledger rows or allocations. A SHA-256
  digest of the pool's runs, lines and strategy postings is taken before and after inside the
  transaction, and any difference aborts it (`history_changed`). Both transition tables are
  append-only, enforced by triggers.
- The first v2 line of a responsible allocation opens at `loss_open = loss_amount`. Every other
  allocation, including investors who joined later, opens at 0.

## Attribution formula (exact, no rounding)

```
CF        = cf_close of the pool's last posted pool_v1 run
chain     : cf_open(run 1) = 0 and cf_open(k) = cf_close(k-1) for every posted pool_v1 run
contrib   = posted pool_v1 runs where attributable ≠ 0, cf_recovered ≠ 0,
            reserve_applied ≠ 0 or cf_close ≠ cf_open
responsible = allocations with weighted_allocation > 0 in the contributing runs
If |responsible| = 1  → loss_amount(that allocation) = CF   (100%, exact)
Otherwise             → abort `ambiguous_attribution` (founder decides; nothing is guessed)
```

Abort codes (HTTP 422 / CLI exit 1; nothing is written):

| Code | Meaning |
|---|---|
| `carry_forward_mismatch` | Recorded CF ≠ `--expected`, compared exactly at full precision |
| `ambiguous_attribution` | Zero, or more than one, responsible allocation |
| `missing_investment` | The responsible allocation's investment or user no longer resolves |
| `carry_forward_chain_broken` | The v1 run chain does not start at 0 or has a gap |
| `nothing_to_attribute` / `no_legacy_history` | CF is 0, or there are no posted v1 runs (use the plain switch instead) |
| `legacy_reserve_nonzero` | The pool still holds a v1 reserve; Option A does not cover it |
| `legacy_run_not_reproducible` | A stored v1 run no longer recomputes to its recorded figures |
| `not_legacy` / `run_pending` | The pool is already v2, or a calculated run awaits post or cancel |
| `integrity_failed_before` / `integrity_failed_after` | `checkLedgerIntegrity()` is not clean |
| `already_transitioned` (409) | The pool was transitioned under a different key |

**DB-level backstop** (migration 0008): deferred constraint triggers re-check every transition at
COMMIT. The source run must be the last posted v1 run, `cf_close` must equal the source CF, the
ledger reserve must be 0, Σ lines must equal the CF, each line must match its allocation,
investment and user, the pool must be v2, and no v2 run may predate the transition. The check
applies to raw SQL inserts too. `UNIQUE(pool_strategy_id)` and `UNIQUE(transition_key)` make the
transition run once, and concurrent attempts serialise on the pool row lock.

## Procedure

### 0. Prerequisites
- Founder approval in writing. Its reference goes into `--approval`.
- An admin user to record as the approver.
- No `calculated` run pending for the pool.
- The pool's v1 reserve is 0.

### 1. Read-only evidence (run against the target DB)

```sql
\set code 'MOMO-BTC'
-- runs (posted and cancelled) in period order
SELECT r.id, r.status, r.loss_model, r.cf_open::text, r.cf_close::text, r.attributable::text,
       r.reserve_contribution::text, r.reserve_applied::text
  FROM reward_runs r JOIN strategies s ON s.id = r.pool_strategy_id
 WHERE s.code = :'code' ORDER BY r.period_end;
-- who participated in each posted run
SELECT l.run_id, l.allocation_id, l.investment_id, l.weighted_allocation::text, l.weight_fraction::text
  FROM reward_run_lines l JOIN reward_runs r ON r.id = l.run_id JOIN strategies s ON s.id = r.pool_strategy_id
 WHERE s.code = :'code' AND r.status = 'posted';
-- every allocation ever made to the pool
SELECT pa.id, pa.investment_id, u.email, pa.amount::text, i.status
  FROM pool_allocations pa JOIN strategies s ON s.id = pa.pool_strategy_id
  JOIN investments i ON i.id = pa.investment_id JOIN users u ON u.id = pa.user_id
 WHERE s.code = :'code';
-- legacy reserve (must be 0)
SELECT COALESCE(sum(a.balance),0)::text FROM ledger_accounts a JOIN strategies s ON s.id = a.owner_strategy_id
 WHERE s.code = :'code' AND a.purpose = 'pool_reserve';
```

Independently recompute the CF from raw ledger postings, outside the app, using exact decimals
(for example Python `decimal`):
`attributable = floor(R · A / C)` at the asset scale, where R = realised gain − loss − fees for
the period, A = the allocation's weighted participation, and C = paper capital × period length.

### 2. Rehearse on a clone (never on the live DB first)

```sh
psql "$ADMIN_URL" -c "CREATE DATABASE connect_income_rehearsal TEMPLATE connect_income"
DATABASE_URL=postgres://…/connect_income_rehearsal npm run migrate
DATABASE_URL=postgres://…/connect_income_rehearsal npm run transition:legacy -w apps/api -- \
  --pool MOMO-BTC --expected 15.174414 --key momo-btc-option-a-2026-10-12 \
  --approval "<founder approval reference>" --approver admin@connect-income.local --dry-run
# …then without --dry-run; re-run to confirm "replayed": true; check integrity; then drop the clone
```

Compare a digest of the history tables between the source and the clone. They must be identical:

```sql
SELECT md5(string_agg(t, '' ORDER BY t)) FROM (
  SELECT r::text t FROM reward_runs r UNION ALL SELECT l::text FROM reward_run_lines l
  UNION ALL SELECT p::text FROM ledger_postings p UNION ALL SELECT e::text FROM journal_entries e
  UNION ALL SELECT a::text FROM pool_allocations a UNION ALL SELECT i::text FROM investments i) x;
```

### 3. Apply to the target DB (requires explicit founder go-ahead)

1. Take a backup with `pg_dump`.
2. Run `npm run migrate`. This applies `0008_legacy_loss_transition.sql`. The CLI itself never
   migrates.
3. Run the CLI with `--dry-run` and confirm that the plan matches the step-1 evidence.
4. Run the same command without `--dry-run`. Alternatively, use
   `POST /api/admin/rewards/pools/:id/legacy-transition` with
   `{expectedCarryForward, approvalReference, dryRun}` and the transition key as the
   `Idempotency-Key` header.
5. Verify the result:
   - the pool is `investment_v2` and `transition_required = false`;
   - Σ `legacy_loss_transition_lines.loss_amount` equals the CF;
   - `GET /api/admin/ledger/integrity` reports zero problems;
   - the history digest is unchanged.

Retrying with the same key returns the recorded transition (`"replayed": true`) and writes
nothing. A different key is refused.

## MOMO-BTC evidence (verified read-only on dev, 2026-10-12 / 2026-10-13)

| Item | Value |
|---|---|
| Pool (strategy) | `a62949d8-52dc-4252-8490-9c4b70ad24c4` (MOMO-BTC), `pool_v1`, `transition_required` |
| Posted v1 runs | 1: `2b8860bf-debb-45fe-9432-14bbc507f7dc`, cf_open 0 → cf_close **15.174414**, attributable −15.174414, reserve 0 |
| Other runs | `f20ead3a-2831-46f9-b043-a76b869f2b82`, cancelled (ignored) |
| Allocations ever made | 1: `fc433842-f2ba-4a22-b48b-c6335f126d1a` → investment `2373327b-67e5-46af-8273-10952ba34cff` (demo@connect-income.local, 4000, active), weight fraction 1 |
| Independent recompute | R = −674.970920 (gain 478.697628 − loss 958.019557 − fees 195.648991); C = 1677250000000; A = 37707232000; floor(R·A/C) = −15.174414 ✔ |
| Legacy reserve | 0 |
| Attribution | 100% → allocation `fc433842…`, loss_amount 15.174414 (single responsible investment) |
| Rehearsal (clone) | dry run matched; executed; replay → `replayed: true`; second key → `already_transitioned`; history digest identical to dev; `checkLedgerIntegrity` → zero problems |

To apply to dev later: run step 3 with `--pool MOMO-BTC --expected 15.174414 --key
momo-btc-option-a-2026-10-12 --approver admin@connect-income.local`, together with the founder's
approval reference.
