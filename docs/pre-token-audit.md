# Pre-token adversarial audit: security and accounting (2026-10-13)

Scope: the whole system at commit `f34e780` (milestones 1–3.5 plus the Option A legacy
transition), before any token work. Everything is SIMULATED. The development database was **not
modified**: migrations 0008 and 0009 are not applied to it, and the MOMO-BTC transition was not
executed there. Rehearsals ran only on throwaway clones and on the test database.

## Method

1. **Four independent read-only audits**: ledger correctness, rewards lifecycle, legacy
   transition, and authorization/application security. Each audit traced code paths and DB
   triggers and produced concrete failure scenarios.
2. **Independent verification of every finding** against the code. Each confirmed defect
   received a regression test in `apps/api/test/pre-token-audit.test.ts`. **18 of those tests
   were run against the unfixed code and failed**, reproducing the defects. Two further tests
   were added with the fixes (the market-advance audit replay and the digest determinism).
3. **Fixes**: migration `0009_pre_token_hardening.sql` plus code changes. A finding that is an
   economic or product choice, rather than a defect, is listed as an **open founder decision**
   and was not changed.
4. **Full verification**: test suite twice, typechecks, builds, compiled-API boot on a scratch
   clone, integrity on a clone of dev with 0008 and 0009 applied, and the MOMO-BTC rehearsal
   repeated with the hardened code.

The audit request was cut off after "5. **Financial". Sections 1–4 were audited as written.
Financial invariants and abuse paths were covered under sections 1, 2 and 4. Any additional
section 5+ requirements still need to be supplied.

## Summary

| Severity | Found | Fixed | Accepted / documented | Open founder decision |
|---|---|---|---|---|
| High | 2 | 2 | – | – |
| Medium | 9 | 8 | – | 1 (S2) |
| Low | 21 | 15 | 4 (L7, L8, R6, S6c) | 2 (A7, L12) |
| Info | 7 | 1 | 3 (R8, R10, S7) | 3 (A11, L13, S8) |

**No finding lets money be created, paid twice, or paid to the wrong customer through the API.**
Each high and medium defect fell into one of three groups:
- a safety interlock that could be bypassed (implicit migration on startup, dry-run handling);
- a simulated-funds faucet left open outside DEV_MODE;
- a correctness gap that only the integrity checker, not the database, would have caught. These
  are the entry-shape rules, the cross-strategy rule and capital-allocation key reuse.

## Findings

Status: **Fixed**, meaning code, migration and regression test, or **Accepted**, meaning it is
documented with its rationale and is safe as is. **Open** marks a founder decision.

### Legacy transition (Option A)

| ID | Sev. | Finding | Status | Fix and test |
|---|---|---|---|---|
| A1 | High | `server.ts` and `seed.ts` ran all pending migrations at startup. Starting the dev server would silently apply 0008 to dev. The transition itself was never executed by any startup path (verified). | Fixed | `assertSchemaCurrent()`: server, seed and CLI refuse to run while a migration is pending; only `npm run migrate` applies one. Test A1. |
| A2 | High | The CLI parsed `--dry-run=true` or `--dryrun` as unknown flags, which swallowed an argument and ran a **real** transition. | Fixed | `parseTransitionArgs`: dry run is the default; executing requires `--execute`. Unknown, repeated or conflicting flags abort. Test A2. |
| A3 | Med | The HTTP route executed for any `dryRun` that was not JSON `true`, e.g. `"true"` or a missing field. | Fixed | zod schema: `dryRun` is a required boolean. Test. |
| A4 | Med | A replay with the same key returned success even when the amount, approval or approver differed. A dry run after execution returned the executed record. | Fixed | 409 `idempotency_key_reused` or `already_transitioned`. Test. |
| A5 | Low | A key reused on another pool, a short approval, or a malformed id returned 500. | Fixed | Global key check, 23505 mapped to 409, approval validated (400), UUID checked. Test. |
| A6 | Low | `recomputeRunMismatches` used **today's** reserve and v2 balances, not the run's own opening balances. Any v1 pool whose history ever applied its reserve could never be transitioned (`legacy_run_not_reproducible`). | Fixed | Historical opening balances (v1 `reserve_open`, v2 per-line memos). Test A6: reserve applied → recompute clean → transition succeeds. |
| A6b | Low | The history digest covered only runs, lines and strategy postings. It depended on session TimeZone/DateStyle, and a concurrent engine tick could abort it spuriously. | Fixed | It now also covers run sources, allocations, investments, settlements and every entry touching the strategy. Rendering is fixed to UTC/ISO, and the strategy row is locked (pool → strategy). Test A6b. The before/after comparison still only guards against future code changes; the independent check is the clone comparison in the runbook. |
| A7 | Low | The code counts every run with non-zero P&L as "contributing" (broader than doc §7.1). | Doc aligned. **Open** | The broad rule fails safe. Narrowing it to the runs since CF was last 0 is a founder decision. |
| A8 | Low | No HTTP-level tests of the route (authorization, key, input). | Fixed | Tests for 401/403/400/409. |
| A9 | Low | 0008 functions had no pinned `search_path`, so a temporary table could shadow a real one. | Fixed | 0009 pins `search_path` on every function. See L12 for the stronger fix. |
| A10 | Info | The DB check did not require an attributed allocation to have participated, and its v2-run check used `created_at`. | Fixed | 0009 requires a posted v1 line with weight > 0, and that no v2 run exists. |
| A11 | Info | The approval is free text, and any admin can execute. | **Open** | Four-eyes approval belongs in the admin milestone. |

