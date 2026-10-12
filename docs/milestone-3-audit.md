# Milestone 3 audit: architecture and economic model

**Scope:** milestones 1–3 at commit `4eaaad2`, before this audit. Everything reviewed is
SIMULATED: synthetic market data, paper strategy capital, simulated USDT.

**Method:**
- I read CLAUDE.md, `accounting.md`, `rewards-accounting.md`, all migrations, the ledger,
  engine, pool, calculator and run code, and all tests.
- I traced one complete scenario on a scratch database and recomputed it independently in
  Python from raw rows.
- I wrote a failing test for every suspected defect *before* fixing it, and checked that each
  fails on the pre-fix code.

**Result:** no ledger imbalance, and no asset, profit, claim or liability created without a valid
accounting event, was found in any scenario. Nine defects were found, all fixed with regression
tests. Five economic decisions remain open (section 5).

---

## 1. End-to-end trace (independently verified)

Scenario, reproducible with the script described in section 6:
- **Pool:** strategy `TRACE` with 10,000 paper capital, registered as a pool with capacity 10,000.
  Product `TRACE-30D` is assigned to it.
- **Investors:** Alice deposits 8,000 and invests 6,000. Bob deposits 5,000 and invests 3,000,
  about 0.4 s later.
- **Market:** prices 102 → 110 → 105, so the strategy buys at 102 and sells at 105 (fee 10 bps).
- **Reward run:** calculated and posted for the period from registration to now, then both
  investments mature.

| Step | Entry | Postings | Effect |
|---|---|---|---|
| Deposits | `simulated_deposit` ×2 | Dr custody / Cr user_available | custody 13,000 = customer liabilities |
| Paper capital | `strategy_capital_allocation` | Dr strategy_cash / Cr strategy_capital 10,000 | strategy sub-ledger only |
| Investments | `investment_open` ×2 (+ allocation rows) | Dr user_available / Cr user_invested | principal stays in custody; allocation is a record, not money |
| Buy at 102 | `strategy_trade` | Dr position 4,995.004995, Dr fees 4.995005 / Cr cash | sub-ledger only |
| Sell at 105 | `strategy_trade` | Dr cash 5,136.774989, Dr fees 5.141917 / Cr position 4,995.004995, Cr gain 146.911911 | realised gain booked |
| Reward run posted | `reward_distribution` | strategy half: Dr distributions 82.392864 / Cr cash; customer half: Dr custody 82.392864 / Cr Alice pending 58.428302, Cr Bob pending 15.725274, Cr pool_reserve 8.239288 | each half balances |
| Maturity | `investment_mature` ×2, `reward_release` ×2 | Dr user_invested / Cr user_available; Dr pending / Cr available | principal and rewards released |

Python recomputed every run figure from raw rows (trades, capital postings, allocation timestamps
in µs), and **all matched the app exactly**:

| Figure | Value |
|---|---|
| Net realised R | 136.774989 (G 146.911911, L 0, F 10.136922) |
| Capital integral C | 11,610,000,000 USDT·µs |
| Allocation integral A | 6,993,831,000 |
| Customer share φ | 0.602397158 |
| Customer-attributable N | 82.392864 |
| Eligible E | 82.392864 |
| Reserve contribution Q | 8.239287, + residual 0.000001 = **8.239288** |
| Distributable D | 74.153577 |
| Rewards | Alice 58.428302, Bob 15.725274; Σ 74.153576 (a residual of 1 micro-USDT went to the reserve) |
| Final balances | Alice available 8,058.428302; Bob 5,015.725274; pending 0 for both |
| Custody | 13,082.392864 = Σ customer liabilities + reserve |
| Strategy identity | cash 10,054.382125 = 10,000 + 146.911911 − 10.136922 − 82.392864 ✔ |

All 31 postings balance. Investors 6,000 + 3,000 of 10,000 capital joined after the period
started, so φ ≈ 0.60. Participation is time-weighted, not a snapshot.

---

## 2. Confirmed invariants

Database-enforced (verified by tests that attempt the violation):
- Every journal entry balances per asset, with ≥ 2 postings (deferred constraint).
- Journal, postings, audit log, trades, tick results, strategy events, ticks, instruments,
  allocations, assignments, policies and run sources are append-only.
