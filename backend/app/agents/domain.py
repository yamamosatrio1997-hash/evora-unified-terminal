"""Context agents (macro, fundamental, on-chain, flow).

Each computes deterministic facts from the shared snapshot and declares its data
gaps explicitly. If an LLM is configured, it may add interpretation on top; its
claims must cite snapshot sources or they are dropped.
"""
from __future__ import annotations

from typing import Any

from app.agents.base import Agent, DebateContext, fact, inference, uniq_refs
from app.agents.schemas import AgentOutput, Claim


def _change(hist: list[tuple[str, float]], lookback: int) -> float | None:
    if len(hist) <= lookback:
        return None
    return hist[-1][1] - hist[-1 - lookback][1]


def _pct_change(hist: list[tuple[str, float]], lookback: int) -> float | None:
    if len(hist) <= lookback or hist[-1 - lookback][1] == 0:
        return None
    return hist[-1][1] / hist[-1 - lookback][1] - 1


class _ContextAgent(Agent):
    required: tuple[str, ...] = ()
    unavailable_by_design: tuple[str, ...] = ()

    def gather(self, ctx: DebateContext) -> tuple[list[Claim], list[Claim], list[Any], dict[str, Any], int]:
        raise NotImplementedError

    def analyze(self, ctx: DebateContext) -> AgentOutput:
        sup, opp, refs, facts, score = self.gather(ctx)
        missing = [k for k in self.required if ctx.metric(k) is None]
        stale = [k for k in self.required if ctx.metric(k) is not None and ctx.is_stale(k)]
        missing_all = [f"{k} (not in snapshot)" for k in missing] + [f"{k} (stale)" for k in stale] + list(self.unavailable_by_design)
        usable = len(self.required) - len(missing) - len(stale)
        if usable == 0:
            out = self.base_output(
                ctx, status="insufficient_data", stance="no_view", confidence=0.0,
                conclusion=f"No usable {self.role} data in this snapshot; no view.",
                uncertainty="Complete: required inputs unavailable.", source_references=uniq_refs(*refs),
                missing_data=missing_all, recommended_next_action=self.fix_hint(),
            )
            return out
        stance = "bullish" if score > 0 else "bearish" if score < 0 else "neutral"
        coverage = usable / len(self.required)
        out = self.base_output(
            ctx, status="completed", stance=stance, confidence=round(min(0.6, 0.15 * abs(score)) * coverage, 2),
            conclusion=self.summary(stance, facts, coverage),
            supporting_evidence=sup, opposing_evidence=opp,
            assumptions=self.assumptions(), uncertainty=f"Data coverage {coverage:.0%} of required inputs; context signals are slow-moving and not timing tools.",
            source_references=uniq_refs(*refs), missing_data=missing_all,
            recommended_next_action="Weigh as context, not as an entry trigger.", metrics={"facts": facts, "score": score},
        )
        return self.enrich_with_llm(ctx, out, facts)

    def summary(self, stance: str, facts: dict[str, Any], coverage: float) -> str:
        return f"{self.role} context reads {stance} on available data (coverage {coverage:.0%})."

    def assumptions(self) -> list[str]:
        return []

    def fix_hint(self) -> str:
        return "Configure the data sources listed in missing_data."