Dry run confirmed to write nothing: every statement before the early return is a SELECT (or a row
lock released at commit). There is no audit row, no idempotency row and no pool update.

### Ledger

| ID | Sev. | Finding | Status | Fix and test |
|---|---|---|---|---|
| C1 | Med | Capital allocation: the journal key was not scoped by actor, and `created:false` was ignored. A key reused by another admin posted nothing but still shifted the risk baselines and logged an allocation. That fakes a drawdown, which forces liquidation and an auto-pause. | Fixed | Key includes the actor; an existing entry aborts (409). Test C1. |
| L3 | Med | Entry types were not tied to account shapes. Any balanced entry, e.g. a "deposit" into `user_invested` or a release funded by custody, passed every check. | Fixed | 0009 `ledger_entry_rules` (entry type × purpose × direction, append-only), enforced on every posting. Test. |
| L4 | Med | Cross-ledger mixing was enforced only by the checker. An entry could move value between two strategies' sub-ledgers. | Fixed | The commit-time check rejects any entry touching more than one strategy. The rules above restrict the customer half of reward entries. Test. |
| L5 | Low-Med | Posting ids are drawn before the account lock is taken. Under concurrency, id order ≠ `balance_after` order, which gave non-monotonic statements and a **false** "running balance disagrees" integrity problem (reproduced). | Fixed | The posting trigger draws the id after taking the lock. Test L5 (concurrent clients). |
| L6 | Low | An account could be inserted with a balance; `allow_negative`, `code` and `category` were mutable. `allow_negative` would also hide an overdraft from the checker. | Fixed | Insert guard: zero balance, no `allow_negative`, category and normal balance must match the purpose. Those fields are now immutable. Test. |
| L9 | Low | Amounts above `assets.scale` were not rejected (silently rounded at 18 dp). | Fixed | Rejected in `postEntry` and in the posting trigger. Test. |
| L10 | Low | The trial-balance check compared NUMERIC **text** (`'0'` ≠ `'0.000…'`). | Fixed | Exact `Money` comparison. |
| L11 | Low | The pending-rewards reconciliation ignored asset; settlement hard-coded `USDT`. | Fixed | Per user and asset; settlement uses the pool's quote asset. |
| L7 | Low | The balance guard keys on `pg_trigger_depth()`, not on the caller. | Accepted | No depth-1 trigger updates accounts; any new one is reviewed with its migration. |
| L8 | Low | A balanced pair of postings can be appended to a committed entry by raw SQL. | Accepted | The app cannot do this (`postEntry` returns on a key conflict). Shape, balance and strategy rules still apply. Covered by L12. |
| L12 | Low | The runtime DB role owns the tables, so it could disable triggers. | **Open** (deployment) | Before any real deployment, migrations should run as an owner role and the app as a role without DDL. |
| L13 | Info | v2 can pay a period profit while the pool's cumulative P&L is negative. | **Open** (E3 in `milestone-3-audit.md`) | Unchanged: per-period spec with per-investment loss recovery. |

### Rewards lifecycle

| ID | Sev. | Finding | Status | Fix and test |
|---|---|---|---|---|
| R1 | Med | Lock-order violation: `createInvestment` took accounts → pool, while posting and settlement take pool → accounts. Multi-entry transactions also locked customer accounts in data order. Postgres detected the resulting deadlocks (40P01) and retried them, but they could exhaust retries. | Fixed | Pool before accounts in `createInvestment`. `postRun`, settlement and the maturity sweep take every account lock in one id-ordered batch. The existing concurrency tests pass. |
| R2 | Med | v2 had no customer-share cap. If a race admitted ΣA > C, customers were attributed more profit (or loss) than the pool realised, funded by paper capital. | Fixed | Spec first (v2 §3.1: `D = max(C, ΣA)`), then code. Integrity: a profit is never over-attributed, and a loss only by the documented rounding (≤ 1 unit per line). Test R2. |
| R4 | Low | Close vs. assign race: a closed pool could keep an assigned product. | Fixed | Assignment locks the pool `FOR SHARE`. Test R4. |
| R7 | Low | `loss_model` and `attribution_residual` were not frozen on calculated runs. Post did not reconcile `capital_integral` and related inputs. | Fixed | 0009 guard. Post now reconciles all stored figures. Test. |
| R6 / S6a | Low | `POST /runs/:id/post` and `/cancel` take no Idempotency-Key (rule 4). | Accepted | Double posting is impossible: run row lock, status machine and per-run journal keys. A retry gets an honest 409. Documented exception. |
| R8 | Info | `rewards_start_at` and the ad-hoc `periodEnd` pass through JS `Date` (ms). | Accepted | Consistent after the first period. |
| R10 | Info | Ad-hoc `periodEnd = now()` makes `reconciliation_failed` likely under concurrent writers. | Accepted | Liveness only; daily UTC periods are the default. |