- Account balances change only through postings, with no overdraft on non-negative accounts.
- Investment terms are immutable, and matured investments are final.
- Reward runs:
  - calculation fields are immutable;
  - status leaves `calculated` only once;
  - a period is posted at most once per pool, and there is one pending run per pool;
  - Σ rewards ≤ distributable;
  - rewards + reserve contribution = eligible profit;
  - **new:** a posted run must reference exactly the ledger entries its figures require.
- A trade feeds at most one posted run.
- A reward line is released at most once, and **new:** only if its run is posted.
- **New:** an allocation equals principal × weight; total weight per investment is ≤ 1; it lies
  within the investment term; and it has the same owner as the investment.
- **New:** no trade, paper-capital change or customer allocation can be committed with a
  timestamp inside an already-posted reward period (SQLSTATE 40001, retried by the app).

Checked by `checkLedgerIntegrity()`, which every financial test asserts is clean:
- cached balance = derived balance = last running balance; trial balance per asset;
- `user_invested` = active principal;
- the strategy sub-ledger identity, positions = trades, ledger P&L and fees = trades, and the
  engine cursor;
- mixed strategy/customer entries only for the two reward types, with each half balanced;
- pending rewards = unreleased posted lines;
- pool reserve = Σ (contributions − applied);
- distributions = Σ (eligible − applied); lines sum to the run total; sources count;
- **new:** no posted reward stranded on a matured investment;
- **new:** no pool trade dated inside a posted period that is missing from its sources;
- **new:** customer-side solvency, `custody = Σ user_available + user_invested + user_reward_pending + pool_reserve`.

Economic properties verified:
- **Realised P&L only.** Unrealised gains never pay out: a test opens a position with a large
  mark-to-market gain, and the run distributes nothing.
- **Time alone pays nothing.** Zero-trade periods produce zero rewards.
- **No double recovery.** Loss carry-forward prevents paying out a recovery of earlier losses; a
  multi-period test plus a 300-period random identity check cover this:
  Σ E = Σ N + CF_final + Σ reserve_applied.
- **Exact rounding.** Rounding always goes against payout, and the residual goes to the reserve,
  so Σ rewards + Q′ = E exactly.
- **Safe failure modes.** Cancelled runs write nothing. Failed posts (reconciliation, insufficient
  cash) write nothing. Interrupted posts roll back and can be retried. Concurrent posts of the
  same run produce exactly one posting.
- **Assignments.** Reassigning a product affects only new investments; existing allocations are
  immutable (now tested deterministically, see D5).

---

## 3. Defects (ranked by severity)

No **critical** defects (ledger imbalance, asset creation, double payment) were found.

| ID | Severity | Defect | Fix |
|---|---|---|---|
| D1 | **High** | Reward payouts looked like trading losses to the risk monitor | Posting shifts the risk baselines, under the strategy lock |
| D5 | **High** | The product's current pool was chosen by text order, so new investments could join a stale pool | Order by the table column; static SQL lint |
| D2 | Medium | Posting a run while an investment matured could strand its reward as pending forever | Lock recipients' investments in posting; sweep and integrity check |
| D3 | Medium | Writes from transactions that started before a period ended could land inside an already-posted period and be excluded from rewards | Strategy lock in posting + DB triggers (40001, auto-retried) + integrity check |
| D4 | Low–Medium | Pool closure was undefined: a pool could close with products still assigned (silently making them uninvestable) or with a pending run | Closure preconditions; closure semantics documented |
| D7 | Low | The DB allowed allocations exceeding principal, or with a mismatched amount (the app never did this) | Claim guard trigger |
| D8 | Low | UI/API mismatches: products behind a paused or closed pool looked investable; the strategy page hid distributions | `accepting` flag, invest button disabled, "Distributed to customers" tile |
| D6 | Low | "Calculate period ending now" sent the browser's clock, so clock skew caused spurious "future period" errors | `periodEnd` optional, defaulting to the DB clock |
| D9 | Low | Admin strategy events were ordered as text, so recent risk breaches could fall outside the 200-row window | Order by the table column |
| DOC | Low | Docs contradicted the code: "no entry mixes strategy and customer accounts", the strategy identity missing distributions, and the capacity wording | Docs corrected (see section 4) |

### D1: Reward payouts triggered false risk breaches (High)
- **Files:** `apps/api/src/rewards/runs.ts` (`postRun`), `apps/api/src/strategy/engine.ts` (risk
  monitor), `apps/api/src/strategy/strategies.ts` (allocations already did this correctly).
