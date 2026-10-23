# Deployment

Target: one Linux VPS with 2 vCPU and 4 GB RAM, Docker Engine 24+ and the Compose plugin. Container memory limits add up to about 3.1 GB (postgres 768 MB, backend 1 GB, n8n 1 GB, nginx 128 MB, optional Caddy 128 MB).

Market-data hosting note: Binance returns HTTP 451 to some jurisdictions, including US IPs. The ingestion layer records this as a source error rather than retrying. Pick the VPS region accordingly.

## 1. Configure

```bash
git clone <repo> /opt/tcc && cd /opt/tcc
cp .env.example .env && chmod 600 .env
# Replace every change-me. Generate secrets with: openssl rand -hex 32
```

The backend refuses to start in `staging`/`production` if `SESSION_SECRET` or `SERVICE_TOKEN` is shorter than 32 characters, if `COOKIE_SECURE` is false, if `TELEGRAM_BOT_TOKEN` is set without `TELEGRAM_WEBHOOK_SECRET`, or if `LIVE_TRADING_ENABLED=true`.

## 2. Start

```bash
docker compose up -d --build
docker compose ps                       # all services healthy
curl -s http://127.0.0.1:8080/api/health/ready
```

Migrations run automatically on backend start (`alembic upgrade head`; idempotent). The first admin account comes from `ADMIN_BOOTSTRAP_USER`/`ADMIN_BOOTSTRAP_PASSWORD`, and only if no users exist yet. Change the password afterwards by recreating the user, or add users with the CLI.

If you build behind a TLS-intercepting corporate proxy, pass its CA as a build secret:

```bash
DOCKER_BUILDKIT=1 docker build --secret id=extra_ca,src=/path/proxy-ca.crt -t tcc-backend:local backend
DOCKER_BUILDKIT=1 docker build --secret id=extra_ca,src=/path/proxy-ca.crt -t tcc-frontend:local frontend
docker compose up -d --no-build
```

## 3. HTTPS

The frontend listens on `127.0.0.1:8080` by default. For public HTTPS, which the Telegram webhook requires, either:

- set `DOMAIN=your.domain` in `.env`, point DNS at the VPS and run `docker compose --profile tls up -d` (Caddy obtains certificates automatically), or
- put your own reverse proxy in front of `127.0.0.1:8080` and forward `X-Forwarded-Proto`.

## 4. n8n <a id="n8n"></a>

The n8n editor binds to `127.0.0.1:5678` only. Reach it through an SSH tunnel and never expose it publicly:

```bash
ssh -L 5678:127.0.0.1:5678 user@vps    # then open http://localhost:5678 and create the owner account
```

Import the credential and workflows. The credential file holds your service token, so delete it afterwards:

```bash
sed "s|<SERVICE_TOKEN from .env>|$(grep ^SERVICE_TOKEN= .env | cut -d= -f2)|" n8n/credentials.example.json > /tmp/tcc-cred.json
docker compose cp /tmp/tcc-cred.json n8n:/tmp/tcc-cred.json && shred -u /tmp/tcc-cred.json
docker compose exec n8n n8n import:credentials --input=/tmp/tcc-cred.json
docker compose exec -u root n8n rm -f /tmp/tcc-cred.json
docker compose exec n8n n8n import:workflow --separate --input=/workflows
```

The workflows reference credential id `tccServiceToken1` and error workflow id `tccErrorHandler1`, so they link automatically. Activate them in the editor.

| Workflow | Schedule | Calls |
|---|---|---|
| 00 Error handler | on any workflow error | callback (status=error) and Telegram alert |
| 01 Market data | every 5 min | `/service/ingest` (Binance spot + futures), `/service/paper/mark` |
| 02 Context data | hourly (:07) | `/service/ingest` (CoinGecko, FRED, DefiLlama, Fear & Greed) |
| 03 Debate | 00:05, 04:05 … UTC | `/service/debate` for BTCUSDT and ETHUSDT; the idempotency key is the 4h bucket |
| 04 Backtests | daily 01:30 UTC | `/service/backtest` (backend lock prevents overlap) |
| 05 Health | every 10 min | `/health/deep`, Telegram alert when unhealthy |
| 06 Daily report | 00:00 UTC (07:00 WIB) | `/service/telegram/push` |
| 07 Growth digest | 00:15 UTC | `/service/telegram/push` (`kind=growth`): account and activity **counts only**, no usernames or emails |

