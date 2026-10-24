# Comparison with open-source projects

Date: 2026-10-23. Eight repositories were cloned (shallow, outside this repo) and **read only**. None of their code was executed, installed into this project, or copied into it. This document records what each one does, how it compares with Evora, and which *ideas* are worth adopting. Licences decide what may be reused; in every case below the safe default is to re-implement ideas rather than copy code.

| Repository | Licence | What it is | Relevance to Evora |
|---|---|---|---|
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | Apache-2.0 | LangGraph multi-agent equity research: analysts → bull/bear debate → trader → risk debate → portfolio manager | **High** (closest design peer) |
| [HKUDS/AI-Trader](https://github.com/HKUDS/AI-Trader) | **No LICENSE file** (README badge says MIT, file missing → all rights reserved) | Social/paper-trading platform for *external* agents; no built-in debate | Medium (ledger ideas only) |
| [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | MIT | Chat-driven research + backtest agent, YAML "swarm" task graphs, pixel office page | Medium |
| [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal) | **AGPL-3.0 + commercial-use notice** (README contradicts it) | Qt/C++ Bloomberg-style desktop terminal, 37 persona agents, "Alpha Arena" | Medium (UI ideas only) |
| [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) | **GPL-3.0** | Mature crypto trading bot: backtester, hyperopt, protections, Telegram | High for quant/risk ideas, **no code reuse** |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | Apache-2.0 | HTML/WebGL → deterministic MP4 renderer (Puppeteer + FFmpeg) | Medium (marketing video tooling) |
| [mksglu/context-mode](https://github.com/mksglu/context-mode) | Elastic-2.0 (not OSI) | Claude Code / MCP plugin that keeps tool output out of the coding agent's context | Low at runtime |
| [Anil-matcha/Open-Generative-AI](https://github.com/Anil-matcha/Open-Generative-AI) | MIT (submodules unverified) | Front end for the paid MuAPI image/video aggregator | Low (marketing art only) |

## Where Evora already differs

None of the eight has a **deterministic, veto-capable risk engine** that sits outside the LLMs. TradingAgents' risk team is an LLM debate with free-text position sizing, AI-Trader only checks ledger balances, Fincept's Alpha Arena caps leverage/notional, and freqtrade sizes by stake split rather than risk per trade. Evora's 3% planned-risk ceiling (Decimal arithmetic, config cannot raise it), immutable hashed risk decisions and non-overridable veto remain its main safety property. The comparison does not change that design.

Evora also enforces things the peers mostly leave to prompts: every agent "fact" must cite an id in one hashed snapshot, the Fund Manager is a sequence of gates (not a vote), and live execution is a code constant that refuses submission.

## Ideas worth adopting (re-implemented, not copied)

Ordered by value for this system. None is implemented in this change unless stated.

1. **Look-ahead and warm-up bias checker** (freqtrade `lookahead-analysis` / `recursive-analysis`). Re-run each strategy on truncated data and with different warm-up lengths; reject it if past signals or indicators change. Evora has causality unit tests; an automated per-strategy gate before validation would be stronger.
2. **Protections as time-boxed locks** (freqtrade `StoplossGuard`, `MaxDrawdown`, `CooldownPeriod`). Global or per-symbol locks with a lookback and a duration, checked by the Risk Engine before every proposal. Complements the existing daily-loss and drawdown limits.
3. **Numeric grounding gate** (Vibe-Trading). Every number in a final answer must trace to a tool result. Evora checks citation ids; checking the numbers themselves against snapshot values would close the remaining gap.
4. **Decision memory and reflection** (TradingAgents `memory/`). Settle past decisions against realised outcomes and feed the lessons to the Critical Reviewer and Fund Manager. Must stay out of the deterministic gates.
5. **Per-agent scorecards** (AI-Trader signal-quality scoring, Fincept Alpha Arena leaderboard). Score each agent's recorded stances against what happened, with sample size, so users can see which specialist has been useful. No profit claims.
6. **Retrieval instead of prompt stuffing** (context-mode pattern). Index raw snapshot items and let each agent retrieve the top-k cited snippets, to cut LLM tokens while keeping citations.
7. **Server-authoritative paper fills** (AI-Trader price guard). Already true in Evora (fills use stored prices, not agent input); keep it that way.
8. **Hyperliquid public info API** as a keyless crypto price/perps source (AI-Trader). Worth adding as a second market-data source for cross-checking Binance, which is also listed as a known gap in the readiness report.

## Things deliberately not adopted

- **LLM-only risk and sizing** (TradingAgents). Incompatible with a hard 3% ceiling and veto.
- **Hyperopt as validation** (freqtrade). Many in-sample trials with cosmetic filters overfit; Evora keeps IS/validation/OOS, walk-forward and Monte Carlo as the bar.
- **Fill-at-any-price-inside-the-candle without slippage** (freqtrade). Evora keeps next-bar-open fills plus fees, slippage and funding.
- **Persona agents** ("Buffett", "Bridgewater") (Fincept) and **social/copy-trading layers** (AI-Trader). Prompt theatre and engagement mechanics that add no evidence.
- **Remote SKILL.md bootstrapping** (AI-Trader). Agents fetching instructions from a third-party URL is a prompt-injection and supply-chain risk.
- **Any code from GPL/AGPL/unlicensed repos** (freqtrade, Fincept, AI-Trader).

## Visualization: what the peers show, and what Evora's 3D office does

| Project | Agent visualization |
|---|---|
| TradingAgents | Rich terminal dashboard (agent status table, message log) |
| Vibe-Trading | SSE-driven per-agent status rows; a CSS "Pixel Office" that is a manual task board with no communication shown |
| FinceptTerminal | Node-editor canvas, transcript view, leaderboard cards; no avatars |
| AI-Trader | Leaderboards and feeds (Recharts) |
| Others | None |

Public UI references for agent "offices" (AI Office, The Delegation, Pixel Agents, Star Office UI) share four patterns: location encodes state, click to inspect, a 3D/pixel scene paired with a precise list or graph, and ambient idle motion. Evora's 3D office (`frontend/src/components/office3d/`) applies the first three and limits ambient motion to decor (server LEDs, breathing) so that **work-related motion still only happens on real backend events**:

- **Rooms**: Research Wing (five analyst desks), Debate Room (round table with a hologram), Quant Lab, Risk Vault, Review Booth, Fund Manager office, Data Center.
- **AI employees**: one voxel body shape for all nine, coloured like the 2D mascots; they type, blink, and walk to the debate table during rounds 2–4 of a running debate.
- **Communication effects**: a dashed arc with travelling packets and an arrival ping for each `debate.message` (colour by kind), data packets from the Data Center while ingestion or analysis runs, a red shockwave and vault alarm on a veto, a spotlight and decision card on `debate.finished`.
- **Interaction**: orbit/zoom, camera presets, "follow the debate" camera, hover tooltips, click an employee (or its HUD chip) to open the agent drawer, and a persistent 3D/2D toggle.
- **Fallback**: the original 2D pixel floor is shown when WebGL is unavailable, when the viewer prefers reduced motion, or on request. The scene is lazy-loaded so it does not slow the first paint.

On the homepage the same scene runs a **scripted illustration**, labelled as such, of two debate cycles: one ending in WAIT FOR CONFIRMATION and one ending in a risk veto.

**hyperframes** could replace the current screen-capture method for marketing videos with frame-exact rendering, but only with a separate deterministic "film mode" (seeded data, a timeline driven by `seekFrame`, no wall-clock time). That has not been built.