- **Cause:** a posting removes `eligible_profit` from `strategy_cash`, and a reserve release adds
  cash back, but `peak_equity`, `day_start_equity` and `last_equity` were not adjusted. Profit
  realised on one simulated day sets the next day's loss baseline. A payout later that day then
  appears as a daily loss of the swept amount, so the strategy is **auto-paused and its position
  force-liquidated**. The same applies to drawdown against the peak.
- **Evidence:** `test/audit-regressions.test.ts` › "D1". With the fix disabled, the strategy ends
  `paused` with `pause_reason` "daily_loss limit breached"; with the fix it stays active.
- **Fix:** `postRun` locks the strategy row and shifts all three baselines by
  −eligible + reserve_applied in the same transaction, exactly as `allocateCapital` does.
  This is now CLAUDE.md rule 21.

### D5: Stale pool assignment chosen by text ordering (High)
- **File:** `apps/api/src/rewards/pools.ts` (`allocateInvestmentToPool`).
- **Cause:** `SELECT id::text, pool_strategy_id ... ORDER BY id DESC LIMIT 1` sorts by the text
  output column. With ids 57 and 100, "57" > "100", so after a reassignment new investments are
  **silently allocated to the previous pool**. This is the same bug class as milestone 2's
  latest-tick bug (CLAUDE.md rule 16).
- **Evidence:** "D5" deterministically forces the boundary (e.g. 57 → 100). It fails on the
  original query and passes on the fix.
- **Fix:** order by `a.id`. The same sweep found D9. `test/sql-lint.test.ts` now statically
  rejects this pattern across `src/`.

### D2: Reward stranded on a matured investment (Medium)
- **Files:** `apps/api/src/rewards/runs.ts`, `apps/api/src/services/investments.ts`.
- **Cause:** `postRun` decided which lines to release by reading `investments.status` without a
  lock. If settlement was in flight, posting saw `active` and released nothing. Settlement's own
  release query saw the run as not yet posted and also released nothing. The reward then stayed
  in `user_reward_pending` with no code path left to release it.
- **Evidence:** "D2" emulates in-flight settlement with a held transaction. On the pre-fix code
  one line stays unreleased.
- **Fix:**
  - `postRun` locks recipients' investments (lock order run → pool → strategy → investments →
    accounts, CLAUDE.md rule 22), so settlement either finishes first or sees the posted run.
  - Defence in depth: the maturity sweep releases any stranded posted rewards, and the
    integrity checker flags them.

### D3: Late writes into a posted period (Medium)
- **Files:** `apps/api/src/rewards/runs.ts`, `apps/api/migrations/0005_audit_fixes.sql`.
- **Cause:** `now()` is the transaction *start* time. A transaction that began before
  `period_end` but committed after the run was posted wrote a trade, a paper-capital change or a
  customer allocation dated inside the closed period. Every later run starts at `period_end`,
  so that P&L or participation was silently never accounted for.
- **Evidence:** "D3" (two tests). A held transaction writes a capital posting and a customer
  allocation after the run is posted. On the pre-fix code both succeed.
- **Fix:**
  - `postRun` takes the strategy row lock, waiting for in-flight ticks and allocations; anything
    dated inside the period is then caught by reconciliation.
  - DB triggers reject any later dated write with SQLSTATE 40001, which `withTransaction`
    retries in a fresh transaction with a later timestamp.
  - The integrity checker flags orphaned trades.

### D4: Pool closure semantics (Low–Medium)
- **File:** `apps/api/src/rewards/pools.ts` (`updatePool`).
- **Cause:** closing was an unconditional status flip. Products still assigned became silently
  uninvestable, and a pending run could be orphaned in the admin flow.
- **Evidence:** "D4" (two tests).
- **Fix:** closing now requires no assigned products and no `calculated` run. A second test shows
  a closed pool still honours its obligations: runs still post and pending rewards release at
  maturity. Semantics are documented in `rewards-accounting.md` §8.
- **Not fixed:** what a closed pool's remaining reserve finally becomes. That's decision E2.

