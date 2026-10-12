# Rewards accounting (Milestone 3)

> **Everything here is SIMULATED.** Strategy pools trade synthetic market data with simulated
> paper capital. Customer "allocations" are simulated participation records; no customer
> deposit (all of which are simulated USDT anyway) is invested anywhere. Rewards are
> variable, can be zero for any period, and are never promised. Nothing is paid because
> time passes, only because a pool **realised** a profit that the ledger can trace.

This document was written before the implementation and is the specification the code
follows. Amounts are exact decimals; USDT has 6 decimal places.

---

## 1. The money involved, and where each kind lives

| Concept | Meaning | Ledger account(s) | Owner | Normal |
|---|---|---|---|---|
| **Customer principal** | Simulated USDT a customer locked into a fixed-term investment. Owed back in full at maturity (milestone 1 rule, unchanged). | `user_invested` (liability) | user | credit |
| Asset backing customer money | Simulated USDT the platform holds for customers. | `platform_sim_custody` (asset) | platform | debit |
| **Customer investment claim** | The customer's right to participate in a pool's *future eligible profits* while the investment is active. It is **not** money and has no ledger balance. | `pool_allocations` (records only) | — | — |
| **Strategy capital** | Simulated *paper* capital the platform allocated to a strategy. It is the platform's simulated money. It is **not** a customer asset and never backs customer liabilities. | `strategy_capital` (equity) | strategy | credit |
| Strategy working assets | Strategy cash and the cost basis of open positions. | `strategy_cash`, `strategy_position` (assets) | strategy | debit |
| **Realised strategy P&L** | Gains and losses booked when positions are sold. | `strategy_realised_gain` (revenue), `strategy_realised_loss` (expense) | strategy | credit / debit |
| **Fees** | Simulated venue fees paid by the strategy. | `strategy_fees` (expense) | strategy | debit |
| **Distributions** (new) | Cumulative realised profit swept *out* of a strategy for customers. A contra-equity account. | `strategy_distributions` | strategy | debit |
| **Pool reserve** (new) | Customer-side money withheld from distributions to absorb future customer-attributable losses before the loss carry-forward grows. Rounding residuals also go here. | `pool_reserve` (liability) | pool (strategy id) | credit |
| **Customer reward liability** (new) | Rewards calculated and owed to a customer for a specific investment, not yet released to their available balance. | `user_reward_pending` (liability) | user | credit |
| Customer available balance | Rewards land here when released (at, or after, maturity). | `user_available` (liability) | user | credit |
| **Platform treasury** | Not created in this milestone. Platform equity in this simulation is the paper capital in each strategy. A treasury account arrives with the token milestone. | — | — | — |
| **Loss carry-forward** | Unrecovered customer-attributable losses of a pool. It is an entitlement memo, not money, so it is recorded per reward run (`cf_open`, `cf_close`), not as a ledger balance. | `reward_runs` | — | — |

**Non-negotiables**
1. Paper strategy capital is never treated as customer money. Customer principal never leaves
   `user_invested` and `platform_sim_custody` for a strategy.
2. Only **realised** P&L can become distributable. Unrealised (mark-to-market) gains are never
   distributed and never booked.
3. No entry creates assets. Every reward is paid with cash that actually exists in the pool's
   `strategy_cash`, moved to `platform_sim_custody` in the same entry that creates the customer
   liability.

---

## 2. Mapping customer investments to strategy pools

- A **reward pool** is a strategy (from milestone 2) registered in `reward_pools` with a
  `customer_capacity`: the maximum total customer allocation it accepts.
- A **product is assigned to at most one pool** (recommended model: one pool per product).
  Assignments live in the append-only `product_pool_assignments` table. The latest row for a
  product is the current assignment, and a `NULL` pool means unassigned. Every change is also
  written to `audit_logs`.
- When a customer opens an investment in a product with a pool, the same database transaction
  writes one **allocation** row (`pool_allocations`, append-only, immutable):
  - `weight = 1` (the fraction of the investment allocated; the schema allows future splits);
  - `amount = principal × weight`;
  - `effective_from = investment.start_at`;
  - `effective_to = investment.maturity_at` (fixed term, known in advance).
- **Limits.** The investment is rejected (nothing is posted) unless both of these hold:
  - all allocations that have not yet ended (whatever their start time, so concurrent investments cannot race past capacity) plus the new amount are ≤
    `min(pool.customer_capacity, current strategy_capital balance)`;
  - the pool is `active` and its strategy is not paused.

  Allocations never exceed the investment's own principal, because the weight is ≤ 1.
- Products without a pool behave exactly as in milestone 1: principal only, no rewards.
- Principal accounting and maturity are unchanged. Maturity returns the full principal from
  `user_invested`, and *additionally* releases any posted, unreleased rewards for that investment.

**Customer share of a pool.** Over a period, the customers' share of a pool's results is the
time-weighted ratio of customer allocations to the pool's paper capital (formula below). The
remaining share is the platform's (house) share and simply stays in the strategy.

