# CLAUDE.md — Connect Income

Crypto-finance **simulation** platform. Everything is simulated: no real funds, wallets, exchanges or mainnet contracts.

## Layout
- `apps/api` — Fastify + TypeScript API, raw SQL via `pg`, PostgreSQL 16.
  - `migrations/*.sql` — forward-only, numbered. Never edit an applied migration; add a new file.
  - `src/ledger/` — double-entry ledger (the ONLY code that writes postings) + integrity checker.
  - `src/services/` — domain logic (auth, deposits, investments, idempotency, audit).
  - `src/market/` — SYNTHETIC market data (deterministic generator, append-only ticks).
  - `src/strategy/` — paper-trading engine: pure math/logic + transactional per-tick engine + management/read models.
  - `src/rewards/` — customer pool allocations + SIMULATED variable rewards: pure calculators (`calc.ts`: `calculateRewards` = legacy pool_v1, `calculateRewardsV2` = per-investment), pools/policies/allocation (`pools.ts`), reward-run journal (`runs.ts`), reserve settlement + pool lifecycle (`settlement.ts`), reward invariants (`integrity.ts`), Option A legacy → v2 transition (`legacy-transition.ts`). Specs: `docs/rewards-accounting.md` (v1) + `docs/rewards-accounting-v2.md` (v2, governs investment_v2 pools).
  - `src/http/` — routes; thin, no business logic.
  - `test/` — Vitest against a real Postgres `*_test` database.
- `apps/web` — React + Vite + react-router. Talks to `/api` via the Vite proxy (same origin).
- `docs/` — architecture, accounting, security, roadmap. Update them with any design change.

## Commands
`npm run dev` · `npm test` · `npm run typecheck` · `npm run migrate` · `npm run seed`