### D6–D9 and DOC (Low)
- **D6:** `apps/web/src/pages/AdminRewards.tsx` and `rewards/runs.ts`. Test "D6".
- **D7:** `migrations/0006_allocation_claim_guard.sql`. Test "D7".
- **D8:** `rewards/pools.ts` (`productPools`), `pages/Invest.tsx`, `pages/AdminStrategy.tsx`. Test "D8".
- **D9:** `strategy/strategies.ts`. Covered by the SQL lint test.
- **DOC:** corrected `accounting.md` (§ chart of accounts, strategy identity, invariants 8–10),
  `security.md`, CLAUDE.md rule 13 and the new rules 20–23, `rewards-accounting.md` (§2 capacity
  wording, new §8–9), `architecture.md` (risk baselines) and README (`periodEnd` optional).

---

## 4. UI, API and documentation consistency (after fixes)

| Surface | Status |
|---|---|
| Dashboard "Rewards pending" | = `user_reward_pending` ledger balance (integrity-checked against posted lines) ✔ |
| Investments "Rewards pending/released" | = posted unreleased / released lines ✔; zero-reward periods labelled "no reward" ✔ |
| Invest page | Shows the backing pool, a variable-reward disclosure, and now pool availability ✔ |
| Strategy page | Net P&L includes distributions; distributions now shown; risk limits unaffected by payouts ✔ |
| Admin rewards console | Calculate uses the server clock ✔; run page shows every formula input ✔ |
| Docs ↔ DB | Mixing rule, identities and closure semantics now match the code ✔ |

Known, accepted limitation: `listInvestments` and the reward statement join one allocation per
investment. The schema allows several (weight ≤ 1 in total), but the app creates exactly one. If
multi-pool splits are ever added, these read models must aggregate.

---

## 5. Unresolved economic and accounting decisions (founder)

| # | Decision | Current behaviour | Options / recommendation |
|---|---|---|---|
| **E1** | **Who bears a pool's loss carry-forward?** | Pool-wide: a later cohort's profits first repay an earlier cohort's loss (characterised in `rewards-calc.test.ts` › E1). Investors joining after a loss get nothing until it is recovered. | (a) Keep pool-wide, and disclose the current CF on the invest page. (b) **Per-allocation CF (recommended)**: each investment carries only the losses it was exposed to, and its CF expires at maturity. This is fairer but changes the economics, so it needs a doc revision and a migration. |
| **E2** | **Reserve at pool closure** | The reserve stays a customer-side liability forever once all allocations end. | (a) Distribute pro rata to the last cohort; (b) distribute to all historical contributors; (c) transfer to a future platform treasury (needs disclosure). Must be decided before any pool is closed in production. |
| **E3** | **Who funds the upside?** | Customers share profits generated by **platform paper capital**; losses are borne by that capital, and customers only see reduced future rewards. Adding paper capital mid-period dilutes φ. | Decide whether this "profit-share on house capital" is the intended product, or whether milestone 4+ moves to deploying customer principal (principal at risk, explicit design and disclosure). |
| **E4** | **Attribution granularity** | Participation is time-weighted per *period*. P&L is attributed when trades are *processed* (wall clock), not when they happened on the synthetic timeline. Large manual market advances realise many simulated days at once. | Short, regular periods (e.g. daily scheduled runs with admin approval) reduce timing effects; per-trade attribution is possible but heavier. |
| **E5** | **Profit locked in open positions** | A run fails with `insufficient_pool_cash` if realised profit has been reinvested. | (a) Keep: retry later. (b) Distribute only available cash and defer the rest (needs a "deferred distributable" concept). (c) Require pools to hold a cash buffer ≥ expected distributions. |
| E6 | Performance fee | None (milestone-3 decision). | Revisit together with E3. |
| E7 | Customer-side reserve vs. platform risk | The reserve only offsets customer-attributable losses; the platform absorbs the real loss on paper capital. | Confirm this split is intended. |

---

## 6. How to reproduce

```bash
npm test                                             # 112 tests; every financial test asserts integrity
cd apps/api && npx vitest run test/audit-regressions.test.ts   # D1–D8 regressions
npx vitest run test/sql-lint.test.ts                 # D5/D9 bug-class guard
```
To see a defect, revert its fix locally and rerun the named test. Each failed on the pre-fix code
during the audit:
- D1 with the baseline update disabled;
- D5 with the original query;
- D2, D3, D4, D7 and the DB guards on commit `4eaaad2`.

The end-to-end trace in section 1 was produced by a throwaway script against a scratch database
(`connect_income_audit`, since dropped). It used the public service functions in the order shown
and dumped raw rows for an independent Python recomputation. Its assertions are covered
permanently by `rewards-flow.test.ts` and `audit-regressions.test.ts`.
