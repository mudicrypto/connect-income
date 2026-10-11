# Connect Income

A crypto-finance **simulation** platform. Users can make simulated USDT deposits, open fixed-term investments and review an auditable double-entry ledger. Later milestones add a strategy engine, rewards, a native token and an exchange.

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
npm run seed      # prints the dev admin password once — note it down
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

## Test

```bash
npm test          # runs against TEST_DATABASE_URL (must end in _test; the schema is dropped and recreated)
npm run typecheck
```

The tests cover decimal math, ledger invariants enforced by the DB (balanced entries, no overdraft, append-only), deposits, investments, maturity, idempotency, concurrency (no double-spend, exactly-once), a randomized consistency workload, authentication and authorization.

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

### Next
- [ ] Strategy engine: simulated traders, AI agents, staking, lending; ledger-recorded P&L
- [ ] Rewards computed from realised strategy P&L
- [ ] Admin console: product management, ledger explorer, audit log viewer
- [ ] Risk management limits and kill switches
- [ ] Native token (internal ledger asset) and treasury
- [ ] Exchange: order book, matching engine, then AMM liquidity and routing
- [ ] Email verification, password reset, MFA, security headers, CI

See `docs/roadmap.md` for details.
