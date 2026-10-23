# Live trading gates

Live trading is **disabled**, and enabling it is deliberately more than a configuration change:

- `LIVE_TRADING_ENABLED=true` makes the backend refuse to start.
- `app/exchange/execution.py` has `LIVE_EXECUTION_IMPLEMENTED = False`, and `submit()` raises before any network call. No order-placement endpoint is implemented in the MEXC client.

Do not change either of these until **every** item below is satisfied and recorded:

1. **Explicit written authorization** from the account owner for live trading, separate from this project's build authorization.
2. **Paper-trading validation**: a pre-registered evaluation period (for example 3 months and at least 50 closed paper trades), with acceptance criteria fixed in advance, met on paper results only, not on backtests.
3. **Contract-specific risk verification**: specs loaded from the exchange (`parse_contract_spec`), with sizing compared by hand against the exchange's own calculator for each traded contract, including fees, funding and the liquidation formula.
4. **Order lifecycle**: submit, cancel, and query-by-client-order-id implemented, with `reconcile()` exercised against the exchange's testnet or minimum-size orders, including partial fills, rejects, timeouts and unknown status.
5. **Emergency stop tested end-to-end**: engaging it blocks new orders and cancels open ones on the exchange.
6. **Security review**: key permissions (no withdrawal), IP restriction, secret storage, access control, audit trail.
7. **Operational readiness**: monitoring and alerting on fills and reconciliation drift, plus a documented manual kill procedure.
8. **Risk acknowledgement**: realized losses can exceed planned risk (gaps, slippage, liquidation, outages, execution failures).

If any safeguard is missing or fails, the system stays in paper mode.
