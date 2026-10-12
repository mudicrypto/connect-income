# Roadmap

## Milestone 1: Core ledger and fixed-term investments ✅
Accounts, dev login, simulated USDT deposits, double-entry ledger, fixed-term investments with maturity, transaction history, integrity checks, tests.

## Milestone 2: Simulated strategy and performance engine ✅
- Strategies of type trading, staking and lending, with configurable limits and parameters. Admin can create, inspect, pause and resume them.
- Deterministic synthetic market data (`SIM-*` instruments) and a paper-trading engine with fees, slippage, and realised and unrealised P&L.
- Per-strategy sub-ledger: paper capital, cash, position cost, realised gain and loss, and fees.
- Idempotent, concurrency-safe, crash-recoverable tick processing.
- Risk controls: allocation, position, exposure, daily loss and drawdown limits; auto-pause with liquidation; global kill switch.
- Admin strategy dashboard with trade history, events and an equity chart.

Deferred from milestone 2:
- AI-agent strategy type (the decision-rule interface is ready).
- Withdrawing or reducing strategy capital.
- Editing limits on an existing strategy.
- Force-reducing positions when price drift pushes them over the position or exposure limit.
- A separate engine worker process with its own DB role.

## Milestone 3: Linking investments to strategies, and rewards
- Decide and document how fixed-term principal funds strategy pools. Each pool gets its own accounts and allocation entries, keeping customer principal separate from paper capital.
- Pro-rata reward calculation from realised strategy P&L, using exact decimals and a documented rounding policy (round down, with the remainder kept in a tracked rounding account).
- `reward_liability` accrual, then payout at maturity. Losses are reflected truthfully.
- Per-investment performance statements.

## Milestone 4: Admin and risk
- Admin console: users, products (create/pause), ledger explorer, audit log viewer, integrity dashboard.
- Risk engine extensions: concentration limits across strategies, per-product limits, and four-eyes approval for kill-switch release.
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
