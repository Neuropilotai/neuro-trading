# Learning System File Tree

## New Files Created

```
neuro-pilot-ai/
├── config/
│   ├── tradingview_universe.json          # D1: TradingView-aligned config
│   └── tradingview_watchlist.txt.example   # Optional watchlist template
│
├── backend/
│   ├── services/
│   │   ├── universeLoader.js               # D1: Config loader
│   │   ├── marketDataProvider.js           # D2: Provider interface
│   │   ├── providerFactory.js              # D2: Provider factory
│   │   ├── providers/
│   │   │   ├── binanceProvider.js          # D2: Binance OHLCV
│   │   │   └── localCsvProvider.js          # D2: Local CSV
│   │   ├── ohlcvCache.js                   # D2: Candle cache manager
│   │   ├── checkpointManager.js            # D3: Processing checkpoints
│   │   ├── patternLearningEngine.js        # D3: Core learning engine
│   │   └── learningDaemon.js               # D4: Always-on daemon
│   │
│   └── scripts/
│       ├── backfillHistory.js               # D5: Backfill script
│       ├── runOnce.js                       # D5: Single cycle
│       └── dailyMaintenance.js              # D5: Daily maintenance
│
├── scripts/
│   ├── start_learning_daemon.sh             # D4: Start daemon
│   ├── stop_learning_daemon.sh              # D4: Stop daemon
│   ├── status_learning_daemon.sh            # D4: Check status
│   ├── learn_backfill.sh                    # D5: Backfill command
│   ├── learn_once.sh                        # D5: Single cycle
│   └── learn_daily_maintenance.sh           # D5: Daily maintenance
│
├── data/
│   ├── ohlcv/                               # Cached candles (JSONL)
│   │   └── <symbol>/
│   │       └── <timeframe>.jsonl
│   ├── checkpoints/                         # Processing checkpoints
│   │   └── <symbol>_<timeframe>.json
│   ├── logs/
│   │   └── learning.log                     # Daemon logs
│   ├── metrics/                              # Metrics snapshots
│   │   └── metrics_<timestamp>.json
│   └── pids/
│       └── learning.pid                     # Daemon PID
│
└── Documentation/
    ├── PATTERN_LEARNING_ALWAYS_ON.md        # D7: Complete guide
    ├── LEARNING_ENV_VARS.md                 # D8: Environment variables
    └── LEARNING_SYSTEM_FILE_TREE.md         # This file
```

## Modified Files

```
simple_webhook_server.js                     # D6: Added /learn/* endpoints
```

## Commands to Run

### Initial Setup
```bash
# 1. Configure environment
# Edit .env and add learning variables (see LEARNING_ENV_VARS.md)

# 2. Configure universe
# Edit config/tradingview_universe.json or create config/tradingview_watchlist.txt

# 3. Backfill history
./scripts/learn_backfill.sh

# 4. Start daemon
./scripts/start_learning_daemon.sh
```

### Daily Operations
```bash
# Check status
./scripts/status_learning_daemon.sh

# Run single cycle
./scripts/learn_once.sh

# Daily maintenance (schedule via cron)
./scripts/learn_daily_maintenance.sh
```

### Monitoring
```bash
# Health check
curl http://localhost:3014/learn/health | jq

# Detailed status
curl http://localhost:3014/learn/status | jq

# Latest metrics
curl http://localhost:3014/learn/metrics/latest | jq

# Pattern stats
curl http://localhost:3014/api/patterns/stats | jq
```

## Data Flow

1. **Config** → `universeLoader.js` loads symbols/timeframes
2. **Provider** → `providerFactory.js` selects data provider
3. **Fetch** → Provider fetches OHLCV from exchange/API
4. **Cache** → `ohlcvCache.js` stores candles locally (JSONL)
5. **Checkpoint** → `checkpointManager.js` tracks last processed
6. **Extract** → `patternLearningEngine.js` extracts patterns
7. **Dedupe** → Patterns deduplicated by signature
8. **Save** → Patterns saved to Google Drive + local cache
9. **Daemon** → `learningDaemon.js` runs continuously

## Storage Locations

- **OHLCV Cache:** `data/ohlcv/<symbol>/<timeframe>.jsonl`
- **Checkpoints:** `data/checkpoints/<symbol>_<timeframe>.json`
- **Patterns (Primary):** Google Drive `TradingPatterns/pattern_bank.json`
- **Patterns (Backup):** `data/patterns.json`
- **Logs:** `data/logs/learning.log`
- **Metrics:** `data/metrics/metrics_<timestamp>.json`