Verified sound:
- Calculation writes no ledger entries. There is one pending run per pool, and runs are final
  once posted, cancelled or failed.
- Post re-checks the period chain, and the period guards catch late writers.
- Daily UTC boundaries are correct (`next_utc_midnight`). Unclosed days are rejected.
- Loss recovery is per investment, so late joiners start at 0. Reserves are owned per
  investment, and rounding goes against payout.
- Settlement happens only after maturity, once every overlapping period is posted, and only once.
- Only realised P&L is counted. No scheduler posts runs or settles reserves.

### Authorization and application security

| ID | Sev. | Finding | Status | Fix and test |
|---|---|---|---|---|
| S1 | Med | The simulated deposit faucet was open to every user even with `DEV_MODE=false` (documented as dev-only). | Fixed | 404 unless `DEV_MODE`; the UI hides it. Test S1. |
| S2 | Med | No per-investor cap: one user can fill a pool's capacity and take nearly all its rewards. | **Open** | An economic rule, not a defect: per-user or per-pool caps need a founder decision and a doc change. The faucet fix removes the unlimited funding outside dev. |
| S4 | Low | The UUID check accepted 36 hex characters or 36 dashes, and some admin routes had no check. Malformed ids or cursors returned 500. | Fixed | Strict UUID regex everywhere. Postgres input errors (22P02/22003/22007/22008) map to 400 without echoing DB text. A bad cursor gives 400. Test S4. |
| S5 | Low | `trustProxy:false` behind a proxy meant every client shared one IP for rate limits, so one client could lock everyone out of login. | Fixed | `TRUST_PROXY` (default `loopback`); the Vite proxy sends `X-Forwarded-For`. A per-account login throttle is still a known gap (security.md). |
| S6b | Low | `market/advance` wrote its audit row outside the idempotent transaction, so a replay logged twice. | Fixed | Audit inside the transaction. Test. |
| S6c | Low | `settle-matured` has no key, and its summary audit is outside a transaction. | Accepted | Each maturity is idempotent and audited inside its own transaction. |
| S7 | Info | Raw `err.message` from `/engine/run` and `/runs` failures is returned to admins. | Accepted | Admin-only; it is the failure reason by design. |
| S8 | Info | Registration reveals existing emails (409). There is no `__Host-` cookie prefix, `COOKIE_SECURE` defaults to false, and there are no security headers. | **Open** | Documented in security.md; to address before any public deployment. |

Verified sound:
- Every user route derives the user from the session, and no route accepts a client userId.
- The reward statement and transactions are owner-filtered: no IDOR.
- Every admin route is guarded (plugin hook or `requireAdmin`). Role is read live per request.
- Registration cannot set a role. Dev login and the seeded admin exist only in DEV_MODE, and the
  admin password is random.
- Sessions: hashed tokens, server-side logout, HttpOnly + SameSite=Strict, and no
  form/text-plain parser (CSRF).
- scrypt with constant-time comparison. Idempotency keys are scoped per user and bound to the
  request body.
- All SQL is parameterised.
- The kill switch and paused status are enforced in the tick transaction.
- Strategy decision code has no access to users, credentials or withdrawals (rule 7).
- No secrets are in git history.

## Behaviour changes to know about

- **Dev workflow:** `npm run dev` and `npm run seed` no longer migrate. After pulling, run
  `npm run migrate` explicitly. Against the current dev DB (at 0007) the server now refuses to
  start, which is the intended protection while 0008 awaits the founder's go-ahead.
- **Legacy CLI:** a dry run is the default; `--execute` is required to apply.
- **Faucet:** without `DEV_MODE` there are no simulated deposits, matching `.env.example`.
- **Capital allocation journal keys** now include the admin id (`strategy_capital:<s>:<admin>:<key>`).
  Old entries are unchanged.

## Verification record

Results are filled in at commit time; see the commit message for the exact counts.

- Regression tests: 18 failed on the unfixed code, then all 22 passed with the fixes (20
  original + 2 added with the fixes).
- Full suite twice, both typechecks, both production builds.
- Compiled API boot on a scratch clone after an explicit `npm run migrate`.
- On a clone of dev with 0008 and 0009 applied, `checkLedgerIntegrity()` reports zero problems.
  The MOMO-BTC rehearsal (dry run, `--execute`, replay) gives the same attribution, 15.174414 →
  allocation `fc433842…`, and the integrity check is clean afterwards.
- The dev DB was checked read-only at the end: still at 0007, MOMO-BTC still `pool_v1`.
