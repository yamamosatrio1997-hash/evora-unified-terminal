import type { WallCandle } from "../TradingFloor";

export type Lang = "en" | "id";
export type ViewKey = "overview" | "debate" | "research" | "risk";

export interface OfficeAgent {
  state: string;
  active: boolean;
  bubble?: string | null;
  /** Walk to the debate-room table instead of sitting at the home desk. */
  atTable?: boolean;
}

/** One message travelling between two agents (or to the debate table). `at` is a client timestamp (ms). */
export interface CommLink {
  id: string;
  from: string;
  to: string;
  kind: string;
  at: number;
}

export interface OfficeSceneProps {
  agents: Record<string, OfficeAgent>;
  links: CommLink[];
  candles: WallCandle[];
  wallLabel: string;
  wallBadge?: string;
  roundLabel?: string | null;
  decision?: { text: string; at: number } | null;
  vetoAt?: number | null;
  dataAt?: number | null;
  lang: Lang;
}

export const LINK_LIFE_MS = 2800;

export const KIND_COLOR: Record<string, string> = {
  hypothesis: "#22D3EE",
  evidence: "#22D3EE",
  challenge: "#FB923C",
  reply: "#A3E635",
  synthesis: "#C084FC",
  quant_validation: "#F472B6",
  risk_review: "#34D399",
  veto: "#F87171",
};