---

## 3. Reward eligibility formula

A **reward run** covers one pool and one half-open accounting period `[s, e)` in wall-clock
time. Periods are contiguous per pool. `s` is the end of the pool's last posted run, or the
pool's registration time for the first run. `e` is chosen by the admin and must be in the past.
Exactly one policy version applies to a run (`reward_policies`, append-only, versioned).

Let `μs(t)` be time in epoch microseconds (exact integers from PostgreSQL).

1. **Source P&L.** `T` = the pool strategy's trades whose ledger entry was created in `[s, e)`.

   - G = Σ realised_pnl over trades in T with realised_pnl > 0
   - L = Σ |realised_pnl| over trades in T with realised_pnl < 0
   - F = Σ fee over all trades in T
   - **R = G − L − F**  (net realised P&L after fees; unrealised P&L is excluded)

2. **Customer participation.**

   - K(t) = the strategy's paper capital at time t (a step function of capital-allocation entries)
   - C = ∫ₛᵉ K(t) dt  (USDT·μs)
   - For each allocation i active during the period:
     `Aᵢ = amountᵢ × overlap_μs([effective_fromᵢ, effective_toᵢ), [s, e))`
   - A = Σ Aᵢ
   - φ = A / C if C > 0, otherwise 0, capped at 1

3. **Customer-attributable result.** N = ⌊R × φ⌋₆, rounded toward −∞ to 6 decimal places. A
   profit is rounded down and a loss is rounded up in magnitude, so rounding never favours payout.

4. **Loss carry-forward and reserve.** CF₀ is the previous posted run's `cf_close` (0 for the
   first run). V₀ is the current `pool_reserve` balance.

   - **Loss or zero (N ≤ 0):** ℓ = −N.
     - Reserve applied: r = min(V₀, ℓ).
     - CF₁ = CF₀ + ℓ − r.
     - Eligible E = 0. Nothing is distributed.
   - **Profit (N > 0):** recovery = min(N, CF₀).
     - CF₁ = CF₀ − recovery.
     - **Eligible E = N − recovery.**

     The recovered part repays earlier losses and is **never** distributed, so a recovery of
     previously lost capital cannot be paid out twice. It stays in the pool.

5. **Reserve contribution.** With reserve_ratio ρ from the policy (0 ≤ ρ < 1):
   - Q = min(E, ⌈E × ρ⌉₆)
   - **Distributable D = E − Q**

6. **Pro-rata allocation.** Every allocation with Aᵢ > 0 gets a line:
   - weightᵢ = Aᵢ / A
   - rewardᵢ = ⌊D × Aᵢ / A⌋₆, rounded down
   - Σ rewardᵢ ≤ D by construction. This is the **cap**: total rewards can never exceed the
     distributable amount. A database CHECK enforces `total_rewards ≤ distributable` on every run.

7. **Rounding residual.** residual = D − Σ rewardᵢ, with 0 ≤ residual < (number of lines) × 0.000001.
   The residual is **added to the reserve**: total reserve contribution Q′ = Q + residual.
   Therefore **Σ rewardᵢ + Q′ = E exactly**. No value is lost or created by rounding.

8. **Cash check.** The amount swept from the pool, S = Σ rewardᵢ + Q′ = E, must be ≤ the pool's
   `strategy_cash` balance at posting time. Otherwise the run fails with
   `insufficient_pool_cash` and nothing is posted.

**Zero-profit period (R = 0):** N = 0, nothing distributed, CF unchanged, and the run is still
recorded (period closed). **No allocations:** φ = 0, so N = 0. **Time alone never produces a
reward:** with no realised profit, every quantity above is ≤ 0.

---

## 4. Ledger entries

| Event | Entry type | Postings |
|---|---|---|
| Distribution (posting a profitable run, S > 0) | `reward_distribution` | *Strategy side:* Dr `strategy_distributions` S / Cr `strategy_cash` S. *Customer side:* Dr `platform_sim_custody` S / Cr `user_reward_pending` (one posting per recipient with reward > 0) / Cr `pool_reserve` Q′ |
| Reserve applied to a loss (r > 0) | `reward_reserve_release` | *Customer side:* Dr `pool_reserve` r / Cr `platform_sim_custody` r. *Strategy side:* Dr `strategy_cash` r / Cr `strategy_distributions` r |
| Release to customer (investment matured; one entry per run line) | `reward_release` | Dr `user_reward_pending` / Cr `user_available` |

Both cross-ledger entry types are **two independently balanced halves**. The strategy half
balances on its own, and so does the customer half. The integrity checker verifies this, and
rejects any other entry that mixes strategy and non-strategy accounts. The strategy sub-ledger
identity becomes:

```
cash + position cost = capital + realised gains − realised losses − fees − distributions
```

A reserve release returns money to the pool. The released amount is *customer-side* money
absorbing a customer-attributable loss, so customers' future eligibility is protected by that
amount instead of growing the carry-forward.

