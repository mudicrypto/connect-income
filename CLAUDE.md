# CLAUDE.md — Connect Income

Crypto-finance **simulation** platform. Everything is simulated: no real funds, wallets, exchanges or mainnet contracts.

## Layout
- `apps/api` — Fastify + TypeScript API, raw SQL via `pg`, PostgreSQL 16.
  - `migrations/*.sql` — forward-only, numbered. Never edit an applied migration; add a new file.
  - `src/ledger/` — double-entry ledger (the ONLY code that writes postings) + integrity checker.
  - `src/services/` — domain logic (auth, deposits, investments, idempotency, audit).
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

## Architecture decisions (short)
- Postgres enforces ledger invariants with triggers (balanced entries checked as deferred constraints at COMMIT, no overdraft CHECK, immutability), so a bug in app code cannot corrupt the books.
- Cached balances are updated by the posting trigger under row lock; `balance_after` on each posting gives a running statement.
- Sessions: opaque random token in an HttpOnly SameSite=Strict cookie; only its SHA-256 is stored.
- Products carry **no rate**. Maturity currently returns principal only until the strategy engine exists.
