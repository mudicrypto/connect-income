# Rewards accounting v2: per-investment loss recovery, daily periods, reserve ownership

> **Status:** design addendum to [`rewards-accounting.md`](rewards-accounting.md) (v1), written
> before implementation. Where this document differs from v1, it governs **pools on loss model
> `investment_v2`**. Pools that stay on `pool_v1` keep v1 semantics unchanged (see §7).
>
> Everything remains **SIMULATED**. Paper strategy capital and simulated profits are not customer
> assets and are not withdrawable. Customer principal is never deployed (CLAUDE.md rule 18).
> Rewards are variable, often zero, never promised, and never paid because time passes.

## 1. What changes and what does not

| Area | v1 (milestone 3) | v2 (this milestone) |
|---|---|---|
| Loss carry-forward | One pool-wide balance; later cohorts repay earlier cohorts' losses (audit finding E1) | **One balance per investment (allocation)**: an investor only ever recovers losses from periods they took part in |
| Reserve | One pool-wide balance; ownership undefined; stranded at closure (E2) | **Owned per investment**: absorbs that investment's own later losses; explicit settlement after all its periods are posted |
| Periods | Admin chooses any end time | **Daily UTC** periods (`[00:00Z, next 00:00Z)`) by default; ad hoc kept as an explicit pool setting |
| Unchanged | Realised-P&L-only source; time-weighted participation vs paper capital; floor/ceil rounding against payout; cap; calculate → admin approval → post; reconciliation; ledger entry types; release at maturity; all M1–M3 invariants | |

## 2. Is a high-water mark appropriate?

**Yes, but per investment, not per pool.**

- **Pool-level HWM.** This is equivalent to v1's pool-wide carry-forward. It is rejected because
  investors who joined after a drawdown are charged for it (E1, characterised by a test).
- **Per-investment HWM.** Investment *i* is rewarded only on the part of its cumulative
  attributable result `Sᵢ = Σ nᵢ` that exceeds its previous peak:
  `eligibleᵢ,k = max(0, Sᵢ,k − HWMᵢ,k−1)`, where `HWMᵢ = max(0, max S)`.
  This is the standard "series / equalisation" treatment used for per-investor performance
  accounting.
- **Implementation.** It is implemented as an equivalent **loss-recovery balance**
  `Lᵢ = HWMᵢ − Sᵢ ≥ 0`, which is easier to audit per period.
- **No HWM reset** (yearly, say) is needed. Investments are fixed-term, so `Lᵢ` simply **expires
  at final settlement**. An unrecovered loss is never charged to anyone else, and never becomes
  a payable.

## 3. Formulas (per pool, per closed period `[s, e)`)

Inputs come from the same source as v1:
- R = G − L − F: realised P&L after fees, from trades whose ledger entry is dated in `[s, e)`.
- C = ∫ paper capital dt.
- For each allocation *i* overlapping the period: Aᵢ = amountᵢ × overlap_µsᵢ.
- ρ is the policy reserve ratio.

For each allocation *i*, with its opening balances (L⁰ᵢ, V⁰ᵢ) taken from its **latest posted v2
line**, or (0, 0) if it has none:

1. **Attribution:** `nᵢ = ⌊R × Aᵢ / C⌋₆` (rounded toward −∞; 0 if C = 0). Every nᵢ has the sign of R.
2. **Loss period** (nᵢ ≤ 0), with ℓᵢ = −nᵢ:
   - reserve applied: `rᵢ = min(V⁰ᵢ, ℓᵢ)`
   - loss balance: `L¹ᵢ = L⁰ᵢ + ℓᵢ − rᵢ`
   - reserve: `V¹ᵢ = V⁰ᵢ − rᵢ`
   - eligible: `eᵢ = 0`
3. **Profit period** (nᵢ > 0):
   - recovery: `recᵢ = min(nᵢ, L⁰ᵢ)`
   - loss balance: `L¹ᵢ = L⁰ᵢ − recᵢ`
   - eligible: `eᵢ = nᵢ − recᵢ`
4. **Reserve contribution:** `qᵢ = min(eᵢ, ⌈eᵢ × ρ⌉₆)`, so `V¹ᵢ = V⁰ᵢ + qᵢ`.
5. **Reward:** `rewardᵢ = eᵢ − qᵢ`. This is exact; no further rounding is needed because eᵢ and qᵢ
   are already on 6 dp.

Run-level figures are sums over the run's lines:
- attributable = Σnᵢ
- cf_open = ΣL⁰ᵢ, cf_recovered = Σrecᵢ, cf_close = ΣL¹ᵢ
- reserve_applied = Σrᵢ
- eligible_profit = Σeᵢ
- reserve_contribution = Σqᵢ
- distributable = total_rewards = Σrewardᵢ
- rounding_residual = 0

The attribution remainder R·A/C − Σnᵢ is ≥ 0 for profits. It is **not** customer money: it stays
in the pool (house) and is recorded on the run as `attribution_residual` for transparency. The
whole recovered part Σrecᵢ also stays in the pool, exactly as in v1.

