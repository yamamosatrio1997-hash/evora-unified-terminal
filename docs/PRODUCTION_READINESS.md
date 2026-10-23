# Production-readiness report

Date: 2026-10-23. **Verdict: not production-ready for trading decisions, and live trading is out of scope.** The system is deployable as a paper-trading research platform once its external integrations are verified on a host with network access.

## What was verified, and how

| Area | Evidence |
|---|---|
| Backend unit + integration tests | **122 passed, 0 failed** (pytest against real PostgreSQL 16 locally; CI uses 17) |
| Frontend | `tsc --noEmit` clean, production build succeeds, 6 vitest tests pass |
| Lint | `ruff` (E, F, W, B) clean |
| Migrations | upgrade → downgrade → upgrade round-trip; `alembic check` shows no drift |
| Docker Compose stack | built and run locally: postgres 17, backend, nginx frontend, n8n 2.44.6, all healthy |
| n8n | all 8 workflows imported into real n8n 2.44.6. Workflows 01 (ingest → paper mark → callback) and 05 (health → IF → alert → callback) **executed end-to-end** against the backend, and both executions were recorded |
| Homepage + dashboard (end-to-end) | Playwright with software WebGL (SwiftShader), 39 checks, all passing, zero console errors: homepage 3D office renders and its illustration animates, the 2D fallback toggle works, anchors and FAQ work, mobile has no overflow; signup validation, signup → auto-login as viewer, viewer redaction, logout, auth guard, wrong-password error; admin navigates all 12 pages; the live 3D office reacts to a real debate (paced replay shown) and settles afterwards; employee chip → drawer; camera presets; 2D floor desk → drawer; tabs; Run debate, Run backtest, risk calculator, emergency stop engage/release, mark to market, ingestion, settings save, audit-chain verify |
| Restart/recovery | postgres restart, backend restart and full `down`/`up` with volumes kept: data intact, audit chain verifies, n8n workflows persist |

### Acceptance criteria (section 13)

| # | Criterion | Status | Test / evidence |
|---|---|---|---|
| 1 | App starts, health checks | ✅ | `test_health_endpoints`, compose healthchecks |
| 2 | Migrations and persistence | ✅ | round-trip, `alembic check`, all DB tests |
| 3 | Market data fetched, normalized, validated | ⚠️ partial | parsers tested on recorded-shape **fixtures**; live endpoints **not reachable** from the build host |
| 4 | Stale / missing / malformed / contradictory data detected | ✅ (contradictory: partial) | `test_snapshot_detects_stale_and_missing`, `test_malformed_payloads_rejected`, inconsistent OHLC rejection. Cross-source contradiction (e.g. CoinGecko vs Binance price) is **not** checked |
| 5 | Agent outputs match schema, cite evidence | ✅ | schema validator; snapshot reference check in every debate test |
| 6 | Debate disagreements and replies persisted | ✅ | `test_full_debate_on_simulated_data_is_no_trade` |
| 7 | Loops and duplicates prevented | ✅ | fixed 8 rounds, `test_duplicate_debate_rejected`, job locks |
| 8 | Quant metrics reproducible | ✅ | `test_known_metrics`, `test_backtest_reproducible`, seeded Monte Carlo |
| 9 | Fees/slippage; no look-ahead | ✅ | `test_entry_is_next_bar_open_with_costs`, `test_no_lookahead_future_bars_do_not_change_past_trades`, `test_indicators_are_causal` |
| 10 | 3% ceiling enforced | ✅ | `test_three_percent_ceiling_is_hard`, config validator |
| 11 | Invalid stop, unknown contract, stale data, limits rejected | ✅ | 28 risk-engine tests |
| 12 | Veto cannot be overridden | ✅ | `test_risk_veto_cannot_be_overridden` |
| 13 | Telegram allowlist blocks unauthorized users | ✅ | `test_unauthorized_blocked_before_data` |
| 14 | Telegram uses real data, no fabrication | ✅ | `test_all_commands_answer_without_data` |
| 15 | No context leakage between users | ✅ | `test_context_isolated_per_user` |
| 16 | Telegram retries are not duplicated | ✅ | `test_retry_dedup` |
| 17 | n8n monitoring reflects actual status | ✅ | callback tests and live n8n execution |
| 18 | MEXC credentials never in frontend/logs | ✅ | `test_mexc_sync_with_mock_never_leaks_secret`, `test_secrets_never_returned` |
| 19 | Paper cannot submit live orders | ✅ | `test_paper_engine_has_no_exchange_or_network_imports`, `test_live_submission_always_refused` |
| 20 | Partial fills / rejects / unknown status | ✅ (adapter design) | `test_reconcile_state_machine`, `test_partial_fill_against_liquidity` |
| 21 | Animations reflect real events | ✅ | SSE-driven only; `test_no_agent_left_in_active_state_after_debate`; Playwright check |
| 22 | Restart and recovery | ✅ | manual compose tests above; orphaned-debate abort tested |
| 23 | Secrets absent from source control | ✅ | `test_no_secrets_in_tracked_files` |
| — | Strategy internals and private data hidden from non-admins | ✅ | `test_strategy_internals_hidden_from_non_admin`, `test_telegram_ids_masked`, Playwright viewer checks |

