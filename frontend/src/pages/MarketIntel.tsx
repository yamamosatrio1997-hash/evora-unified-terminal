import { useState } from "react";
import type { Me } from "../App";
import { CandleChart, type CandleRow, type Marker } from "../components/charts";
import { Card, DataTag, Empty, ErrorNote, Kv, Updated } from "../components/ui";
import { num, pct, ts } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { MarketSnap } from "../lib/types";

interface CandleResp {
  symbol: string; interval: string; source: string | null; status: string; last_close_time?: string;
  rows: CandleRow[]; indicators: Record<string, (number | null)[]>; markers: Marker[];
  volatility?: { atr14_pct: number | null; realized_vol_annual: number | null };
}
interface Ctx { symbol: MarketSnap; context: Record<string, null | { value: string; unit: string; source: string; observed_at: string; meta: Record<string, unknown> }> }

const LABEL: Record<string, string> = {
  "CRYPTO:fear_greed_index": "Fear & Greed", "CRYPTO:btc_dominance_pct": "BTC dominance %", "CRYPTO:total_market_cap": "Total crypto mkt cap",
  "DEFI:total_tvl": "DeFi TVL", "STABLECOINS:total_supply_usd_pegged": "Stablecoin supply", "MACRO:ust_10y_yield": "US 10y yield %",
  "MACRO:usd_broad_index": "USD broad index (DXY proxy)", "MACRO:fed_funds_effective": "Eff. fed funds %",
};

export default function MarketIntel(_: { me: Me }) {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState("4h");
  const [show, setShow] = useState({ ema: true, rsi: true, volume: true });
  const c = useApi<CandleResp>(`/market/candles?symbol=${symbol}&interval=${interval}&limit=500`, 60000);
  const ctx = useApi<Ctx>(`/market/context?symbol=${symbol}`, 60000);
  const status = c.data?.status;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Chart" right={<Updated at={c.updatedAt} error={c.error} />}>
        <div className="row" style={{ marginBottom: 10 }}>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol"><option>BTCUSDT</option><option>ETHUSDT</option></select>
          <div className="row" role="group" aria-label="Timeframe">
            {["1h", "4h", "1d"].map((iv) => <button key={iv} className={`btn sm ${iv === interval ? "primary" : ""}`} onClick={() => setInterval(iv)}>{iv}</button>)}
          </div>
          {(["ema", "rsi", "volume"] as const).map((k) => (
            <label key={k} className="row muted" style={{ fontSize: 12, gap: 4 }}>
              <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />{k.toUpperCase()}
            </label>
          ))}
          <div style={{ flex: 1 }} />
          {status === "simulated" && <DataTag kind="SIMULATED" />}
          {status === "stale" && <DataTag kind="STALE" />}
          {status === "ok" && <DataTag kind="DELAYED" />}
          {status === "unavailable" && <DataTag kind="UNAVAILABLE" />}
          {c.data?.source && <span className="faint mono" style={{ fontSize: 11 }}>{c.data.source} · last close {ts(c.data.last_close_time)}</span>}
        </div>
        <ErrorNote error={c.error} />
        {c.data && c.data.rows.length > 0 ? (
          <CandleChart rows={c.data.rows} indicators={c.data.indicators} markers={c.data.markers} show={show} />
        ) : (
          <Empty title="No candles available">No closed candles are stored for {symbol} {interval}. Check the Data Monitor for source status.</Empty>
        )}
        <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          Closed candles only (the forming candle is excluded). EMA 20/50/200 · RSI 14 · markers are PAPER (simulated) entries/exits with stop and target lines. "Delayed" = public REST data polled on a schedule, not a tick feed.
        </div>
      </Card>
      <div className="grid g3">
        <Card title="Volatility">
          <Kv rows={[["ATR(14) / price", pct(c.data?.volatility?.atr14_pct)], ["Realized vol (annualized, 30 bars)", pct(c.data?.volatility?.realized_vol_annual)]]} />
        </Card>
        <Card title="Derivatives" right={<span className="faint" style={{ fontSize: 11 }}>Binance USDⓈ-M</span>}>
          {ctx.data && Object.keys(ctx.data.symbol.metrics).length > 0 ? (
            <Kv rows={Object.entries(ctx.data.symbol.metrics).map(([k, v]) => [k.replace(/_/g, " "), <span title={`${v.source} · ${ts(v.observed_at)}`}>{k.includes("rate") ? pct(v.value, 4) : num(v.value)} <span className="faint">{ts(v.observed_at)}</span></span>])} />
          ) : <Empty title="Funding / open interest unavailable" />}
        </Card>
        <Card title="Market context">
          {ctx.data ? (
            <Kv rows={Object.entries(ctx.data.context).map(([k, v]) => [LABEL[k] ?? k, v ? <span>{num(v.value, k.includes("index") || k.includes("yield") || k.includes("pct") || k.includes("funds") ? 2 : 0)} <span className="faint">{v.source} · {v.observed_at.slice(0, 10)}</span></span> : <span className="faint">unavailable</span>])} />
          ) : <div className="muted">Loading…</div>}
        </Card>
      </div>
    </div>
  );
}
