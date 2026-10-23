# Security checklist

Status legend: ✅ implemented and tested · ☑️ implemented, not covered by an automated test · ⚠️ operator action required

## Secrets
- ✅ All secrets come from server-side environment variables. `.env` is git-ignored, and a test scans tracked files for secret patterns (`tests/test_repo_secrets.py`).
- ✅ Secrets are redacted from logs, audit details, Telegram replies and stored exchange errors (`app/core/redact.py`). Tests confirm the MEXC secret and the Telegram token never appear in responses or logs.
- ✅ `/api/settings` only reports whether each secret is configured, never its value.
- ✅ The n8n API key, MEXC keys, bot token and LLM key are never sent to the browser or included in agent prompts.
- ⚠️ Use read-only, IP-restricted MEXC keys without withdrawal permission.
- ⚠️ Keep `.env` at `chmod 600` and back up `N8N_ENCRYPTION_KEY` separately.

## Authentication and access
- ✅ Server-side sessions: random 256-bit token stored as a SHA-256 hash, in an HttpOnly, Secure, SameSite=Strict cookie with a 12-hour TTL. Logout destroys the server-side session (tested by replaying the old cookie).
- ✅ CSRF: every state-changing request needs the `X-Requested-With: tcc` header in addition to the SameSite cookie.
- ✅ Roles: `viewer` < `operator` < `admin`. Operators can engage the emergency stop; only admins can release it, edit agent settings or read the audit log.
- ✅ Passwords use scrypt (N=2^14, r=8, p=1) with a minimum length of 12. Login is rate-limited (10 attempts per 5 minutes per username).
- ✅ n8n-to-backend calls use a bearer service token compared in constant time.
- ✅ Telegram: allowlist checked **before** any data access (tested with a handler that fails if it runs); webhook secret header verified in constant time; per-user rate limit; deduplication on `update_id`; context keyed by user id.
- ⚠️ The in-process rate limiters are per worker (2 workers means the effective limit is up to 2x). Move them to Postgres or Redis if you scale out.

## Trading safety
- ✅ `LIVE_TRADING_ENABLED=true` aborts startup. `execution.submit()` always raises and audits the attempt. `LIVE_EXECUTION_IMPLEMENTED = False` is a code constant, not configuration.
- ✅ The paper engine imports no exchange or HTTP client (enforced by a test). An order needs an approved RiskDecision whose hash verifies, that is under 15 minutes old, and whose price has drifted less than 0.5%.
- ✅ The Risk Engine ceiling cannot be configured above 3%. The Fund Manager gate cannot override a veto (tested with every other agent bullish).
- ✅ Chat messages asking to buy, sell, or change limits are refused, and no handler for those actions exists.

## Data integrity and audit
- ✅ `audit_logs` and `risk_decisions` are append-only (a Postgres trigger rejects UPDATE and DELETE). The audit log is hash-chained, and `/api/audit/verify` checks the chain.
- ✅ Agent outputs are schema-validated, and citations must exist in the shared snapshot.

## Transport and headers
- ✅ API responses set CSP `default-src 'none'`, X-Frame-Options DENY, nosniff, no-referrer, a restrictive Permissions-Policy and `Cache-Control: no-store`, plus HSTS when `COOKIE_SECURE`.
- ✅ The SPA (nginx) sets CSP `script-src 'self'` with no inline scripts. Inline styles are allowed because React Flow and Framer Motion use style attributes.
- ✅ Postgres sits on an `internal: true` Docker network. The n8n editor binds to 127.0.0.1. The OpenAPI docs are disabled in production.
- ⚠️ TLS: use the `tls` compose profile or your own proxy. Do not expose port 8080 publicly over plain HTTP.

## Not done (known gaps)
- No MFA or SSO; consider putting the dashboard behind a VPN or an identity-aware proxy.
- No automated dependency vulnerability scanning in CI (add `pip-audit` / `npm audit` once network policy allows).
- No penetration test has been performed.