## Non-negotiable rules
1. **Money is never a JS `number`.** Use `Money` (decimal.js) from `src/lib/money.ts`; amounts cross the API as strings; DB columns are `NUMERIC(38,18)`; respect `assets.scale`.
2. **Every balance change is a balanced journal entry** via `postEntry()`. Never `UPDATE ledger_accounts.balance` (a trigger forbids it). Ledger tables are append-only — corrections are reversing entries.
3. **Financial operations run in `withTransaction`** and mutate business state + ledger + audit log in the same transaction.
4. **Financial POST endpoints require an `Idempotency-Key`** and use `runIdempotent`. Journal entries also carry a unique, deterministic idempotency key (e.g. `investment:<id>:mature`).
5. **Segregate funds by account purpose** (user available, user invested, platform custody; later: strategy P&L, reward liability, treasury, exchange liquidity). New purposes need a migration.
6. **Never fabricate** profits, liquidity, deposits or trading activity. **Never promise returns.** Rewards may only be paid from realised simulated strategy P&L that is itself recorded in the ledger.
7. AI agents / strategy code get no access to user credentials, keys, or withdrawal capability; they act only through scoped, audited service APIs.
8. No secrets in git. `.env` is gitignored; `.env.example` documents variables.
9. Authorization: every user route derives the user from the session (`requireUser`); never accept a userId from the client. Admin routes use `requireAdmin`.
10. Add tests for every financial flow, invariant and authorization rule. `checkLedgerIntegrity()` must report zero problems after every test scenario.
11. Ask the founder before destructive commands or anything with external side effects.
12. **Simulation labelling**: instruments must be `SIM-*` with `is_simulated = true` (DB-enforced); every UI surface showing strategy data says "simulated". Never present synthetic prices, trades or P&L as real.
13. **Strategy money stays in the strategy sub-ledger.** Strategy entries may only touch that strategy's own accounts. The sole exit is a posted reward run (rule 19), which moves realised profit to customer liabilities in a two-sided entry. A strategy profit never credits a customer directly.
14. **Engine changes must keep processing idempotent and resumable**: one transaction per (strategy, tick), cursor advanced in the same transaction, deterministic journal keys. Decision rules must stay pure and deterministic.
15. **Risk checks run on the server** inside the tick transaction; the UI only displays them.
16. SQL gotcha: never `ORDER BY x` when the SELECT list contains `x::text` (sorts as text). Qualify the column (`t.x`).
17. **Rewards follow the accounting docs exactly** — `rewards-accounting-v2.md` for `investment_v2` pools (all new pools), `rewards-accounting.md` for legacy `pool_v1` pools. Change the doc first, then the code. Only realised P&L is distributable; losses are recovered **per investment** (an investor never inherits losses from before they joined); rewards are capped by the distributable amount; rounding never favours payout. Never pay anything because time elapsed.
18. **Customer principal is never deployed into strategies.** Allocations are simulated participation records; paper capital is never treated as customer money. Rewards are paid only with cash that exists in the pool's `strategy_cash`, moved in the same entry that creates the customer liability.
19. Reward runs: calculate writes no ledger entries; post recomputes and reconciles before writing; posted/cancelled/failed runs are final. Cross-ledger entries are allowed only for `reward_distribution` / `reward_reserve_release`, each half balanced.
20. SQL gotcha: `now()` is the transaction START time — never use it to decide what concurrent, already-committed rows "exist yet" (see the pool capacity check). Writes dated inside a posted reward period are rejected by DB triggers with SQLSTATE 40001 and retried by `withTransaction`.
21. **Every capital flow in or out of a strategy must shift its risk baselines** (`last_equity`, `peak_equity`, `day_start_equity`) in the same transaction, or the risk monitor mistakes it for P&L. Allocations and reward postings do this today.
22. **Reward posting lock order:** run → pool → strategy → recipients' investments → ledger accounts. New code touching these rows must follow the same order.
23. `test/sql-lint.test.ts` statically rejects `ORDER BY x` with `x::text` in the select list; keep it passing. `docs/milestone-3-audit.md` lists the audit findings and the open economic decisions.
24. **Never rewrite historical reward runs, lines or ledger rows.** Model changes are forward-only: a pool moves pool_v1 → investment_v2 only when its legacy pool-level carry-forward and reserve are both zero; or through an approved Option A legacy transition (rule 27). Otherwise it stays on v1 with `transition_required` until the founder decides (rewards-accounting-v2.md §7).
25. **Posting and reserve settlement always need explicit admin approval.** No scheduler may post runs or settle reserves. Daily UTC periods are calculated only after the UTC day has closed. A reserve is owned by the investment it was withheld from and is returned only by final settlement (after maturity and after every overlapping period is posted) — never because a pool is closed.
26. Test fixtures that need closed past days use `test/history-fixtures.ts` (backdated, balanced, integrity-consistent rows). Production code never sets `created_at` explicitly.
27. **Legacy pool transitions** (Option A, `docs/runbooks/legacy-pool-transition.md`) go only through `transitionLegacyPool`. It is founder-approved, attributes the v1 carry-forward exactly to the single responsible investment, aborts on any ambiguity or mismatch, writes no ledger entry, and never touches history. `legacy_loss_transitions`/`_lines` are append-only and reconciled by deferred DB triggers. Rehearse on a clone before applying to a real DB.
28. **Nothing migrates implicitly.** The server, seed and CLIs call `assertSchemaCurrent` and refuse to run with a pending migration; only `npm run migrate` applies one. The legacy-transition CLI is a dry run unless given `--execute`.
29. **Ledger shape is DB-enforced** (migration 0009): a new entry type, or a new account a type may touch, needs a reviewed `ledger_entry_rules` row in a migration. An entry may touch one strategy's accounts at most. Amounts must respect `assets.scale`.
30. **Account locks are taken in one id-ordered batch** (`lockAccounts`) by any transaction that posts more than one entry, after the pool/strategy/investment locks (rule 22). Never lock an account before the pool in the same transaction.
31. `docs/pre-token-audit.md` lists the pre-token audit findings, their fixes and the open founder decisions. Regression tests: `test/pre-token-audit.test.ts`.

## Architecture decisions (short)
- Postgres enforces ledger invariants with triggers (balanced entries checked as deferred constraints at COMMIT, no overdraft CHECK, immutability), so a bug in app code cannot corrupt the books.
- Cached balances are updated by the posting trigger under row lock; `balance_after` on each posting gives a running statement.
- Sessions: opaque random token in an HttpOnly SameSite=Strict cookie; only its SHA-256 is stored.
- Products carry **no rate**. Maturity currently returns principal only; strategy P&L is not yet linked to investments.
- Strategy capital is per-strategy **paper capital** (equity), not customer funds. Realised P&L is booked; unrealised P&L is computed, never booked.
- Engine: per-tick transaction with strategy row lock + cursor; UNIQUE(strategy, tick) results; crash = rollback of one tick, next run resumes.
- Rewards (M3): one pool per product (append-only assignment history); time-weighted participation vs. paper capital; no performance fee; rewards accrue to `user_reward_pending` and are released at maturity.
- Rewards v2 (M3.5): per-investment loss recovery (= per-investment high-water mark) with balances as immutable memos on run lines; per-investment owned reserve with admin-approved final settlement (`reserve_settlements`, entry `reserve_settlement`); daily UTC periods by default (`period_mode`); legacy pools stay on v1 until a founder decision.
