# Architecture

## Overview

```
 Browser (React/Vite) ──/api (same origin via Vite proxy)──▶ Fastify API ──▶ PostgreSQL 16
                                                              │
                                                              ├─ background maturity sweep (every 30 s)
                                                              └─ optional simulated market clock (SIM_AUTOTICK_SECONDS)
```

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language across API/UI; types at boundaries |
| API | Fastify 5 | Fast, small, good plugin model (cookies, rate limit) |
| DB access | `pg` + hand-written SQL | Financial SQL should be explicit and reviewable; no ORM magic around locking/transactions |
| Migrations | Numbered `.sql` files, tiny runner (`src/db/migrate.ts`) | Auditable schema history, forward-only |
| Money | `decimal.js` in code, `NUMERIC(38,18)` in DB, strings on the wire | Exact arithmetic; no floats |
| Validation | zod | Declarative input validation |
| Frontend | React 19 + Vite + react-router | Standard, fast dev loop |
| Tests | Vitest against a real Postgres test DB | Ledger guarantees live in the DB, so tests must hit it |

### Trade-offs
- **Raw SQL vs ORM**: more boilerplate, but locking (`FOR UPDATE`), deferred constraints and idempotent inserts are first-class and visible. Revisit with a typed query builder (e.g. Kysely) if the schema grows a lot.
- **DB-enforced invariants**: business rules partly live in PL/pgSQL. This is deliberate defence-in-depth for money; app code also validates first for clear errors.
- **Single cached balance per account with row locks**: simple and correct; a hot platform account (e.g. custody) serialises writers. Fine for a simulation; at scale shard platform accounts or move to balance snapshots.
- **Monolith** for now. The strategy engine runs inside the API process (admin-triggered or the optional scheduler). Split it into a worker with its own DB role when it needs independent scaling or isolation.
- **One transaction per tick** makes processing slower than batching, but it is what makes every tick atomic and every run resumable. Throughput is roughly hundreds of ticks per second locally, which is plenty for a simulation.
- **Unrealised P&L is not booked.** Booking mark-to-market would add an entry per strategy per tick and blur realised from unrealised results. It is computed from positions and the last synthetic price instead.

## Modules (API)

- `ledger/accounts.ts` — chart of accounts (account *purposes*), get-or-create accounts, ordered locking.
- `ledger/ledger.ts` — `postEntry()`: validates, inserts entry + postings idempotently.
- `ledger/integrity.ts` — re-derives every balance from postings and checks all invariants.
- `services/idempotency.ts` — request-level idempotency (`Idempotency-Key` header).
- `services/deposits.ts` — simulated USDT deposits.
- `services/investments.ts` — products, opening investments, maturity settlement.
- `services/auth.ts` — registration, login, dev login, sessions.
- `services/audit.ts` — append-only audit log.
- `market/generator.ts` — deterministic synthetic price generator (pure).
- `market/market.ts` — instruments and append-only ticks; tick generation; scripted ticks for tests.
- `strategy/math.ts` — pure exact-decimal fill, fee, slippage, cost-basis, valuation and risk math.
- `strategy/logic.ts` — pure decision rules (momentum trading; staking and lending rebalancing) and parameter schemas.
- `strategy/engine.ts` — processing runs and per-tick transactions, executions, risk monitoring, ledger postings.
- `strategy/strategies.ts` — strategy management (create, pause, resume, allocate, kill switch) and read models.
- `rewards/calc.ts` — pure reward calculation (realised P&L, participation, carry-forward, reserve, pro-rata rounding).
- `rewards/pools.ts` — pools, product→pool assignment history, policies, allocation on investment.
- `rewards/runs.ts` — reward-run journal: calculate, post (with reconciliation), cancel, release at maturity, statements.
- `rewards/integrity.ts` — reward invariants used by the integrity checker.

## Data model