class MacroAnalyst(_ContextAgent):
    role = "macro"
    prompt_name = "macro"
    required = ("MACRO:fed_funds_effective", "MACRO:ust_10y_yield", "MACRO:ust_2y_yield", "MACRO:usd_broad_index",
                "MACRO:cpi_all_items", "MACRO:unemployment_rate", "MACRO:fed_total_assets", "MACRO:reverse_repo")
    unavailable_by_design = ("economic calendar / scheduled release times (no free source configured)",
                             "DXY (ICE index; FRED broad USD index DTWEXBGS used as proxy)")

    def fix_hint(self) -> str:
        return "Set FRED_API_KEY and run macro ingestion."

    def gather(self, ctx):
        sup, opp, refs, facts, score = [], [], [], {}, 0
        y10, y2 = ctx.metric_value("MACRO:ust_10y_yield"), ctx.metric_value("MACRO:ust_2y_yield")
        r10, r2 = ctx.metric_ref("MACRO:ust_10y_yield"), ctx.metric_ref("MACRO:ust_2y_yield")
        refs += [r10, r2]
        if y10 is not None and y2 is not None:
            facts["curve_2s10s"] = round(y10 - y2, 3)
            (sup if y10 > y2 else opp).append(fact(f"10y {y10:.2f}% vs 2y {y2:.2f}%: 2s10s {y10 - y2:+.2f}pp", r10, r2))
        ch10 = _change(ctx.metric_history("MACRO:ust_10y_yield"), 20)
        if ch10 is not None:
            facts["ust10y_change_20obs"] = round(ch10, 3)
            if abs(ch10) > 0.15:
                score += -1 if ch10 > 0 else 1
                (opp if ch10 > 0 else sup).append(inference(f"10y yield {'rose' if ch10 > 0 else 'fell'} {abs(ch10):.2f}pp over ~20 sessions; "
                                                            f"{'tighter' if ch10 > 0 else 'easier'} financial conditions for risk assets", r10))
        usd = ctx.metric_history("MACRO:usd_broad_index")
        ru = ctx.metric_ref("MACRO:usd_broad_index")
        refs.append(ru)
        pu = _pct_change(usd, 20)
        if pu is not None:
            facts["usd_broad_change_20obs"] = round(pu, 4)
            if abs(pu) > 0.01:
                score += -1 if pu > 0 else 1
                (opp if pu > 0 else sup).append(inference(f"Broad USD index (DXY proxy) {pu:+.2%} over ~20 sessions", ru))
        for key, label in (("MACRO:fed_total_assets", "Fed balance sheet"), ("MACRO:reverse_repo", "Reverse repo")):
            h = ctx.metric_history(key)
            r = ctx.metric_ref(key)
            refs.append(r)
            pc = _pct_change(h, 4)
            if pc is not None:
                facts[f"{key}_pct_change_4obs"] = round(pc, 4)
                liquidity_up = pc > 0 if "assets" in key else pc < 0
                if abs(pc) > 0.01:
                    score += 1 if liquidity_up else -1
                (sup if liquidity_up else opp).append(fact(f"{label} {pc:+.2%} over last 4 observations", r))
        for key, label in (("MACRO:fed_funds_effective", "Effective fed funds"), ("MACRO:cpi_all_items", "CPI index"),
                           ("MACRO:unemployment_rate", "Unemployment rate")):
            v = ctx.metric_value(key)
            r = ctx.metric_ref(key)
            refs.append(r)
            if v is not None:
                m = ctx.metric(key)
                facts[key] = v
                sup.append(fact(f"{label}: {v} ({m['unit']}), period {m['latest']['observed_at'][:10]}"
                                f"{', public since ' + str(m['latest']['meta'].get('available_since')) if m['latest'].get('meta', {}).get('available_since') else ''}", r))
        cpi = ctx.metric_history("MACRO:cpi_all_items")
        if len(cpi) >= 13:
            yoy = cpi[-1][1] / cpi[-13][1] - 1
            facts["cpi_yoy"] = round(yoy, 4)
            (opp if yoy > 0.03 else sup).append(inference(f"CPI year-over-year {yoy:.2%} ({'above' if yoy > 0.03 else 'near/below'} 3%)", ctx.metric_ref("MACRO:cpi_all_items")))
        return sup, opp, refs, facts, score

    def assumptions(self):
        return ["Rising real yields and a stronger USD are historically headwinds for crypto risk appetite (relationship is unstable)."]


class FundamentalAnalyst(_ContextAgent):
    role = "fundamental"
    prompt_name = "fundamental"
    unavailable_by_design = ("tokenomics / supply schedule / unlocks (no configured source)",
                             "protocol revenue and fees for the asset (no configured source)",
                             "project development and catalyst calendar (no configured source)")

    def gather(self, ctx):
        base = ctx.content.get("base_asset")
        self.required = (f"{base}:market_cap", f"{base}:volume_24h", "CRYPTO:btc_dominance_pct", "DEFI:total_tvl")
        sup, opp, refs, facts, score = [], [], [], {}, 0
        mc, vol = ctx.metric_value(f"{base}:market_cap"), ctx.metric_value(f"{base}:volume_24h")
        rmc, rv = ctx.metric_ref(f"{base}:market_cap"), ctx.metric_ref(f"{base}:volume_24h")
        refs += [rmc, rv]
        if mc and vol:
            turnover = vol / mc
            facts["turnover_24h"] = round(turnover, 4)
            sup.append(fact(f"{base} market cap ${mc:,.0f}; 24h volume ${vol:,.0f} (turnover {turnover:.2%})", rmc, rv))
        dom = ctx.metric_history("CRYPTO:btc_dominance_pct")
        rd = ctx.metric_ref("CRYPTO:btc_dominance_pct")
        refs.append(rd)
        if dom:
            facts["btc_dominance"] = dom[-1][1]
            ch = _change(dom, 6)
            if ch is not None and abs(ch) > 0.5:
                facts["btc_dominance_change"] = round(ch, 2)
                favourable = (ch > 0) == (base == "BTC")
                score += 1 if favourable else -1
                (sup if favourable else opp).append(inference(f"BTC dominance changed {ch:+.2f}pp recently, {'favouring' if favourable else 'against'} {base} relative strength", rd))
        tvl = ctx.metric_history("DEFI:total_tvl")
        rt = ctx.metric_ref("DEFI:total_tvl")
        refs.append(rt)
        pt = _pct_change(tvl, 7)
        if pt is not None:
            facts["defi_tvl_change_7d"] = round(pt, 4)
            if abs(pt) > 0.03:
                score += 1 if pt > 0 else -1
            (sup if pt > 0 else opp).append(fact(f"Total DeFi TVL {pt:+.2%} over 7 days", rt))
        return sup, opp, refs, facts, score

    def assumptions(self):
        return ["No consensus valuation model exists for crypto assets; no fair value is estimated."]