**Identities, which tests check exactly:**
- Σrewardᵢ + Σqᵢ = Σeᵢ = eligible_profit (conservation; the v1 CHECK constraints still hold).
- Per investment, over its life: Σeᵢ = Σnᵢ + L_final + Σrᵢ.
- A new investor's L⁰ is 0, so their first profitable period pays `nᵢ − qᵢ` regardless of pool
  history.

**Worked example** (ρ = 10%, paper capital 10,000 per unit of time, computed independently in
Python and mirrored by a test):

| Period | R | Alice (5,000) | Bob (5,000, joins in P2) | v1 for comparison |
|---|---|---|---|---|
| P1 | −200 | n −100 → L 100 | — | CF 100 |
| P2 | +300 | n 150, recovers 100, e 50, q 5, **reward 45**, L 0, V 5 | n 150, e 150, q 15, **reward 135**, V 15 | both get **90**: Bob subsidises Alice's recovery |
| P3 | −100 | n −50, reserve applied 5 → L 45, V 0 | n −50, reserve applied 15 → L 35, V 0 | — |

## 4. Ledger mapping

There are no new account purposes, and v1's entry types are unchanged:
- **`reward_distribution`:** strategy half Dr distributions / Cr cash (Σeᵢ); customer half Dr custody
  (Σeᵢ) / Cr each `user_reward_pending` (rewardᵢ) / Cr `pool_reserve` (Σqᵢ).
- **`reward_reserve_release`:** Σrᵢ goes back to the pool exactly as in v1.

**New entry type `reserve_settlement`** (customer side only): Dr `pool_reserve` Vᵢ / Cr
`user_available` Vᵢ. Both accounts are customer liabilities, so custody is unchanged and solvency
is preserved.

Per-investment loss and reserve balances are **memos on the run lines**, not new ledger accounts.
The ledger keeps one `pool_reserve` account per pool, and the integrity checker reconciles it:

```
pool_reserve = Σ posted (reserve_contribution − reserve_applied) − Σ settled reserve
             = Σ over investments of their latest reserve_close (v2 lines) + legacy v1 reserve
```

## 5. Reserve ownership and settlement states

The reserve withheld from investment *i*'s profit (Vᵢ) **belongs to investment i's owner**, and is
first used to absorb that investment's own later losses. Each allocation moves through these
states:

```
participating ──(maturity passed AND every period overlapping it is posted)──▶ settleable
settleable ──(admin-approved settlement, after reconciliation)──▶ settled
```

- **participating:** the allocation's term is still running, or a period overlapping it has not
  yet been posted.
- **settleable:** all of the following hold:
  - the investment has matured;
  - the pool's last posted period end ≥ the allocation's `effective_to`;
  - no reward run is pending for the pool;
  - all posted rewards of the investment have been released.
- **settled:** recorded once per allocation in the append-only `reserve_settlements` table, with
  `reserve_released = V_final` and `loss_expired = L_final`, plus the ledger entry when
  V_final > 0.

Settlement is an **explicit admin action**, never automatic and never triggered by closure. It
runs in one transaction under the pool lock (the same lock order as posting) and first checks:
- that the ledger `pool_reserve` balance equals the sum of all memo balances plus any legacy
  reserve;
- that the investor's pending rewards equal their unreleased lines.

It aborts on any mismatch.

**Pool states** (derived and displayed):
- **open:** accepting participation.
- **closed (settling):** not accepting participation, but some obligation is outstanding: a
  pending run, an unsettled allocation, unreleased rewards, or a reserve > 0.
- **closed (settled):** no outstanding obligations.

**Closing a pool releases nothing.** The audit's closure preconditions still apply: no assigned
products and no pending run.

## 6. Daily UTC periods

