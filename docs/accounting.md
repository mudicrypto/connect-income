# Financial accounting

All amounts are exact decimals. USDT uses 6 decimal places (`assets.scale`); storage is `NUMERIC(38,18)`.

## Double-entry model

- A **journal entry** is one business event. It has ≥ 2 **postings**.
- Each posting is a `debit` or `credit` of a positive amount to one account.
- For every entry and every asset: **Σ debits = Σ credits**. Enforced in `postEntry()` and again by a deferred constraint trigger at COMMIT.
- Each account has a **normal balance**. Asset accounts are debit-normal (debits increase them); liability accounts are credit-normal.
- `ledger_accounts.balance` is a cache maintained only by the posting trigger; `ledger_postings.balance_after` is the running balance.
- Entries and postings are **append-only**. Errors are corrected by reversing entries, never edits.

## Chart of accounts (milestone 1)

| Purpose | Category | Normal | Owner | Meaning |
|---|---|---|---|---|
| `platform_sim_custody` | asset | debit | platform | Simulated USDT the platform holds |
| `user_available` | liability | credit | user | Funds owed to the user, free to use |
| `user_invested` | liability | credit | user | User principal locked in fixed-term investments |

Planned separate purposes (each its own account, never commingled): `strategy_allocation`, `strategy_pnl`, `reward_liability`, `treasury`, `fee_revenue`, `exchange_liquidity`, `token_*`.

## Entries

| Event | Debit | Credit |
|---|---|---|
| Simulated deposit | platform_sim_custody | user_available |
| Open investment | user_available | user_invested |
| Investment matures (principal) | user_invested | user_available |

Accounting identity at all times, per asset: **Σ debit-normal balances = Σ credit-normal balances** (custody = Σ user available + Σ user invested).

## Invariants checked by `checkLedgerIntegrity()`
1. Every entry balanced per asset and has ≥ 2 postings.
2. Cached balance = balance re-derived from postings, for every account.
3. Last posting's `balance_after` = cached balance.
4. No non-negative account is negative.
5. Each user's `user_invested` balance = sum of their active investments' principal.
6. Trial balance holds per asset.

Exposed at `GET /api/admin/ledger/integrity` (admin only) and asserted in tests.

## Idempotency
- Client operations: `Idempotency-Key` header bound to (user, operation, request hash); replay returns the stored response; reusing a key with a different body → 422.
- Journal entries: unique deterministic keys, e.g. `simulated_deposit:<user>:<key>`, `investment:<id>:open`, `investment:<id>:mature`.

## Rewards (future, rules fixed now)
- Products carry **no promised rate**.
- Strategy P&L will be recorded in the ledger from simulated strategy results first. Rewards are then allocated pro rata from **realised** P&L into `reward_liability`, and paid to users from there. Losses are recorded truthfully. Platform fees are separate revenue accounts.
- Nothing may credit a user without a balancing debit from an account that actually holds the value.
