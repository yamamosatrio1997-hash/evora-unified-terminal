import { useEffect, useRef } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

const toTs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

const BASE = {
  layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8494a8", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
  grid: { vertLines: { color: "rgba(28,37,51,0.6)" }, horzLines: { color: "rgba(28,37,51,0.6)" } },
  rightPriceScale: { borderColor: "#1c2533" },
  timeScale: { borderColor: "#1c2533", timeVisible: true, secondsVisible: false },
  crosshair: { mode: CrosshairMode.Normal },
  autoSize: true,
};

export interface CandleRow { time: string; open: number; high: number; low: number; close: number; volume: number }
export interface Marker { time: string; kind: string; side: string; price: number; stop?: number; take_profit?: number | null; reason?: string }

export function CandleChart({ rows, indicators, markers, show }: {
  rows: CandleRow[];
  indicators: Record<string, (number | null)[]>;
  markers: Marker[];
  show: { ema: boolean; rsi: boolean; volume: boolean };
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !rows.length) return;
    const chart: IChartApi = createChart(el.current, BASE);
    const c = chart.addSeries(CandlestickSeries, {
      upColor: "#3ddc97", downColor: "#f0616d", borderVisible: false, wickUpColor: "#3ddc97", wickDownColor: "#f0616d",
    });
    c.setData(rows.map((r) => ({ time: toTs(r.time), open: r.open, high: r.high, low: r.low, close: r.close })));
    if (show.volume) {
      const v = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(rows.map((r) => ({ time: toTs(r.time), value: r.volume, color: r.close >= r.open ? "rgba(61,220,151,0.28)" : "rgba(240,97,109,0.28)" })));
    }
    const line = (key: string, color: string, pane = 0) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane);
      s.setData(rows.flatMap((r, i) => (indicators[key]?.[i] == null ? [] : [{ time: toTs(r.time), value: indicators[key][i] as number }])));
      return s;
    };
    if (show.ema) {
      line("ema20", "#67e8d6");
      line("ema50", "#7aa7ff");
      line("ema200", "#b59cff");
    }
    if (show.rsi) {
      const r = line("rsi14", "#f5b85b", 1);
      r.createPriceLine({ price: 70, color: "rgba(240,97,109,0.5)", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      r.createPriceLine({ price: 30, color: "rgba(61,220,151,0.5)", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      chart.panes()[1]?.setHeight(110);
    }
    const first = toTs(rows[0].time);
    const visible = markers.filter((m) => toTs(m.time) >= first).sort((a, b) => toTs(a.time) - toTs(b.time));
    createSeriesMarkers(c, visible.map((m) => ({
      time: toTs(m.time),
      position: m.kind === "entry" ? (m.side === "long" ? "belowBar" : "aboveBar") : "aboveBar",
      color: m.kind === "entry" ? "#67e8d6" : "#f5b85b",
      shape: m.kind === "entry" ? (m.side === "long" ? "arrowUp" : "arrowDown") : "circle",
      text: m.kind === "entry" ? `PAPER ${m.side}` : `exit ${m.reason ?? ""}`,
    })));
    const open = [...visible].reverse().find((m) => m.kind === "entry");
    if (open?.stop) c.createPriceLine({ price: open.stop, color: "#f0616d", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "stop" });
    if (open?.take_profit) c.createPriceLine({ price: open.take_profit, color: "#3ddc97", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "target" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [rows, indicators, markers, show.ema, show.rsi, show.volume]);
  return <div ref={el} style={{ height: show.rsi ? 520 : 420, width: "100%" }} />;
}

export function EquityChart({ points, height = 220 }: { points: { ts: string; equity: number }[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || points.length < 2) return;
    const chart = createChart(el.current, { ...BASE, timeScale: { ...BASE.timeScale, timeVisible: true } });
    const s = chart.addSeries(AreaSeries, { lineColor: "#67e8d6", topColor: "rgba(103,232,214,0.25)", bottomColor: "rgba(103,232,214,0.0)", lineWidth: 2 });
    const seen = new Set<number>();
    s.setData(points.flatMap((p) => {
      const t = toTs(p.ts);
      if (seen.has(t)) return [];
      seen.add(t);
      return [{ time: t, value: p.equity }];
    }));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  return <div ref={el} style={{ height, width: "100%" }} />;
}

/** Index-based series (backtest curves have no real timestamps per point). */
export function SeriesChart({ values, height = 220, color = "#67e8d6" }: { values: number[]; height?: number; color?: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || values.length < 2) return;
    const chart = createChart(el.current, { ...BASE, timeScale: { ...BASE.timeScale, timeVisible: false, tickMarkFormatter: (t: number) => String(t) } });
    const s = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false });
    s.setData(values.map((v, i) => ({ time: (i + 1) as UTCTimestamp, value: v })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [values, color]);
  return <div ref={el} style={{ height, width: "100%" }} />;
}

export function Histogram({ counts, edges, height = 140 }: { counts: number[]; edges: number[]; height?: number }) {
  const max = Math.max(1, ...counts);
  const w = 100 / counts.length;
  const zeroIdx = edges.findIndex((e, i) => e <= 0 && (edges[i + 1] ?? 1) > 0);
  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: "100%", height }} role="img" aria-label="Distribution histogram">
        {counts.map((c, i) => {
          const h = (c / max) * (height - 4);
          const neg = (edges[i + 1] ?? 0) <= 0;
          return <rect key={i} x={i * w + 0.3} y={height - h} width={w - 0.6} height={h} fill={neg ? "rgba(240,97,109,0.65)" : "rgba(61,220,151,0.65)"} />;
        })}
        {zeroIdx >= 0 && <line x1={(zeroIdx + 1) * w} x2={(zeroIdx + 1) * w} y1={0} y2={height} stroke="#8494a8" strokeDasharray="1.5 1.5" strokeWidth={0.3} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="row mono faint" style={{ fontSize: 10.5, justifyContent: "space-between" }}>
        <span>{(edges[0] * 100).toFixed(1)}%</span><span>final return</span><span>{(edges[edges.length - 1] * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}
