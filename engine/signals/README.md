# Signal Engine

Read champions, detect signals in real or near real time, score them, send the best to paper then live.

## Flow

```
champion registry
       ↓
signal generator (bar → candidate signals)
       ↓
signal scorer (rank by expectancy / meta_score / winRate)
       ↓
signal queue (optional buffer)
       ↓
signal router → paper execution → live gate
```

## Modules

| Module | Role |
|--------|------|
| **signalGenerator.js** | `generateSignalsFromBar(bar)` / `generateSignalsFromRow(row, context)` — champion rules applied to current bar/row; returns list of signals. |
| **signalQueue.js** | In-memory FIFO queue: `push`, `pop`, `getAll`, `clear`. |
| **signalRouter.js** | `route(signal)` — if champion, send to paper (and optionally live). Uses executionGate + paperExecution. |
| **signalScorer.js** | `scoreSignal(signal)`, `scoreAndRank(signals, { topN })` — score by registry expectancy/meta_score/winRate; return top N. |

## Usage

```js
const { generateSignalsFromBar } = require('./engine/signals/signalGenerator');
const { scoreAndRank } = require('./engine/signals/signalScorer');
const { routeAll } = require('./engine/signals/signalRouter');

const bar = { symbol: 'SPY', timeframe: '5m', open: 500, high: 501, low: 499, close: 500.5, volume: 1e6, time: Date.now() };
const signals = generateSignalsFromBar(bar);
const top = scoreAndRank(signals, { topN: 10 });
const results = routeAll(top.map((t) => t.signal), { mode: 'paper' });
```

## Rules

- Only champion setups generate signals (executionGate).
- Score = f(expectancy, meta_score, winRate) from champion registry.
- Router sends to paper by default; live only when explicitly enabled and risk gate passes.
