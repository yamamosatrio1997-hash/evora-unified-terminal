"""Quant Researcher: decides whether a testable, out-of-sample edge exists."""
from __future__ import annotations

from datetime import datetime

from app.agents.base import Agent, DebateContext, inference
from app.agents.schemas import AgentOutput, Claim, SourceRef
from app.quant.metrics import MIN_TRADES_FOR_INFERENCE
from app.quant.service import run_backtest_job, summarize_run

# The Technical Analyst's setup (aligned EMA trend, ATR stop, 2R target) belongs to
# the trend-following family; it is tested with the matching rule set.
STRATEGY_FOR_IDEA = "ema_trend"


class QuantResearcher(Agent):
    role = "quant"

    def analyze(self, ctx: DebateContext) -> AgentOutput:
        tech = ctx.outputs.get("technical")
        built_at = datetime.fromisoformat(ctx.content["built_at"])
        run = run_backtest_job(ctx.db, STRATEGY_FOR_IDEA, ctx.symbol, "4h", until=built_at,
                               mc_runs=int(ctx.extra.get("mc_runs", 1000)))
        ref = SourceRef(id=f"backtest:{run.id}", source=f"backtest({run.dataset_kind})",
                        observed_at=run.data_end.isoformat() if run.data_end else None,
                        note=f"{run.strategy} {run.symbol} {run.interval}; data {run.data_source}")
        summary = summarize_run(run)
        base = dict(source_references=[ref], metrics={"backtest": summary},
                    assumptions=["Costs: 5 bps taker fee and 3 bps slippage per side, constant funding 0.01%/8h.",
                                 "Results are BACKTEST results, distinct from paper or live performance."])
        if run.status != "completed":
            return self.base_output(
                ctx, status="insufficient_data", stance="no_view", confidence=0.0,
                conclusion=f"No quantitative validation possible: {run.error or run.status}.",
                uncertainty="Edge is untested.", missing_data=[f"historical 4h candles: {run.error}"],
                recommended_next_action="Backfill at least 500 4h candles and rerun.", **base)
        oos = summary["oos"]
        wf = (run.results.get("walk_forward") or {}).get("aggregate_oos") or {}
        warnings = summary["warnings"]
        trades = oos.get("trades") or 0
        exp_r = oos.get("expectancy_r")
        wf_r = wf.get("expectancy_r")
        sup: list[Claim] = []
        opp: list[Claim] = []
        stmt = (f"Out-of-sample: {trades} trades, expectancy {exp_r if exp_r is None else round(exp_r, 3)}R, "
                f"profit factor {oos.get('profit_factor')}, max DD {oos.get('max_drawdown')}")
        (sup if (exp_r or 0) > 0 else opp).append(Claim(statement=stmt, kind="fact", source_refs=[ref.id]))
        if wf_r is not None:
            (sup if wf_r > 0 else opp).append(Claim(statement=f"Walk-forward OOS aggregate: {wf.get('trades')} trades, expectancy {wf_r:.3f}R, {wf.get('profitable_folds')}/4 folds profitable", kind="fact", source_refs=[ref.id]))
        for w in warnings:
            opp.append(Claim(statement=w, kind="inference", source_refs=[ref.id]))
        if run.dataset_kind == "simulated":
            opp.append(Claim(statement="Backtest ran on SIMULATED data; it says nothing about real markets.", kind="fact", source_refs=[ref.id]))
        blocking = [w for w in warnings if "did not survive" in w or "not positive" in w]
        supported = (trades >= MIN_TRADES_FOR_INFERENCE and (exp_r or 0) > 0 and (wf_r or 0) > 0
                     and not blocking and run.dataset_kind == "historical")
        verdict = "supported" if supported else ("insufficient" if trades < MIN_TRADES_FOR_INFERENCE else "not_supported")
        summary["edge_verdict"] = verdict
        if tech and tech.trade_idea:
            sup.append(inference(f"Tested rule family matches the Technical Analyst's {tech.trade_idea.side} trend setup.", ref))
        return self.base_output(
            ctx, status="completed",
            stance="neutral" if not supported else ("bullish" if tech and tech.trade_idea and tech.trade_idea.side == "long" else "bearish" if tech and tech.trade_idea else "neutral"),
            confidence=0.6 if supported else 0.1,
            conclusion={"supported": "A positive, out-of-sample and walk-forward-consistent edge was measured for this rule family (still subject to regime change).",
                        "insufficient": f"Sample too small ({trades} OOS trades) to establish an edge.",
                        "not_supported": "No robust out-of-sample edge for this rule family; opinion is not quantitative evidence."}[verdict],
            supporting_evidence=sup, opposing_evidence=opp,
            uncertainty=f"OOS win-rate 95% CI {oos.get('win_rate_ci95')}; past performance does not guarantee future results.",
            missing_data=[], recommended_next_action="Proceed to risk review" if supported else "Do not trade on this setup; research alternatives",
            **base,
        )
