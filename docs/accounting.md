# Financial accounting

All amounts are exact decimals. USDT uses 6 decimal places (`assets.scale`); storage is `NUMERIC(38,18)`.

## Double-entry model

- A **journal entry** is one business event. It has ≥ 2 **postings**.
- Each posting is a `debit` or `credit` of a positive amount to one account.
- For every entry and every asset: **Σ debits = Σ credits**. Enforced in `postEntry()` and again by a deferred constraint trigger at COMMIT.
- Each account has a **normal balance**. Asset accounts are debit-normal (debits increase them); liability accounts are credit-normal.
- `ledger_accounts.balance` is a cache maintained only by the posting trigger; `ledger_postings.balance_after` is the running balance.
- Entries and postings are **append-only**. Errors are corrected by reversing entries, never edits.

## Chart of accounts

| Purpose | Category | Normal | Owner | Meaning |
|---|---|---|---|---|
| `platform_sim_custody` | asset | debit | platform | Simulated USDT the platform holds |
| `user_available` | liability | credit | user | Funds owed to the user, free to use |
| `user_invested` | liability | credit | user | User principal locked in fixed-term investments |
| `strategy_capital` | equity | credit | strategy | Simulated **paper capital** allocated to the strategy |
| `strategy_cash` | asset | debit | strategy | The strategy's uninvested simulated cash |
| `strategy_position` | asset | debit | strategy | Cost basis of the strategy's open simulated positions |
| `strategy_realised_gain` | revenue | credit | strategy | Realised simulated trading gains |
| `strategy_realised_loss` | expense | debit | strategy | Realised simulated trading losses |
| `strategy_fees` | expense | debit | strategy | Simulated venue fees paid |

Each strategy owns its own six accounts (`owner_strategy_id`), forming a **self-contained sub-ledger**. No journal entry may mix strategy accounts with non-strategy accounts. The integrity checker verifies this.

Planned separate purposes (each its own account, never commingled): `reward_liability`, `treasury`, `fee_revenue`, `exchange_liquidity`, `token_*`.

## Entries

| Event | Debit | Credit |
|---|---|---|
| Simulated deposit | platform_sim_custody | user_available |
| Open investment | user_available | user_invested |
| Investment matures (principal) | user_invested | user_available |

| Strategy capital allocation | strategy_cash | strategy_capital |
| Simulated buy (notional N, fee F) | strategy_position N; strategy_fees F | strategy_cash N+F |
| Simulated sell, gain (notional N, fee F, cost released C, N > C) | strategy_cash N−F; strategy_fees F | strategy_position C; strategy_realised_gain N−C |
| Simulated sell, loss (N < C) | strategy_cash N−F; strategy_fees F; strategy_realised_loss C−N | strategy_position C |
| Risk liquidation | same as a sell (trade `reason = risk_liquidation`) | |
| Mark-to-market (unrealised P&L) | **no entry** (computed, never booked) | |
| Pause / resume / kill switch / clipped or rejected order | **no entry** (recorded in `strategy_events`) | |

Accounting identity at all times, per asset: **Σ debit-normal balances = Σ credit-normal balances** (custody = Σ user available + Σ user invested).

### Strategy sub-ledger identity
For every strategy: **cash + position cost = capital + realised gains − realised losses − fees**.
Equity (shown in the dashboard) = cash + position quantity × last synthetic price (rounded down).
Net P&L = equity − capital = realised P&L − fees + unrealised P&L.

### Why strategy capital is paper capital
Strategy capital comes from a per-strategy equity account labelled *simulated paper capital*. It is **not** sourced from `platform_sim_custody` (which backs customer liabilities) or from `user_invested` (customer principal). A strategy profit therefore never changes any customer balance. Milestone 3 must define, through a reviewed design and migration, how (and whether) investment principal is allocated to strategy pools. Any such allocation will use its own accounts.

### Trade rounding policy (always against the strategy)
Buy price rounds up and sell price rounds down. Quantities round down, buy notional rounds up and sell notional rounds down. Fees round up. Position valuation rounds down. Partial-sell cost basis rounds up. A full close releases the exact remaining cost basis.

Fees are expensed (`strategy_fees`), not capitalised into cost basis. Slippage is embedded in the execution price, so it shows up in cost basis or proceeds. It is also reported per trade as `slippage_cost` for transparency.

## Invariants checked by `checkLedgerIntegrity()`
1. Every entry balanced per asset and has ≥ 2 postings.
2. Cached balance = balance re-derived from postings, for every account.
3. Last posting's `balance_after` = cached balance.
4. No non-negative account is negative.
5. Each user's `user_invested` balance = sum of their active investments' principal.
6. Trial balance holds per asset.
7. Per strategy: ledger position cost = `strategy_positions.cost_basis`; position quantity = net traded quantity; ledger realised P&L = Σ trade `realised_pnl`; ledger fees = Σ trade fees; the sub-ledger balances; the cursor equals the last tick result.
8. No journal entry mixes strategy and non-strategy accounts.

Exposed at `GET /api/admin/ledger/integrity` (admin only) and asserted in tests.

## Idempotency
- Client operations: `Idempotency-Key` header bound to (user, operation, request hash); replay returns the stored response; reusing a key with a different body → 422.
- Journal entries: unique deterministic keys, e.g. `simulated_deposit:<user>:<key>`, `investment:<id>:open`, `investment:<id>:mature`, `strategy_capital:<strategy>:<key>`, `strategy_trade:<strategy>:<tick>:<n>`.
- Strategy processing: `UNIQUE(strategy_id, tick_id)` on `strategy_tick_results` plus the cursor guarantee each market tick is processed at most once per strategy.

## Rewards

**Implemented in milestone 3. The authoritative specification is [`rewards-accounting.md`](rewards-accounting.md).** It covers the account purposes `strategy_distributions`, `pool_reserve` and `user_reward_pending`, the formulas, and the entries for distribution, reserve release and release at maturity. The original rules below still hold.
- Products carry **no promised rate**.
- Strategy P&L is now recorded in each strategy's sub-ledger (milestone 2). Rewards are then allocated pro rata from **realised** P&L into `reward_liability`, and paid to users from there. Losses are recorded truthfully. Platform fees are separate revenue accounts.
- Nothing may credit a user without a balancing debit from an account that actually holds the value.
