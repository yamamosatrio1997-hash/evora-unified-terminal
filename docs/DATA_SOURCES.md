# Data sources

**Verification status:** none of these hosts were reachable from the build environment, because its egress policy blocked them with HTTP 403 at the proxy and the documentation sites did not resolve either. Each adapter follows the provider's published contract as known at the time of writing and is unit-tested against recorded-shape fixtures. Before relying on any source, run `docker compose exec backend python -m app.cli ingest` on the production host and check the Data Monitor. A shape mismatch shows up as rejected rows or a `degraded` source, never as silently wrong data.

| Source | Endpoints used | Key | Notes and limits (check current docs) |
|---|---|---|---|
| Binance spot (market data) | `GET /api/v3/klines` on `data-api.binance.vision` | none | Request weight counted per minute (header `x-mbx-used-weight-1m` is recorded). 429 means back off; 418 means the IP is banned, so the adapter does not retry. 451 means a restricted region. The still-forming candle is dropped. |
| Binance USDⓈ-M futures | `GET /fapi/v1/premiumIndex`, `GET /fapi/v1/openInterest` | none | Funding rate (last), mark price, open interest. Funding values with magnitude ≥ 5% are rejected as implausible. |
| CoinGecko | `GET /simple/price`, `GET /global` | optional demo key (`x-cg-demo-api-key`) | Keyless access is heavily rate limited; the hourly schedule keeps usage low. Check the license terms for display and attribution. |
| FRED | `GET /fred/series/observations` | **required** (`FRED_API_KEY`, free) | Series DFF, DGS10, DGS2, DTWEXBGS, CPIAUCSL, UNRATE, WALCL, RRPONTSYD. A value of `.` means missing and is skipped, never filled. `date` is the observation period; `realtime_start` is stored as `available_since`. DTWEXBGS is a broad USD index used as a **proxy**; it is not DXY. |
| DefiLlama | `GET api.llama.fi/v2/historicalChainTvl`, `GET stablecoins.llama.fi/stablecoincharts/all` | none | Total DeFi TVL and USD-pegged stablecoin supply (daily). |
| Alternative.me | `GET /fng/?limit=N` | none | Fear & Greed index 0–100 (daily); values outside that range are rejected. |
| MEXC (account) | spot `GET /api/v3/account`; futures `GET /api/v1/private/account/assets`, `/position/open_positions`; public `GET /api/v1/contract/detail` | read-only key | Spot: HMAC-SHA256 over the query string, `X-MEXC-APIKEY`. Futures: HMAC-SHA256 of `accessKey + Request-Time + paramString`, headers `ApiKey`/`Request-Time`/`Signature` (confirmed against MEXC's integration guide via search; the exact GET param-string format still needs live verification). |

## Storage and quality

Every row stores its source, asset, metric, value, unit, observation time, retrieval time, timeframe and quality (`ok` / `simulated`). Duplicates are ignored by unique constraints. Freshness thresholds: point metrics after `DATA_STALE_AFTER_SECONDS` (900 s); daily after 4 days; weekly after 10; monthly after 75, because CPI is published weeks after its period. Candles go stale after 2 intervals plus 2 minutes.

## Known gaps (no free, verified source configured)

These are listed as `missing_data` in agent outputs and on the Data Monitor:

- Economic calendar and scheduled release times
- Verified whale-transaction feed, and any exchange-flow attribution (no wallet attribution is ever made)
- Order-book depth history, liquidations
- Tokenomics, unlock schedules, protocol revenue

Adding any of these needs a source whose license and accuracy you have checked.
