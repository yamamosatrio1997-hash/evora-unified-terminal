/**
 * Connects the office to your real Quantbot.
 *
 * In the browser console / from your own scripts:
 *   QuantbotOffice.signal({ lead: 'vortex', symbol: 'BTCUSDT', side: 'LONG', size: '2.5' })
 *   QuantbotOffice.say('odin', 'PnL kita tembus target hari ini!')
 *   QuantbotOffice.updateFund({ equity: 1_250_000, startOfDay: 1_200_000, winRate: 64 })
 *   QuantbotOffice.trigger('meeting')
 *
 * Or open the page with ?ws=ws://localhost:8787 and send JSON messages:
 *   { "type": "signal", "lead": "cipher", "symbol": "ETHUSDT", "side": "SHORT" }
 *   { "type": "say", "agent": "sentinel", "text": "VaR naik, hati-hati." }
 *   { "type": "fund", "data": { "equity": 1250000, "positions": [ ... ] } }
 *   { "type": "scenario", "name": "pantry" }
 *   { "type": "report" }
 */
import type { Agent } from '../agents/Agent';
import type { ClockMode } from '../core/OfficeClock';
import type { Director, ScenarioKind } from '../sim/Director';
import type { FundState, FundUpdate } from '../sim/FundState';

export interface BridgeDeps {
  agents: Agent[];
  director: Director;
  fund: FundState;
  setClockMode: (m: ClockMode) => void;
  notify: (msg: string) => void;
}

export interface Signal {
  lead?: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size?: string | number;
}

export type BridgeMessage =
  | { type: 'say'; agent: string; text: string }
  | { type: 'signal' } & Signal
  | { type: 'fund'; data: FundUpdate }
  | { type: 'scenario'; name: ScenarioKind }
  | { type: 'report' };

export function installBridge(deps: BridgeDeps) {
  const byId = (id: string) => deps.agents.find((a) => a.id === id.toLowerCase());

  const api = {
    say(agentId: string, text: string): boolean {
      const a = byId(agentId);
      if (!a) return false;
      void a.say(text);
      return true;
    },
    signal(s: Signal): string {
      const msg = deps.director.trigger('instruction', {
        lead: s.lead?.toLowerCase(), sym: s.symbol, side: s.side, ...(s.size !== undefined ? { size: String(s.size) } : {}),
      });
      deps.notify(`Sinyal ${s.side} ${s.symbol}: ${msg}`);
      return msg;
    },
    updateFund(update: FundUpdate): void {
      deps.fund.apply(update);
    },
    trigger(kind: ScenarioKind): string {
      return deps.director.trigger(kind);
    },
    setClockMode: deps.setClockMode,
    agents: () => deps.director.snapshot(),
    handle(msg: BridgeMessage): void {
      switch (msg.type) {
        case 'say': api.say(msg.agent, msg.text); break;
        case 'signal': api.signal(msg); break;
        case 'fund': api.updateFund(msg.data); break;
        case 'scenario': deps.notify(api.trigger(msg.name)); break;
        case 'report': deps.notify(api.trigger('report')); break;
      }
    },
  };
  (window as unknown as { QuantbotOffice: typeof api }).QuantbotOffice = api;

  const url = new URLSearchParams(location.search).get('ws');
  if (url) connect(url, api.handle, deps.notify);
  return api;
}

function connect(url: string, handle: (m: BridgeMessage) => void, notify: (m: string) => void, delay = 1000): void {
  const ws = new WebSocket(url);
  ws.onopen = () => { delay = 1000; notify(`Terhubung ke Quantbot feed (${url})`); };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(String(ev.data)) as BridgeMessage);
    } catch (err) {
      console.warn('[bridge] invalid message', ev.data, err);
    }
  };
  ws.onclose = () => {
    setTimeout(() => connect(url, handle, notify, Math.min(delay * 2, 30000)), delay);
  };
}
