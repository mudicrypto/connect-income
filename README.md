# Connect Income

A crypto-finance **simulation** platform. Users can make simulated USDT deposits, open fixed-term investments and review an auditable double-entry ledger. Admins can run a **simulated strategy engine**: paper trading, staking and lending strategies on synthetic market data, with risk controls and per-strategy P&L in the ledger. Customer investments can participate in simulated strategy pools and receive **variable, never-guaranteed simulated rewards** paid only from realised pool profit. Each investment only ever recovers its *own* losses (per-investment high-water mark). Rewards are calculated per closed UTC day and posted only on admin approval. Later milestones add a native token and an exchange.

> ⚠️ Everything is simulated. There are no real funds, wallets, exchanges or blockchain connections. No returns are promised.

## Prerequisites
- Node.js ≥ 22 and npm ≥ 10
- PostgreSQL 16, either installed locally or via Docker

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env            # defaults work with the Postgres setup below

# 3a. Start Postgres with Docker (creates connect_income + connect_income_test)
docker compose up -d

# 3b. ...or with a local Postgres install, create the role and databases once:
#   psql -U postgres -c "CREATE ROLE connect WITH LOGIN PASSWORD 'connect_dev' CREATEDB;"
#   psql -U postgres -c "CREATE DATABASE connect_income OWNER connect;"
#   psql -U postgres -c "CREATE DATABASE connect_income_test OWNER connect;"

