export interface SystemEvent {
  id: number;
  ts: string;
  type: string;
  agent: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
}

export interface AgentStatus {
  role: string;
  name: string;
  state: string;
  last_event_at: string | null;
  last_analysis: null | {
    id: number;
    session_id: string;
    status: string;
    created_at: string;
    stance: string;
    conclusion: string;
    confidence: number | null;
    missing_data: string[];
    errors: string[];
    llm_used: boolean;
    model: string | null;
    prompt_version?: string;
  };
}

export interface SourceHealth {
  source: string;
  status: string;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  latency_ms: number | null;
  rate_limit: Record<string, unknown>;
}

export interface SystemStatus {
  as_of: string;
  mode: string;
  live_trading_enabled: boolean;
  emergency_stop: boolean;
  database: string;
  llm: string;
  telegram: string;
  mexc: string;
  n8n_api: string;
  sources: SourceHealth[];
  stale_series: string[];
  series_tracked: number;
  simulated_data_present: boolean;
  workflow_errors_24h: number;
  last_workflow_report: string | null;
  telegram_errors_24h: number;
}

export interface MarketSnap {
  symbol: string;
  price: string | null;
  price_time?: string;
  price_source?: string;
  simulated?: boolean;
  change_24h_pct?: number | null;
  age_seconds?: number;
  metrics: Record<string, { value: string; unit: string; source: string; observed_at: string }>;
}

export interface EquityPoint {
  ts: string;
  equity: number;
  drawdown: number;
}

export interface Overview {
  system: SystemStatus;
  regime: { label: string; basis: string; volatility_atr_pct_1d?: number; as_of?: string; simulated?: boolean };
  markets: MarketSnap[];
  agents: AgentStatus[];
  paper: {
    data_kind: string;
    equity: string;
    starting_equity: string;
    return_pct: string;
    realized_pnl: string;
    unrealized_pnl: string;
    current_drawdown: string;
    max_drawdown_period: string;
    trades: number;
    open_positions: number;
    equity_curve: EquityPoint[];
    as_of: string;
  };
  recent_decisions: { id: number; symbol: string; decision: string; created_at: string; session_id: string }[];
  alerts: { level: string; message: string }[];
}

export interface DebateSummary {
  id: string;
  symbol: string;
  status: string;
  trigger: string;
  created_at: string;
  finished_at: string | null;
  rounds_completed: number;
  max_rounds: number;
  final_decision: string | null;
  tokens_used: number;
  cost_usd: string;
  error: string | null;
  snapshot_id: string;
}

export interface Claim {
  statement: string;
  kind: "fact" | "inference" | "hypothesis" | "unknown";
  source_refs: string[];
}

export interface SourceRef {
  id: string;
  source: string;
  observed_at: string | null;
  retrieved_at?: string | null;
  note?: string | null;
}

export interface AgentOutput {
  role: string;
  timestamp: string;
  snapshot_id: string;
  status: string;
  stance: string;
  conclusion: string;
  confidence: number | null;
  confidence_note: string;
  supporting_evidence: Claim[];
  opposing_evidence: Claim[];
  assumptions: string[];
  uncertainty: string;
  source_references: SourceRef[];
  missing_data: string[];
  recommended_next_action: string;
  metrics: Record<string, any>;
  trade_idea: null | { side: string; timeframe: string; entry: number; entry_trigger: string; stop_loss: number; take_profit: number | null; invalidation: string };
  model: string | null;
  prompt_version?: string;
  llm_used: boolean;
  errors: string[];
}

export interface DebateMessage {
  id: number;
  round: number;
  from: string;
  to: string | null;
  kind: string;
  content: string;
  references: unknown[];
  reply_to: number | null;
  created_at: string;
}

export interface DebateDetail {
  session: DebateSummary;
  snapshot: { id: string; hash: string; created_at: string; quality: { stale: string[]; missing: string[]; simulated: string[] }; simulated: boolean } | null;
  messages: DebateMessage[];
  analyses: { role: string; round: number; status: string; output: AgentOutput; tokens_in: number; tokens_out: number }[];
  decision: null | { id: number; decision: string; details: any; risk_decision_id: number | null; created_at: string };
}

export interface BacktestSummary {
  id: string;
  created_at: string;
  strategy: string;
  symbol: string;
  interval: string;
  status: string;
  dataset_kind: string;
  data_source: string;
  data_start: string | null;
  data_end: string | null;
  error: string | null;
  oos: Record<string, any>;
  warnings: string[];
  results?: any;
  assumptions?: any;
}