Strategy metrics report `netPnl = equity + distributions − capital`, so distributions are not
mistaken for losses.

---

## 5. Run lifecycle: calculated, cancelled, failed, interrupted, retried

```
calculate ──▶ calculated ──post──▶ posted        (terminal)
                   │ ├──cancel──▶ cancelled      (terminal; period stays open)
                   │ └──post fails──▶ failed     (terminal; period stays open)
```

- **Calculate** computes everything above and stores the run, its policy version, all inputs
  (G, L, F, R, C, A, φ, N, CF, reserve figures, E, Q, D) and one line per recipient. **No ledger
  entries are written.** At most one `calculated` run may exist per pool (partial unique index).
- **Post** runs in a single DB transaction. It locks the run and the pool, then:
  1. **Recomputes** the calculation from source data. Any difference, such as a late trade
     committed inside the period, is a reconciliation failure.
  2. Checks pool cash.
  3. Writes the ledger entries.
  4. Records the source trades.
  5. Marks the run `posted`.
  6. Releases lines for already-matured investments.

  If any step fails, the transaction rolls back and the run is marked `failed` with the reason
  in a separate statement.
- **Interrupted** (process dies mid-post): the transaction rolls back, so nothing is posted and
  the run is still `calculated`. Posting again is safe.
- **Retried post:** the row lock plus the `status = 'calculated'` check means a second post of
  the same run is rejected (409). The journal idempotency keys (`reward_run:<id>:distribution`,
  `reward_run:<id>:reserve_release`) make a double posting impossible even if application
  checks were bypassed.
- **Cancelled or failed** runs never wrote ledger entries. The period is still open, so the
  admin calculates a fresh run (a new run id) for it.

---

## 6. Invariants that prevent double payment and imbalance

Database-enforced:
- `UNIQUE (pool, period_start) WHERE status = 'posted'`: a period is paid at most once.
- At most one `calculated` run per pool, so concurrent calculations cannot race.
- `reward_run_sources.trade_id` is UNIQUE, so a trade contributes to at most one posted run.
- `reward_run_lines (run_id, allocation_id)` is UNIQUE; lines are immutable, and `released_entry_id`
  can only go from NULL to a value, once.
- Per run: CHECK `total_rewards ≤ distributable`, `total_rewards + reserve_contribution = eligible_profit`,
  and all amounts ≥ 0.
- Journal idempotency keys per run and per (run, line) release; append-only journal, postings,
  allocations, assignments, policies, run lines and sources.
- Allocations, policies and assignments are append-only and immutable.

Checked by `checkLedgerIntegrity()` (and after every test):
1. Each user's `user_reward_pending` = Σ posted, unreleased line rewards for that user.
2. Each pool's `pool_reserve` = Σ posted (reserve_contribution − reserve_applied).
3. Each strategy's `strategy_distributions` = Σ posted (eligible − reserve_applied).
4. For every run, Σ line rewards = `total_rewards`.
5. Cross-ledger entries only for the two reward types, and each half balances.
6. Every rule from milestones 1 and 2, including the trial balance.

---

## 7. What this design deliberately does not do (yet)

- **Principal is never at risk in this milestone.** It is not deployed; customers bear losses
  only as reduced future rewards (carry-forward, reserve). A model where principal is deployed
  into pools and can be impaired needs its own design and the founder's sign-off.
- No performance fee (founder decision for milestone 3). The policy has no fee field; adding
  one needs a new policy version, a fee-revenue account and this document updated.
- The reserve is only ever used to absorb customer-attributable losses. What happens to a
  positive reserve when a pool is closed is a future decision (see the audit).

## 8. Pool closure (added after the milestone-3 audit)

Closing a pool means **closed to new participation**. It does not end any obligation.

- **Preconditions.** No product may still be assigned to the pool, so reassign products first.
  There must be no `calculated` run pending, so post or cancel it first.
- **After closing:**
  - existing allocations keep participating until they end;
  - reward runs can still be calculated and posted;
  - posted rewards are still released at maturity;
  - the `pool_reserve` balance stays a customer-side liability.
- **Not yet defined.** What a closed pool's leftover reserve finally becomes once every
  allocation has ended. This is an open founder decision.

## 9. Period integrity (added after the milestone-3 audit)

- Posting takes the pool and strategy row locks. Any in-flight engine tick or capital allocation
  therefore finishes first, and if it was dated inside the period the reconciliation catches it.
- DB triggers reject any later write dated inside an already-posted period with SQLSTATE
  `40001`: a trade, a `strategy_capital` posting, or a customer allocation. The application
  retries it in a fresh transaction, which dates it into the next open period.
- The integrity checker also flags any pool trade dated inside a posted period that is missing
  from that run's sources.
- **Risk baselines.** Posting shifts the strategy's risk baselines by −(swept) + (reserve
  returned), so distributions never trigger drawdown or daily-loss limits.
- **Period end.** `periodEnd` is optional; it defaults to the database clock.
- No platform treasury yet.