# 4. Create schema and synthetic seed data (investment products + dev admin)
npm run migrate   # the ONLY step that applies migrations; the server and seed refuse to run while one is pending
npm run seed      # prints the dev admin password once (note it down); creates 3 demo strategies and 2 reward pools
```

## Run

```bash
npm run dev       # refuses to start if a migration is pending: run `npm run migrate` explicitly first
```

- Web app: http://127.0.0.1:5173
- API: http://127.0.0.1:4000 (the web app proxies `/api`)

### Try it
1. Open http://127.0.0.1:5173 and click **One-click login as Demo User**, or register a new account.
2. On the **Dashboard**, make a simulated deposit (e.g. `1000`). The deposit faucet exists only with `DEV_MODE=true`.
3. Go to **New investment**, pick a product, enter an amount, accept the disclosure and click **Invest**.
   - Select **Dev: 5-minute term** to see maturity happen. The background sweep returns the principal about 5 minutes later.
4. **Investments** lists active and matured positions with their exact maturity dates.
5. **Transactions** shows every ledger posting on your accounts, with the running balance.
6. Log in as `admin@connect-income.local` (password printed by `npm run seed`) to open **Admin**. It has the ledger integrity check, trial balance and a manual "settle matured" button.
7. As admin, open **Strategies (sim)**:
   - **Advance synthetic market & run engine**: generates N synthetic hourly ticks, then processes every strategy. Watch P&L, exposure and drawdown change.
   - Open a strategy for its KPI tiles, equity chart (hover for values), limits, trade history and events/breaches. You can pause, resume or allocate paper capital there.
   - **Engage kill switch**: subsequent runs open no new positions (exits still happen).
   - **Create strategy**: choose a type, a synthetic instrument, limits and parameters (validated on the server).
   - To make the market tick automatically, set `SIM_AUTOTICK_SECONDS=15` in `.env` and restart `npm run dev`.
8. **Rewards (milestone 3).** FT-30D and the 5-minute dev product participate in pool `MOMO-BTC`. FT-90D participates in `STAKE-ETH`. FT-180D is principal-only.
   1. As a user, invest in FT-30D. The invest page shows the pool and the variable-reward disclosure.
   2. As admin, go to Strategies (sim), then **Advance synthetic market & run engine** so the pool trades.
   3. Then go to **Rewards (sim)** and click **Calculate next period**. New pools use **daily UTC periods**, so a day can be calculated only after it has closed. For an instant demo, switch the pool to ad hoc periods in *Pool lifecycle*. Review the run (every figure; each recipient's share, loss recovery and reserve; source trades), then **Post run to ledger** or **Cancel run**.
   4. After investments mature and every period they took part in is posted, use **Settle matured investment(s)** in *Pool lifecycle*. Each investment's owned reserve is returned and any unrecovered loss expires. Closing a pool never releases anything by itself.
   5. As the user, the dashboard shows **Rewards pending**. On **Investments**, click **Statement** for the per-period breakdown. Rewards move to *Available* when the investment matures; with the 5-minute dev product that's within minutes.
   6. Many periods pay **nothing**. That happens whenever the pool made a loss, only had unrealised gains, or is still recovering earlier losses. This is intended.

## Test

```bash
npm test          # runs against TEST_DATABASE_URL (must end in _test; the schema is dropped and recreated)
npm run typecheck
```

The tests cover:
- decimal math, and ledger invariants enforced by the DB (balanced entries, no overdraft, append-only);
- deposits, investments, maturity and idempotency;
- concurrency (no double-spend, exactly-once) and a randomised consistency workload;
- authentication and authorization.

Reward tests cover:
- calculations against values checked independently in Python (pro rata, fees, reserve, rounding residual);
- zero-profit and loss periods, and loss carry-forward;
- a 300-period identity check that nothing is ever paid twice;
- the allocation capacity limit under concurrency, and paused pools;
- the full calculate, post and release-at-maturity cycle;
- double-post prevention, period contiguity and unique sources;
- interrupted post, reconciliation failure, insufficient pool cash, and admin-only access.

Strategy-engine tests cover:
- exact P&L for profitable and losing trades, checked against independently computed values;
- fees and slippage;
- allocation, position and exposure limits;
- daily loss and drawdown breaches with auto-pause and liquidation, the pause and kill-switch behaviour, and strategy reconciliation;
- duplicate tick processing and concurrent runs;
- recovery after an injected crash, separation from customer balances, and admin-only access.

## Project structure
```
apps/api     Fastify API, SQL migrations, ledger, services, tests
apps/web     React UI
docs/        architecture.md · accounting.md · security.md · roadmap.md
CLAUDE.md    engineering rules and key decisions
```

## API (milestone 1)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` · `/dev-login` | dev-login only when `DEV_MODE=true` |
| GET | `/api/auth/me` | |
| GET | `/api/dashboard` · `/api/balances` · `/api/products` · `/api/investments` · `/api/transactions?before=&limit=` | auth required |
| POST | `/api/deposits/simulated` `{amount}` | requires `Idempotency-Key` header |
| POST | `/api/investments` `{productId, amount}` | requires `Idempotency-Key` header |
| GET | `/api/admin/ledger/integrity` | admin |
| POST | `/api/admin/investments/settle-matured` | admin |
| GET/POST | `/api/admin/strategies` | admin: list (with metrics) / create |
| GET | `/api/admin/strategies/:id` | admin: metrics, trades, events, equity series |
| POST | `/api/admin/strategies/:id/pause` · `/resume` | admin |
| POST | `/api/admin/strategies/:id/allocations` `{amount}` | admin; requires `Idempotency-Key` |
| GET | `/api/admin/engine` | admin: kill switch, runs, instruments |
| POST | `/api/admin/engine/run` | admin: process all strategies up to the latest tick (idempotent) |
| POST | `/api/admin/engine/kill-switch` `{enabled, reason}` | admin |
| POST | `/api/admin/market/advance` `{ticks}` | admin; requires `Idempotency-Key`; synthetic data only |
| GET | `/api/investments/:id/rewards` | owner only: per-period simulated reward statement |
| GET/POST | `/api/admin/rewards/pools` · PATCH `/pools/:id` | admin: list, register, update capacity or status |
| POST | `/api/admin/rewards/product-assignments` `{productId, poolStrategyId\|null}` | admin |
| POST | `/api/admin/rewards/policies` `{name, reserveRatio}` | admin: new immutable policy version |
| GET/POST | `/api/admin/rewards/runs` `{poolStrategyId, periodEnd?}` | admin; POST requires `Idempotency-Key`; `periodEnd` defaults to the server clock; calculates only, no ledger writes |
| GET | `/api/admin/rewards/runs/:id` | admin: figures, recipients (with per-investment loss recovery and reserve), source trades |
| GET | `/api/admin/rewards/pools/:id/settlement` | admin: per-investment reserve and settlement states, pool state |
| POST | `/api/admin/rewards/pools/:id/settle-reserves` | admin; requires `Idempotency-Key`; final settlement of matured investments |
| POST | `/api/admin/rewards/pools/:id/switch-loss-model` | admin; legacy → per-investment, only if legacy balances are zero |
| POST | `/api/admin/rewards/pools/:id/legacy-transition` `{expectedCarryForward, approvalReference, dryRun?}` | admin; `Idempotency-Key` = transition key; Option A legacy → v2 (see `docs/runbooks/legacy-pool-transition.md`) |
| POST | `/api/admin/rewards/pools/:id/period-mode` `{periodMode}` | admin; `daily_utc` or `ad_hoc` |
| POST | `/api/admin/rewards/runs/:id/post` · `/cancel` | admin |

Amounts are always decimal **strings** (e.g. `"100.50"`).