- Each pool has a `period_mode`: `daily_utc` (the default for new pools) or `ad_hoc`.
- In `daily_utc` mode, the next period is `[s, date_trunc('day', s at UTC) + 1 day)`, where s is
  the last posted end (or the pool's `rewards_start_at`). The first period after a pool starts, or
  after switching modes, may therefore be a shorter **stub** that aligns to midnight. After that,
  every period is one full UTC day.
- A period can only be calculated once it is **closed** (`end ≤ now()`). The calculation reads
  only rows dated inside it, so recalculating a closed period gives the same figures. Posting
  re-verifies this, and the D3 triggers prevent later writes into a posted period.
- **Approval stays manual.** There is no scheduler that posts. The admin console lists the next
  closed period per pool and offers *Calculate next period*; posting stays a separate,
  explicit approval. A backlog of days is processed one day at a time, in order.

## 7. Migration and backward compatibility

Migration `0007` is forward-only and **rewrites no historical row**:
- Existing `reward_runs` and `reward_run_lines` keep their values and get `loss_model = 'pool_v1'`.
  New columns are nullable, or default to v1-neutral values.
- **Each pool is classified:**
  - **Switched automatically to `investment_v2`** if its legacy pool-level balances are both
    zero: latest posted `cf_close` = 0 and `pool_reserve` balance = 0. There is nothing to
    attribute, so the switch changes no entitlement.
  - **Otherwise it stays on `pool_v1`**, flagged `transition_required`. This is the
    *ambiguous* case: a pool-wide carry-forward or reserve cannot be uniquely assigned to
    individual investments. **No balance is moved or reinterpreted.** The pool keeps working
    exactly as before until the founder chooses one of the options below.
- All existing pools keep `period_mode = 'ad_hoc'`, which is their current behaviour. New pools
  default to `daily_utc`, and the mode can be switched by an admin (audited).
- New pools always start on `investment_v2`.

**Options for `transition_required` pools:**

| Option | Effect | Trade-off |
|---|---|---|
| A. Attribute to the responsible investment(s) | Charge the legacy CF to the allocation(s) that participated in the v1 runs that created it | Exact when one investment is responsible; anything else is ambiguous and aborts |
| B. Expire legacy CF, keep legacy reserve pool-level | New model starts at L = 0; the legacy reserve stays a separate, frozen customer liability awaiting its own decision | Investors who had losses under v1 are no longer charged for them; simple |
| C. Let it run off | Stay on v1 until the legacy CF and reserve reach 0 naturally, then switch automatically | No reinterpretation at all; the unfairness persists until then |

### 7.1 Option A (founder decision 2026-10-12, implemented in migration `0008`)

The runbook is `docs/runbooks/legacy-pool-transition.md`; the code is `src/rewards/legacy-transition.ts`.

- **Scope.** Applies only when the pool's v1 reserve is 0. Under v1, a positive CF and a
  positive reserve cannot coexist, because the reserve absorbs losses before the CF grows and
  contributions resume only once CF = 0. A pool with a reserve therefore has no CF to attribute,
  and its reserve stays a separate decision.
- **Formula** (exact; no rounding, because the whole amount moves):
  - `CF` = `cf_close` of the last posted `pool_v1` run.
  - The run chain must be continuous: `cf_open(1) = 0` and `cf_open(k) = cf_close(k−1)`.
  - Every stored v1 run must recompute to its recorded figures.
  - **Responsible** = the allocations with weighted participation > 0 in the posted v1 runs that
    changed the CF.
  - If exactly one allocation is responsible, it receives `loss_amount = CF`. Otherwise the
    transition **aborts** (`ambiguous_attribution`). Nothing is pro-rated or guessed, and
    investors who joined later are never charged.
- **Effect on v2.** The first v2 line of the responsible allocation opens at
  `loss_open = loss_amount`, and every other allocation opens at 0. The v2 chain check, the
  settlement check (`loss_expired`) and the settlement view all use the transition amount as the
  opening balance until a v2 line exists.
- **Records.** The transition is recorded forward-only in `legacy_loss_transitions` and
  `legacy_loss_transition_lines`, both append-only. The record holds the source run, source CF,
  source reserve (= 0), formula, evidence JSON, history digest, approval reference, approving
  admin and timestamp. An audit row `pool.legacy_transition` is written without credentials.
  **No ledger entry is posted** (the CF is a memo), and no historical run, line or posting
  changes. A digest is compared inside the transaction to prove this.
- **Invariants.**
  - *Database:* deferred commit-time triggers enforce the following. Σ lines = source CF =
    the source run's `cf_close`, and that run is the last posted v1 run. The ledger reserve = 0.
    Each line matches its allocation, investment and user. The pool is now `investment_v2`. No
    v2 run predates the transition. `UNIQUE(pool)` and `UNIQUE(key)` make it run once.
  - *Integrity checker:* re-verifies the reconciliation.
  - *Idempotency:* the transition key doubles as the HTTP `Idempotency-Key`. Replaying the same
    key returns the stored record, and a different key is refused.

In the current dev database, `MOMO-BTC` has a legacy CF of **15.174414**. It comes from a single
posted v1 run (`2b8860bf…`) whose only participant was allocation `fc433842…` (investment
`2373327b…`), and its reserve is 0. That evidence was verified independently against raw ledger
postings and rehearsed on a clone. **By founder decision, the transition has not been applied to
dev**: the pool stays `pool_v1`/`transition_required` until the runbook is executed there.

## 8. Concurrency and idempotency

These are unchanged from v1 plus the audit fixes:
- one pending run per pool;
- period chain checked on post;
- lock order run → pool → strategy → investments → accounts;
- per-run journal keys.

**Settlement** follows the same locking:
- it takes the pool lock, then the investments, then the accounts;
- it uses the journal key `reserve_settlement:<allocation_id>`;
- `UNIQUE(allocation_id)` on `reserve_settlements` blocks double settlement;
- the HTTP route requires an `Idempotency-Key`.

Per-investment opening balances come from the latest **posted** line, under the pool lock. Two
runs can therefore never both start from the same balances: there is at most one pending run, and
posting re-verifies the figures.
