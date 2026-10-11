# Roadmap

## Milestone 1: Core ledger and fixed-term investments ✅
Accounts, dev login, simulated USDT deposits, double-entry ledger, fixed-term investments with maturity, transaction history, integrity checks, tests.

## Milestone 2: Strategy engine (simulated)
- Strategy registry: trader, AI agent, staking and lending strategy types, each with config and risk limits.
- Deterministic simulation runner using seeded market data (historical or synthetic price series, clearly labelled).
- Investment principal is allocated to strategy pools via ledger entries (`user_invested` → `strategy_allocation`).
- Daily mark-to-market and realised P&L posted to `strategy_pnl` accounts.
- AI agents run sandboxed, with no credentials and no withdrawal capability.

## Milestone 3: Rewards
- Pro-rata reward calculation from realised strategy P&L, using exact decimals and a documented rounding policy (round down, with the remainder kept in a tracked rounding account).
- `reward_liability` accrual, then payout at maturity. Losses are reflected truthfully.
- Per-investment performance statements.

## Milestone 4: Admin and risk
- Admin console: users, products (create/pause), ledger explorer, audit log viewer, integrity dashboard.
- Risk engine: exposure limits per strategy and product, concentration limits, kill switches.
- Role-based admin permissions, with four-eyes approval for sensitive actions.

## Milestone 5: Native token (simulated)
- Token asset with fixed supply minted into the treasury via a documented genesis entry. Token issuance is internal ledger only and never on-chain.
- Vesting and allocation tables.

## Milestone 6: Exchange
- TOKEN/USDT spot market with a central limit order book, a matching engine and ledger-settled trades.
- Funds reserved per open order (`user_reserved`).
- Phase 2: an AMM pool (constant product) with explicit, ledger-backed liquidity. A smart router splits orders between the book and the AMM.
- Market data, candles and trade history. No wash trading or fabricated volume.

## Later
- Email verification, password reset, MFA.
- Observability (metrics, tracing) and CI pipeline.
- Containerised deployment.
