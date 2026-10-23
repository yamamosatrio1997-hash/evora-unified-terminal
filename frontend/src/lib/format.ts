export const num = (v: unknown, d = 2): string => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (v === null || v === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const pct = (v: unknown, d = 2): string => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (v === null || v === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(d)}%`;
};

export const ts = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

export const ago = (iso?: string | null): string => {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const age = (seconds?: number | null): string => {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
};