class OnChainAnalyst(_ContextAgent):
    role = "onchain"
    prompt_name = "onchain"
    required = ("STABLECOINS:total_supply_usd_pegged", "DEFI:total_tvl")
    unavailable_by_design = ("exchange inflows/outflows (requires attributed on-chain data; none configured)",
                             "active addresses, holder distribution, miner flows (no free verified source configured)")

    def gather(self, ctx):
        sup, opp, refs, facts, score = [], [], [], {}, 0
        st = ctx.metric_history("STABLECOINS:total_supply_usd_pegged")
        rs = ctx.metric_ref("STABLECOINS:total_supply_usd_pegged")
        refs.append(rs)
        ps = _pct_change(st, 7)
        if ps is not None:
            facts["stablecoin_supply_change_7d"] = round(ps, 4)
            if abs(ps) > 0.005:
                score += 1 if ps > 0 else -1
            (sup if ps > 0 else opp).append(fact(f"USD-pegged stablecoin supply {ps:+.2%} over 7 days (${st[-1][1]:,.0f})", rs))
            sup.append(Claim(statement="Stablecoin supply growth is treated as a proxy for on-chain dry powder; it does not show where the capital will be deployed.", kind="hypothesis", source_refs=[rs.id]))
        tvl = ctx.metric_history("DEFI:total_tvl")
        rt = ctx.metric_ref("DEFI:total_tvl")
        refs.append(rt)
        pt = _pct_change(tvl, 7)
        if pt is not None:
            facts["tvl_change_7d"] = round(pt, 4)
            (sup if pt > 0 else opp).append(fact(f"DeFi TVL {pt:+.2%} over 7 days", rt))
        return sup, opp, refs, facts, score


class FlowAnalyst(_ContextAgent):
    role = "flow"
    prompt_name = "flow"
    unavailable_by_design = ("verified large-transaction (whale) feed: none configured; no wallet attribution is made",
                             "order-book depth and liquidation data: not ingested")

    def gather(self, ctx):
        sym = ctx.symbol
        self.required = (f"{sym}:funding_rate", f"{sym}:open_interest")
        sup, opp, refs, facts, score = [], [], [], {}, 0
        fr = ctx.metric_value(f"{sym}:funding_rate")
        rf = ctx.metric_ref(f"{sym}:funding_rate")
        refs.append(rf)
        if fr is not None:
            facts["funding_rate_8h"] = fr
            if fr > 0.0005:
                score -= 1
                opp.append(inference(f"Funding {fr:.4%}/8h is elevated: longs are crowded and pay to hold (squeeze risk)", rf))
            elif fr < -0.0003:
                score += 1
                sup.append(inference(f"Funding {fr:.4%}/8h is negative: shorts are crowded (short-squeeze potential)", rf))
            else:
                sup.append(fact(f"Funding {fr:.4%}/8h is in a neutral range", rf))
        oi = ctx.metric_history(f"{sym}:open_interest")
        ro = ctx.metric_ref(f"{sym}:open_interest")
        refs.append(ro)
        po = _pct_change(oi, min(len(oi) - 1, 12)) if len(oi) > 1 else None
        if po is not None:
            facts["open_interest_change"] = round(po, 4)
            (sup if abs(po) < 0.1 else opp).append(fact(f"Open interest changed {po:+.2%} across the stored observations", ro))
            if po > 0.1 and fr is not None and fr > 0.0003:
                opp.append(inference("Rising OI with positive funding suggests leveraged long build-up", ro, rf))
        return sup, opp, refs, facts, score
