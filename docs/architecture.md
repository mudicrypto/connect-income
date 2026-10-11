# Architecture

## Overview

```
 Browser (React/Vite) ──/api (same origin via Vite proxy)──▶ Fastify API ──▶ PostgreSQL 16
                                                              │
                                                              └─ background maturity sweep (every 30 s)
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
- **Monolith** for now. The strategy engine and exchange matcher will start as modules in the API and be split into workers when they need independent scaling.

## Modules (API)

- `ledger/accounts.ts` — chart of accounts (account *purposes*), get-or-create accounts, ordered locking.
- `ledger/ledger.ts` — `postEntry()`: validates, inserts entry + postings idempotently.
- `ledger/integrity.ts` — re-derives every balance from postings and checks all invariants.
- `services/idempotency.ts` — request-level idempotency (`Idempotency-Key` header).
- `services/deposits.ts` — simulated USDT deposits.
- `services/investments.ts` — products, opening investments, maturity settlement.
- `services/auth.ts` — registration, login, dev login, sessions.
- `services/audit.ts` — append-only audit log.

## Data model (milestone 1)

- `assets` (USDT, scale 6) · `users` · `sessions`
- `ledger_accounts` (purpose, normal balance, owner, cached balance) · `journal_entries` · `ledger_postings`
- `investment_products` · `investments`
- `idempotency_keys` · `audit_logs`

## Planned components
See `roadmap.md`: strategy engine, reward distribution, native token, exchange (order book + AMM routing), risk engine, admin console.
