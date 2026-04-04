# Paper Trading

Test champions in real-time conditions without real money. Measure slippage, frequency, drawdown, stability.

## Modules

| Module | Role |
|--------|------|
| **paperBroker.js** | Simulated broker: open/close positions, track cash. |
| **paperPortfolio.js** | Load/save state and equity curve (paper_trading_state.json, paper_equity_curve.json). |
| **paperExecution.js** | On champion signal → open position; on bar → check stop/target, close if hit; log to paper_trade_log.json. |
| **runPaperSession.js** | CLI: reset, replay candles, or show status. |

## Flow

1. A champion signal arrives (e.g. from webhook or replay).
2. **executionGate** checks that setupId is in the champion registry.
3. **paperExecution.executeSignal(signal)** opens a paper position (paperBroker).
4. On each bar (or tick), **paperExecution.checkStopsTargets(bar)** closes positions when stop or target is hit.
5. Results are written to paper_trade_log.json and state to paper_trading_state.json; equity curve to paper_equity_curve.json.

## Output files (in data root `paper/`)

- **paper_trading_state.json** — cash, open positions.
- **paper_trade_log.json** — every open/close with pnl.
- **paper_equity_curve.json** — time series of equity (for drawdown/stability).

## Usage

```bash
# Reset state to initial cash
node engine/paper/runPaperSession.js --reset

# Replay a CSV/JSON and run stop/target checks (no new signals, only closes)
node engine/paper/runPaperSession.js --replay /path/to/spy_5m.csv

# Show status
node engine/paper/runPaperSession.js
```

## Genetic → Paper loop

Champions from the champion registry are the only setups allowed to open paper positions (`isChampionAllowed` in paperExecution). After nightly **discovery → evolution → champion registry update**, run paper session; it will use the updated allowlist. To force reload of the registry after a run, use:

```bash
node engine/paper/runPaperSession.js --reload-champions
```

## Supported symbols

SPY, QQQ, BTCUSDT, XAUUSD (and any symbol in champion signals). Paper broker does not validate symbol; use liveRiskGate in live execution for that.