## Status

### Completed
- [x] Monorepo (TypeScript, Fastify, React/Vite, PostgreSQL), migrations, seed data
- [x] Registration, login, logout, dev login, DB-backed sessions
- [x] Double-entry ledger with DB-enforced invariants (balanced, append-only, no overdraft, segregated accounts)
- [x] Simulated USDT deposits (idempotent)
- [x] Fixed-term investment products and investments with maturity dates (idempotent, concurrency-safe)
- [x] Automatic maturity settlement (returns principal; no reward until the strategy engine exists)
- [x] Dashboard, investments page, transaction history
- [x] Audit log, ledger integrity checker, admin integrity page
- [x] 36 tests: money, ledger, flows, concurrency, auth/authorization
- [x] **Milestone 2:** synthetic market data (`SIM-*`, deterministic, append-only)
- [x] Strategy management (trading / staking / lending), admin-only create, inspect, pause and resume
- [x] Paper-trading engine: fees, slippage, realised and unrealised P&L, exact decimals, conservative rounding
- [x] Per-strategy sub-ledger (paper capital, cash, position, gain, loss, fees), reconciled by the integrity checker
- [x] Idempotent, concurrency-safe, crash-recoverable tick processing
- [x] Risk controls: allocation, position, exposure, daily loss, drawdown, auto-pause with liquidation, global kill switch
- [x] Admin strategy dashboard (KPI tiles, equity chart, trades, events and breaches); all metrics labelled simulated
- [x] 70 tests at the end of milestone 2 (34 new in milestone 2)
- [x] **Milestone 3:** accounting design first (`docs/rewards-accounting.md`)
- [x] Customer-to-pool allocations: immutable, audited, time-bounded to the investment term, capped by pool capacity and paper capital (race-safe)
- [x] Versioned reward policies; reward runs with calculate / review / post / cancel, reconciliation on post, and failure handling
- [x] Rewards from realised profit only, after fees and losses, with reserve, loss carry-forward, pro-rata floor rounding, residual to reserve, and a hard cap
- [x] Rewards accrue as customer liabilities and are released at maturity; per-investment statement
- [x] Admin rewards console; user reward visibility; all labelled simulated
- [x] 93 tests at the end of milestone 3 (23 new in milestone 3)
- [x] **Milestone 3 audit** (`docs/milestone-3-audit.md`): 8 defects fixed, with regression tests, DB guards and a SQL lint; 112 tests in total
- [x] **Milestone 3.5, economic-model refinement** (`docs/rewards-accounting-v2.md`): per-investment loss recovery, daily UTC periods, reserve ownership and approved final settlement, legacy pools preserved; 17 new tests (129 total)
- [x] **Legacy transition, Option A** (`docs/runbooks/legacy-pool-transition.md`): attributes a v1 carry-forward to the single responsible investment; forward-only, DB-reconciled, idempotent, aborts when ambiguous; CLI `npm run transition:legacy -w apps/api`; 15 new tests (144 total). Not applied to MOMO-BTC in dev yet.
- [x] **Pre-token adversarial audit** (`docs/pre-token-audit.md`): 39 findings verified; 26 fixed with DB guards (migration 0009: entry-shape rules, single-strategy entries, account guards, scale, lock-ordered posting ids) and regression tests; no startup path migrates implicitly; legacy CLI dry-run by default; 22 new tests (166 total).

### Next
- [ ] AI-agent strategy type (plugs into the pure decision-rule interface)
- [ ] Strategy capital withdrawal, limit editing, force-reduce on limit drift, separate engine worker and DB role
- [ ] Apply the MOMO-BTC Option A transition to dev (runbook step 3), when the founder gives the go-ahead
- [ ] Founder decision for legacy pools that Option A cannot handle (ambiguous attribution, or a pool-level reserve)
- [ ] Open founder decisions from the pre-token audit: per-investor pool caps (S2), narrower Option A attribution (A7), DB owner/app role split (L12), four-eyes approvals (A11)
- [ ] Optional performance fee (new policy version + fee-revenue account)
- [ ] Principal-at-risk model (actually deploying principal into pools), if the founder wants it, with its own design
- [ ] Batch approval for backlogs of closed days (each day is still reviewed); calculation-only scheduler (never posts)
- [ ] Admin console: product management, ledger explorer, audit log viewer
- [ ] Risk management limits and kill switches
- [ ] Native token (internal ledger asset) and treasury
- [ ] Exchange: order book, matching engine, then AMM liquidity and routing
- [ ] Email verification, password reset, MFA, security headers, CI

See `docs/roadmap.md` for details.
