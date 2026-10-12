# Security

## Scope
Simulation only. No real funds, private keys, exchange API keys or mainnet contracts. Adding any of these needs an explicit founder decision and a security review.

## Authentication
- Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt), constant-time compare. Unknown emails are checked against a dummy hash to limit user enumeration by timing.
- Sessions: 32-byte random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` when `COOKIE_SECURE=true`); only SHA-256 of the token is stored. Logout revokes server-side. 7-day expiry.
- Dev login (`/api/auth/dev-login`) exists only when `DEV_MODE=true` and returns 404 otherwise. Never enable DEV_MODE in production.
- Seeded dev admin password is generated at seed time and printed once; it is never committed.

## Authorization
- User identity always comes from the session; clients never pass a userId.
- Admin routes require `role = 'admin'`.
- Tests cover unauthenticated access, cross-user isolation, and admin-only routes.

## Request hardening
- JSON-only bodies (`text/plain` parser removed) plus SameSite=Strict, which together block CSRF.
- 64 KB body limit; rate limits on auth (20/min) and financial endpoints (60/min).
- Amounts must be decimal strings matching a strict regex and respect asset scale. Floats are rejected.
- Errors return a stable `{error:{code,message}}`; internal errors are logged, not leaked.

## Data integrity
- Ledger, journal and audit log are append-only (DB triggers block UPDATE/DELETE/TRUNCATE).
- Balance cache can only change through postings; overdrafts are blocked by a CHECK constraint.
- Investment terms are immutable; matured investments are final.

## Strategy engine (milestone 2)
- All strategy endpoints live under `/api/admin/*`. A plugin-level `preHandler` requires the admin role, so every route returns 401 or 403 otherwise. The tests check every route for both cases.
- Every strategy-management action is written to `audit_logs`: create, pause, resume, allocate, kill switch, market advance and engine run. Engine and risk events go to the append-only `strategy_events` table.
- Strategy logic is pure code. It receives only prices and its own position state, and has no handle to users, sessions, credentials or customer accounts. The engine can only post entries between a strategy's own accounts. The integrity check flags any entry that mixes strategy and non-strategy accounts.
- Market data is synthetic only. The DB rejects instrument symbols without the `SIM-` prefix and `is_simulated = false`. There are no exchange connectors or credentials anywhere in the codebase.
- Risk limits are enforced on the server inside the tick transaction. The UI only displays them.
- Server-side validation of strategy parameters is strict (unknown keys rejected); amounts must be decimal strings.

## Future AI agents
- AI agent strategies will plug in as decision rules with the same interface as `strategy/logic.ts`: they receive market data and their own state and return a desired position. They never call the ledger or the database directly.
- They will run in a separate process or worker with its own DB role, which can only write through the engine's service API.
- They will have no access to user tables, sessions, password hashes or withdrawal flows. All their actions will be audited, and limits come from the risk engine.

## Secrets
`.env` is gitignored. Use `.env.example` as the template. Rotate anything that is accidentally committed.

## Known gaps (to address before any non-local deployment)
- No email verification, password reset or MFA.
- No account lockout beyond IP rate limiting.
- No CSP/security headers (add `@fastify/helmet` when serving the built UI from the API).
- Rate limiter is in-memory (single instance only).
- The strategy engine runs inside the API process with the same DB role. A dedicated least-privilege role is planned.
- Admin actions are single-approver. Four-eyes approval for kill-switch release and large allocations is planned.
