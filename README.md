# Connect Income

A crypto-finance **simulation** platform. Users can make simulated USDT deposits, open fixed-term investments and review an auditable double-entry ledger. Admins can run a **simulated strategy engine**: paper trading, staking and lending strategies on synthetic market data, with risk controls and per-strategy P&L in the ledger. Later milestones add rewards, a native token and an exchange.

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
npm run migrate
npm run seed      # prints the dev admin password once (note it down); also creates 3 demo strategies on synthetic data
```

## Run

```bash
npm run dev
```

- Web app: http://127.0.0.1:5173
- API: http://127.0.0.1:4000 (the web app proxies `/api`)

### Try it
1. Open http://127.0.0.1:5173 and click **One-click login as Demo User**, or register a new account.
2. On the **Dashboard**, make a simulated deposit (e.g. `1000`).
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
- [x] 70 tests in total (34 new in milestone 2)

### Next
- [ ] AI-agent strategy type (plugs into the pure decision-rule interface)
- [ ] Strategy capital withdrawal, limit editing, force-reduce on limit drift, separate engine worker and DB role
- [ ] Link investment principal to strategy pools (explicit design + migration), then rewards from realised strategy P&L
- [ ] Admin console: product management, ledger explorer, audit log viewer
- [ ] Risk management limits and kill switches
- [ ] Native token (internal ledger asset) and treasury
- [ ] Exchange: order book, matching engine, then AMM liquidity and routing
- [ ] Email verification, password reset, MFA, security headers, CI

See `docs/roadmap.md` for details.
