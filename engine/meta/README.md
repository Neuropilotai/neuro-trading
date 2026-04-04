# Meta Engine — Quant-Type Hedge Fund Architecture

Pipeline extension for multi-market research: cross-asset learning, multi-timeframe robustness, meta-ranking, and champion portfolio.

## Pipeline (full)

```
Dataset → Feature Matrix → Parameter Grid → Fast Vector Scan → Top-K
  → Parallel Backtests → Genetic Evolution
  → Cross-Asset Tests → Multi-Timeframe Tests → Meta Ranking
  → Champion Portfolio → Paper Trading → Live Trading
```

## Modules

| Module | Role |
|--------|-----|
| **crossAssetEvaluator.js** | Test strategy on SPY, QQQ, IWM, BTCUSDT, ETHUSDT; compute `cross_asset_score` (weighted) to reduce overfitting. |
| **timeframeRobustness.js** | Test strategy on 5m, 15m, 1h; compute `timeframe_stability_score`. |
| **metaRankingEngine.js** | Final ranking: `meta_score = expectancy + stability + cross_asset + timeframe + trade_count - drawdown`. |
| **championPortfolioBuilder.js** | Build a portfolio of strategies (allocation weights, expected return); output `strategy_portfolio.json`. |

## Usage

- **Cross-asset**  
  Pass per-asset results (one per asset): `evaluateCrossAssetScore(perAssetResults, weights)` → `{ cross_asset_score, byAsset }`.

- **Timeframe**  
  Pass per-timeframe results: `evaluateTimeframeRobustness(perTimeframeResults)` → `{ timeframe_stability_score, byTimeframe }`.

- **Meta-ranking**  
  After backtest/evolution, add cross_asset_score and timeframe_stability_score to each strategy, then: `computeMetaRanking(strategies, opts)` → array with `meta_score` and `rank`.

- **Portfolio**  
  `buildChampionPortfolio(topStrategies, { maxStrategies: 10 })` → `{ strategies, expected_return, correlation_notes }`.  
  `writePortfolio(portfolio)` writes `discovery/strategy_portfolio.json`.

## Data flow

1. Run two-stage (or batch) **per asset** (SPY 5m, QQQ 5m, …) and **per timeframe** (5m, 15m, 1h) as needed.
2. For each candidate strategy, gather per-asset and per-timeframe results (expectancy, trades, winRate).
3. `evaluateCrossAssetScore` and `evaluateTimeframeRobustness` → attach scores to the strategy.
4. `computeMetaRanking` → rank all strategies.
5. `buildChampionPortfolio` on top N → `writePortfolio`.

## Next (not yet implemented)

- **Live Simulation Engine** — Paper trading 7–30 days (live expectancy, slippage, spread, latency).
- **Feedback loop** — Trade outcomes → feature reinforcement → strategy mutation.
