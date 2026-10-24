# Evora Unified Terminal: project index

A multi-agent crypto research system running in **research and paper-trading mode**: nine agents, an 8-round debate, a deterministic risk engine, and paper trading only. Start with README.md; status and gaps are in docs/PRODUCTION_READINESS.md.

## Invariants (never break these)

- Live trading stays disabled. `LIVE_TRADING_ENABLED=true` must abort startup (`backend/app/config.py`). `LIVE_EXECUTION_IMPLEMENTED = False` is a code constant (`backend/app/exchange/execution.py`), and `submit()` always raises.
- The max planned risk per trade is ≤ 3%, enforced in config validation and in `backend/app/risk/engine.py` (Decimal maths). An LLM must never size, override a veto, or submit orders.
- The Fund Manager is a deterministic gate sequence, not a vote (`backend/app/agents/fund_manager.py`). An LLM may only phrase the rationale.
- Every agent "fact" must cite an id from the debate's hashed snapshot (`backend/app/agents/schemas.py`, `backend/app/data/snapshot.py`).
- `audit_logs` and `risk_decisions` are append-only (DB trigger), and the audit log is hash-chained.
- No secrets in the frontend, logs, prompts, or Telegram (`backend/app/core/redact.py`). Non-admin API responses are redacted server-side (`backend/app/api/routes.py`).
- Never fabricate data, metrics, or performance claims. Synthetic data must stay labelled SIMULATED, and the homepage animation must stay labelled ILUSTRASI.
- UI motion tied to agent work must come from real backend events (SSE). Only decor may animate on its own.
- The reference repos in docs/COMPARISON.md are for ideas only. Copy no code (freqtrade is GPL, Fincept is AGPL, AI-Trader has no licence).

## Pipeline

DATA SOURCES → VALIDATION → AGENTS → DEBATE → QUANT VALIDATION → RISK ENGINE → FUND MANAGER → PAPER TRADING

## Backend (`backend/app/`, Python 3.12, FastAPI, SQLAlchemy 2 sync, Alembic, Postgres 17)

| Path | Role |
|---|---|
| `main.py`, `config.py`, `cli.py` | App startup (migrations, admin bootstrap, orphaned-debate abort), settings and safety validators, CLI (`seed-simulated`, `debate`, `ingest`, …) |
| `api/routes.py` | Dashboard API, auth/register, role-based redaction |
| `api/system.py` | Health checks, SSE `/api/events/stream`, Telegram webhook, `/service/*` endpoints for n8n (bearer service token) |
| `core/` | `events.emit` (system_events plus SSE), hash-chained audit, job locks, redaction, logging |
| `data/` | Public source adapters (`sources/public.py`), ingestion and validation, snapshots, the simulated generator |
| `agents/` | `schemas.py` (AGENT_PERSONAS: macro=Atlas, fundamental=Sage, onchain=Cipher, flow=Vortex, technical=Chronos, quant=Alpha, risk=Sentinel, critic=Killjoy, fund_manager=Odin), per-role agents, `llm.py` (Anthropic Messages API with budget), `prompts/*.md` |
| `debate/orchestrator.py` | The 8 rounds. Emits `debate.started`, `debate.round_started`, `debate.message` (kind, to, round), `agent.state`, and `debate.finished` or `debate.failed` |
| `quant/` | Causal indicators, next-bar-open backtester with fees/slippage/funding, metrics, IS/val/OOS split, walk-forward, Monte Carlo |
| `risk/` | Pure risk engine (linear/inverse/spot), service that persists hashed decisions |
| `paper/engine.py` | Paper fills; imports no exchange or HTTP client (enforced by a test) |
| `exchange/` | MEXC read-only client; execution adapter that refuses to submit |
| `telegram/` | Indonesian fund-manager bot: allowlist checked before data access, intents, dedup |
| `security/` | Sessions (HttpOnly SameSite=Strict cookie plus `X-Requested-With: tcc`), scrypt, per-process rate limiter |
| `db/models.py`, `backend/alembic/versions/0001`, `0002` | Schema and migrations |

Tests are in `backend/tests/` (122 tests): api_security, data_pipeline, debate, llm (mocked), paper_exchange, quant, risk_engine, telegram, repo_secrets.

## Frontend (`frontend/src/`, React 18, Vite 8, TS, Framer Motion, React Flow, Lightweight Charts, R3F/three)

| Path | Role |
|---|---|
| `App.tsx` | Public routes `/`, `/login`, `/signup`, `/terms`; dashboard under `/app/*` (relative nested routes) |
| `pages/*.tsx` | The 12 dashboard pages (CommandCenter, MarketIntel, AgentNetworkPage, DebateRoom, QuantLab, RiskCenter, PaperTerminal, Operations, Settings, …) |
| `pages/public/` | Indonesian homepage (`Landing.tsx`, scripted ILUSTRASI demo), auth, site chrome |
| `lib/events.tsx` | SSE context (`useEvents`); `lib/api.ts`, `lib/hooks.ts` (`useApi`) |
| `components/Mascot.tsx` | `AGENTS` (name, colour, titles), 16×14 pixel mascots |
| `components/TradingFloor.tsx` | 2D pixel floor (also the 3D fallback) |
| `components/LiveFloor.tsx` | Turns live events into floor state, with paced replay of debate events (`usePacedEvents`) |
| `components/office3d/` | 3D office. `Office3D.tsx` is the HUD, lazy loader and fallback; `OfficeScene.tsx` holds the rooms, employees and effects; `layout.ts` the desk positions and camera views; `links.ts` the message routing; `types.ts` the shared types |

CSP rule: no CDN fonts, HDRs, blob workers or inline scripts. Do not use drei `<Text>` or `<Environment>`. Vite `assetsInlineLimit: 0` is set so no `data:` exception is needed.

## Orchestration and ops

- `n8n/workflows/00-07*.json` contain 8 workflows with fixed IDs (`tccErrorHandler1`, `tccMarketData001`, …). The credential id is `tccServiceToken1`.
- `docker-compose.yml` runs postgres, backend, frontend (nginx) and n8n, with an optional Caddy `tls` profile. `deploy/` holds the backup, restore, postgres-init and Caddyfile.
- `.github/workflows/ci.yml` runs the jobs backend (ruff and pytest), frontend (build and vitest) and n8n-workflows (import check).

## Commands

```bash
# backend
cd backend && pip install -r requirements-dev.txt
ruff check app tests --select E,F,W,B --ignore E501,B008,B904
DATABASE_URL=postgresql+psycopg://tcc:tcc@localhost:5432/tcc_test pytest -q
# frontend
cd frontend && npm ci && npm run build && npm test     # build = tsc --noEmit + vite build
# stack
docker compose up -d --build
docker compose exec backend python -m app.cli seed-simulated && docker compose exec backend python -m app.cli debate BTCUSDT
```

Images built behind the session proxy need `--network host --secret id=extra_ca,src=<proxy CA>`. Docker Hub often returns 429; retry with backoff.

## Docs

- DEPLOYMENT: VPS, n8n import, Telegram, backups
- SECURITY: checklist
- DATA_SOURCES: endpoints and verification status
- LIVE_TRADING_GATES: what must be true before live trading
- PRODUCTION_READINESS: evidence and gaps
- COMPARISON: eight reference repos