- `assets` (USDT, scale 6) · `users` · `sessions`
- `ledger_accounts` (purpose, normal balance, owner user **or** strategy, cached balance) · `journal_entries` · `ledger_postings`
- `investment_products` · `investments`
- `idempotency_keys` · `audit_logs`
- Milestone 2 (all SIMULATED):
  - `market_instruments`: symbols must start with `SIM-`, and `is_simulated` is forced to true. Instruments are immutable.
  - `market_ticks`: append-only.
  - `strategies`: identity fields are immutable, and the cursor can only move forward.
  - `strategy_positions`: current state, reconciled against trades.
  - `strategy_trades`, `strategy_tick_results` and `strategy_events`: append-only.
  - `strategy_runs`: an operational record.
  - `engine_settings`: the global kill switch.

## Rewards (milestone 3)

The full specification is in [`rewards-accounting.md`](rewards-accounting.md). In short:
- Investments in pool-backed products get an immutable allocation, a *simulated* participation record. Principal is never moved.
- An admin calculates a run for a closed period. The calculation reads realised trades, the paper-capital timeline and the allocations, and writes the run and its lines, but no ledger entries.
- Posting recomputes and reconciles first, then checks pool cash. Only then does it write one two-sided `reward_distribution` entry and, after a loss, a `reward_reserve_release` entry.
- Rewards sit in `user_reward_pending` until maturity settlement releases them.

Data model additions:
- `reward_pools`;
- `product_pool_assignments` (append-only);
- `pool_allocations` (immutable);
- `reward_policies` (versioned, immutable);
- `reward_runs` (calculation fields immutable; status changes only out of `calculated`);
- `reward_run_lines` (immutable except a one-time release reference);
- `reward_run_sources` (a trade feeds at most one posted run).

## Strategy engine (milestone 2)

**Market data.** A synthetic instrument's price at tick *n* is price(*n*−1) × (1 + drift + volatility·(2u−1) − shock).
The values *u* and the shock draw are derived from `sha256(seed:n:stream)`, and all arithmetic is exact decimal. The series is therefore identical however generation is batched or repeated. One tick is one simulated hour on a synthetic timeline that starts at the instrument's `genesis_at`. Tests use `synthetic_scripted` instruments with explicit prices.

**Processing.**
- `runEngine` iterates strategies and calls `processTick` for each tick after the strategy's cursor.
- `processTick` runs in a single DB transaction. It:
  1. locks the strategy row (`FOR UPDATE`) and skips the tick if it's already processed;
  2. marks to market and checks the loss limits;
  3. asks the decision rule for a desired position and sizes the order within the server-side limits;
  4. verifies the actual fill against post-trade limits, shrinking it until it passes;
  5. executes it (ledger entry, trade, position update);
  6. re-checks the loss limits;
  7. writes the tick result and advances the cursor.

A crash rolls back only the in-flight tick. The next run resumes at the cursor and reproduces exactly what an uninterrupted run would have done. Concurrent runs serialise on the row lock. A run whose process died without a heartbeat for 5 minutes is marked `abandoned`.

**Risk controls (server-side).**

| Control | Where | Effect |
|---|---|---|
| Max allocation | `allocateCapital` | Allocation rejected (422) |
| Max position value, max exposure ratio, available cash | pre-trade sizing and post-trade verification | Buy clipped (`order_clipped`) or rejected (`order_rejected`) |
| Daily loss limit (simulated day, UTC) | before and after trading, every tick | `risk_breach` → liquidate position, auto-pause |
| Max drawdown from peak equity | before and after trading, every tick | `risk_breach` → liquidate position, auto-pause |
| Pause (manual or automatic) | every tick | No buys; exits still allowed |
| Global kill switch | every tick | No buys for any strategy; exits still allowed |

Limits are checked at trade time. A price move after a trade can push a position above the position or exposure limit without a trade. The engine does not force-reduce in that case; it simply won't add more. Loss limits do force action.

Resuming a paused strategy re-baselines peak and day-start equity to current equity. Allocations shift those baselines by the allocated amount, so capital flows never register as P&L.

**Determinism.** The decision rules are pure functions of prices and state. The tests check that an interrupted run, a run split across concurrent workers, and a single uninterrupted run all produce identical trades.

## Planned components
See `roadmap.md`: strategy engine, reward distribution, native token, exchange (order book + AMM routing), risk engine, admin console.
