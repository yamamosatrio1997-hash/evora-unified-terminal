# AI Trading Command Center (Evora Unified Terminal)

A multi-agent research system for crypto markets, running in **research and paper-trading mode**. Nine specialist agents analyze one shared, hashed data snapshot and debate over eight auditable rounds. A deterministic Risk Engine holds a 3% planned-risk ceiling and an independent veto. Decisions turn into **simulated** orders only. Live order execution is disabled and cannot be switched on by configuration.

```
DATA SOURCES -> VALIDATION -> SPECIALIZED AGENTS -> DEBATE -> QUANT VALIDATION -> RISK ENGINE -> FUND MANAGER -> PAPER TRADING
```

| Component | Technology | Location |
|---|---|---|
| Backend API, agents, quant, risk, paper engine | Python 3.12, FastAPI, SQLAlchemy 2, Alembic | `backend/` |
| Database | PostgreSQL 17 (append-only audit and risk tables) | `backend/alembic/` |
| Orchestration | n8n 2.44.6 (7 importable workflows) | `n8n/workflows/` |
| Dashboard | React 18, TypeScript, Framer Motion, React Flow, Lightweight Charts | `frontend/` |
| Telegram AI Fund Manager | Bot API webhook or long polling, Indonesian by default | `backend/app/telegram/` |
| MEXC | Read-only client; execution adapter refuses submission | `backend/app/exchange/` |
| Deployment | Docker Compose, nginx, optional Caddy TLS | `docker-compose.yml`, `deploy/` |

## Quick start (local)

```bash
cp .env.example .env            # fill in every "change-me" (openssl rand -hex 32)
docker compose up -d --build
open http://127.0.0.1:8080      # log in with ADMIN_BOOTSTRAP_USER / ADMIN_BOOTSTRAP_PASSWORD
```

Then import the n8n workflows and credential as described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#n8n).

To see the UI with data before real ingestion works, seed **clearly labelled synthetic data**:

```bash
docker compose exec backend python -m app.cli seed-simulated
docker compose exec backend python -m app.cli debate BTCUSDT
```

Anything derived from synthetic data shows a SIMULATED badge, and the decision gate forces it to NO TRADE.

## Development

```bash
cd backend && uv venv && uv pip install -r requirements-dev.txt
DATABASE_URL=postgresql+psycopg://tcc:tcc@localhost:5432/tcc_test pytest -q
cd frontend && npm ci && npm run dev    # proxies /api to localhost:8000
```

## How a decision is made

1. **Snapshot.** Candles plus every metric, each with its source, observation time and retrieval time, are frozen and SHA-256 hashed. Every agent cites only ids in that snapshot; schema validation rejects any "fact" without a valid citation.
2. **Round 1.** Macro, Fundamental, On-Chain, Flow and Technical agents analyze independently. Each computes deterministic facts first. If an LLM is configured, it may add interpretation, but claims with invalid citations are dropped.
3. **Rounds 2–4.** Evidence exchange, then targeted challenges from the Critical Reviewer with a specific reply to each, then a cross-domain synthesis that records disagreement.
4. **Round 5.** The Quant Researcher backtests the matching rule family on point-in-time data. The run uses an in-sample/validation/out-of-sample split, 4-fold walk-forward, a Monte Carlo bootstrap and a parameter-sensitivity check.
5. **Round 6.** The Risk Engine (pure `Decimal` arithmetic) sizes the trade or vetoes it. The record is immutable and hashed.
6. **Round 7.** The Fund Manager's **deterministic gate** decides LONG / SHORT / WATCHLIST / WAIT FOR CONFIRMATION / REJECT / NO TRADE. The gates are: real data, a defined setup, risk approval, fresh data, a supported out-of-sample edge, no blocking critique, and fewer than two contradicting context agents. Dissent is recorded and stances are not counted as votes. The LLM can only phrase the rationale.
7. **Round 8.** Audit and persistence: prompt versions, model, token use, cost and snapshot hash.

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): VPS setup, n8n import, Telegram, backups, recovery
- [docs/SECURITY.md](docs/SECURITY.md): security checklist and threat notes
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md): endpoints, keys, limits and verification status
- [docs/LIVE_TRADING_GATES.md](docs/LIVE_TRADING_GATES.md): what must be true before live trading is even considered
- [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md): test results, limitations, costs, open risks

## Important limitations

- No performance figures are claimed. The research goals (win rate > 70%, profit factor > 3, max drawdown < 10%) are reported as measured, with sample size, and nothing is tuned to meet them.
- The external market, exchange and Telegram APIs were **not reachable from the build environment**. Their adapters follow the published contracts and are tested against recorded-shape fixtures, but they still need verification on a host with network access (see the readiness report).
- Planned risk is an estimate. Realized losses can exceed it because of gaps, slippage, liquidation, outages or execution failures.