## Not executed, or blocked

- **Live data sources** (Binance, CoinGecko, FRED, DefiLlama, Alternative.me): blocked by the build environment's network policy (proxy 403). No real candle has been ingested, and every chart and debate shown during testing used **synthetic data labelled SIMULATED**.
- **LLM calls**: no API key was available, so no real model was called. The LLM path is tested against a **mocked** Messages API (`tests/test_llm.py`): claims with fabricated or missing citations are dropped, confidence cannot be raised, budget exhaustion falls back to deterministic analysis, malformed output is ignored, and Fund Manager wording that names a different decision is discarded. Live output quality is unverified.
- **Telegram Bot API / MEXC API**: no credentials, hosts blocked. Request signing is unit-tested; the live calls are not.
- **Load testing**: not performed. Expected load is light (one debate per symbol every 4h, ingestion every 5 min), but measure memory with real data volume.
- **Backup/restore scripts**: written, but `backup.sh` and `restore.sh` were not executed in this environment.
- **TLS profile (Caddy)**: not exercised; it needs a real domain.

## Known limitations and risks

0. **Signups**: there is no email verification or password reset yet, because no mail service is configured. Public signups are open by default (`ALLOW_SIGNUP=true`) and create read-only viewers. Close them or add verification before promoting the site widely.

1. **Quant edge**: on the synthetic data used for testing, no strategy showed a robust out-of-sample edge, which is expected from a random walk. Because the quant gate requires one, the system will mostly output NO TRADE / WAIT FOR CONFIRMATION until a strategy passes on real data. That is intended.
2. **Rule-family mismatch**: the Quant Researcher tests the EMA-trend family, while the Technical Analyst's setup also uses swing-level stops and a 2R target. They are close but not identical rules.
3. **Context agents are thin without paid data**: no economic calendar, whale feed, exchange flows, liquidations or tokenomics. The agents say so explicitly.
4. **Correlation model**: all crypto majors are treated as one correlation group (conservative), with no measured correlation matrix.
5. **Paper fills**: market fills at the latest 1h close plus 5 bps slippage, a 10%-of-bar-volume liquidity cap, and stops checked on closed 1h bars. Paper results will look better than live in fast markets.
6. **Rate limiters are per process** (2 uvicorn workers).
7. **Confidence scores are heuristic** and are not calibrated probabilities; this is labelled in the UI.
8. **3D office performance** was only measured with software rendering (SwiftShader, no GPU): 2–10 fps, usable but not smooth. It has not been measured on real GPUs or low-end phones. On touch devices the homepage scene disables orbit controls so the page still scrolls. The 2D floor is the fallback.
9. n8n 2.x prints a warning about the missing Python task runner. It is harmless here because the workflows use no Code nodes.

## Estimated running costs (assumptions; verify current prices)

| Item | Assumption | Monthly |
|---|---|---|
| VPS 2 vCPU / 4 GB / 80 GB | typical EU/US provider | ~US$10–30 |
| Market data | free tiers (Binance public, CoinGecko keyless/demo, FRED key, DefiLlama, Alternative.me) | US$0 |
| Telegram | Bot API | US$0 |
| LLM (optional) | Per debate: up to about 18 calls × (~3k input + ~1.2k output tokens). At the configured placeholder prices of $5 / $25 per million tokens, that is ≈ $0.05 per call, or ≈ $0.80 per debate worst case, hard-capped at `DEBATE_COST_BUDGET_USD` ($2). 2 symbols × 6 debates a day | **≈ US$100–300** worst case. Set `LLM_*_COST_PER_MTOK` to your contract and lower the budget, or use a cheaper model for context agents. US$0 in deterministic mode |
| Backups | off-site object storage, a few GB | ~US$1 |

## Recommended next steps (in order)

1. Deploy to a VPS with outbound access, run `python -m app.cli ingest`, and fix any adapter whose live payload differs from the documented shape (it will show as rejected rows).
2. Backfill at least 500 4h candles per symbol (the current ingest fetches 500 per call) and run the scheduled backtests on real data.
3. Enable the LLM with a small budget and review agent outputs for citation quality and usefulness.
4. Configure the Telegram bot and a read-only MEXC key, and verify both live.
5. Run backup and restore once and time it.
6. Run paper trading for a pre-registered period before considering anything in `LIVE_TRADING_GATES.md`.
