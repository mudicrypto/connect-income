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

## Future AI agents / strategies
- Run with a separate DB role and service API that can only post strategy P&L entries to strategy accounts.
- No access to user tables, sessions, password hashes or withdrawal flows.
- All actions are audited; limits come from the risk engine.

## Secrets
`.env` is gitignored. Use `.env.example` as the template. Rotate anything that is accidentally committed.

## Known gaps (to address before any non-local deployment)
- No email verification, password reset or MFA.
- No account lockout beyond IP rate limiting.
- No CSP/security headers (add `@fastify/helmet` when serving the built UI from the API).
- Rate limiter is in-memory (single instance only).