### Option: n8n Cloud agent ("Odin")

Instead of the eight self-hosted workflows, the schedule can run from an n8n Cloud **Agent** (Agents column) named **Odin**, which calls one executor workflow, **Odin Backend API**, with a `job` input (`market`, `context`, `debate`, `backtest`, `health`, `report`, `growth`). Unknown jobs are rejected. The workflow's own Error Trigger reports failures to the backend and Telegram.

- n8n Cloud caps executions at 180 s, so the executor starts debates (`wait: false`) and backtests (`"wait": false`, returns 202) in the background. Both stay idempotent and lock-protected in the backend.
- Set `apiBaseUrl` once in the **Odin config** node and attach one credential (`Authorization: Bearer <SERVICE_TOKEN>`) to its HTTP nodes. The backend must be reachable from the internet over HTTPS (Caddy `tls` profile).
- The agent has seven scheduled tasks matching the table above, and a read-only TradingView MCP connection for live market answers in chat. TradingView data is informational only and is not fed into the backend debate snapshot.
- Each scheduled task is one LLM call. With a small model this is roughly 350 calls a day, so keep the agent's monthly budget guardrail on.

To test one workflow from the CLI, use a separate broker port so it doesn't collide with the running instance:

```bash
docker compose exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id tccMarketData001
```

Optional: create an n8n API key (Settings → n8n API), set `N8N_API_KEY` in `.env` and restart the backend. The n8n Control page then also shows workflow activation state and executions from the n8n API.

## 5. Telegram

1. Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (random, 1–256 characters from `A-Za-z0-9_-`) and `TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric IDs).
2. Restart the backend, then register the webhook:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="https://$DOMAIN/api/telegram/webhook" -d secret_token="$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message"]' -d drop_pending_updates=true
```

Without public HTTPS, use long polling instead (and do not set a webhook): `docker compose exec -d backend python -m app.telegram.poller`.

The bot requests are handled by the backend directly rather than through n8n. That keeps the bot token in one place and gives one authorization path. n8n is used for scheduled reports and alerts.

## 6. MEXC (read-only)

Create an API key with **read permission only** and no trading or withdrawal permission, restricted to the VPS IP. Set `MEXC_API_KEY`/`MEXC_API_SECRET`, restart, then use "Sync now" on the MEXC page. If the key turns out to have withdrawal permission, the sync result flags it.

## 7. Backups and recovery

```bash
# daily at 02:15 UTC; 14-day retention; each archive is verified with pg_restore --list
15 2 * * * /opt/tcc/deploy/backup.sh >> /var/log/tcc-backup.log 2>&1
deploy/restore.sh tcc backups/tcc_<stamp>.dump      # interactive confirmation; stops backend and n8n
```

Copy `backups/` off the host (object storage or another server). A backup that exists only on the same disk is not a backup. Also keep a copy of `.env`, which holds `N8N_ENCRYPTION_KEY`; without it, n8n credentials cannot be decrypted.

Recovery behaviour, verified in the build environment by restarting containers:

- **Backend restart:** stateless. Sessions, locks and events live in Postgres, and job locks expire on their own (debate 15 min, backtest 60 min). A debate interrupted mid-run stays `running`; see the readiness report.
- **Postgres restart:** the backend reconnects (`pool_pre_ping`), and n8n retries its own connection.
- **External API outage:** the source is marked `degraded`, then `down` after 3 consecutive failures. Snapshots mark the series stale or missing, and the Risk Engine rejects on stale prices. No stale value is ever substituted silently.
- **n8n outage:** nothing is scheduled. Data ages, the dashboard shows it as stale, and no trades can be proposed on stale data.

## 8. Upgrades

```bash
git pull && docker compose build && docker compose up -d     # migrations run on start
deploy/backup.sh                                             # always back up first
```
