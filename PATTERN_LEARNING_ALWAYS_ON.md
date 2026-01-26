# Pattern Learning Always-On System

## Overview

Production-ready, always-on pattern learning pipeline for macOS (Apple Silicon M3). Continuously learns from historical OHLCV data aligned with TradingView symbols/timeframes, stores patterns in Google Drive, and runs as a resilient daemon.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Always-On Learning Pipeline                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Config (tradingview_universe.json)                          │
│    ↓                                                          │
│  Data Providers (Binance, OANDA, Local CSV)                  │
│    ↓                                                          │
│  OHLCV Cache (local JSONL)                                   │
│    ↓                                                          │
│  Pattern Learning Engine                                     │
│    ├─ Feature Extraction                                     │
│    ├─ Pattern Detection                                       │
│    └─ Deduplication                                           │
│    ↓                                                          │
│  Google Drive (Primary Storage)                              │
│    └─ Local Cache (Backup)                                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## TradingView Alignment

The system uses the same symbols and timeframes as your TradingView charts:

- **Symbols:** Defined in `config/tradingview_universe.json` or `config/tradingview_watchlist.txt`
- **Timeframes:** 1, 5, 15, 60, 240, D (TradingView format)
- **Data Source:** OHLCV from exchange/broker APIs (not TradingView)
- **UI:** TradingView remains the visualization tool

## Quick Start

### 1. Configure Environment

Add to `.env`:
```bash
ENABLE_PATTERN_LEARNING=true
ENABLE_GOOGLE_DRIVE_SYNC=true
GOOGLE_DRIVE_CLIENT_ID=your-id
GOOGLE_DRIVE_CLIENT_SECRET=your-secret
GOOGLE_DRIVE_REFRESH_TOKEN=your-token
LEARN_CONCURRENCY=4
LEARN_INTERVAL_MINUTES=5
```

### 2. Configure Universe

Edit `config/tradingview_universe.json`:
```json
{
  "symbols": ["BTCUSDT", "ETHUSDT", "SPY"],
  "timeframes": ["5", "15", "60"]
}
```

Or create `config/tradingview_watchlist.txt`:
```
BTCUSDT
ETHUSDT
SPY
```

### 3. Backfill History

```bash
./scripts/learn_backfill.sh
```

This will:
- Fetch historical OHLCV for all symbols/timeframes
- Extract initial patterns
- Save to Google Drive and local cache

### 4. Start Daemon

```bash
./scripts/start_learning_daemon.sh
```

The daemon will:
- Run continuously
- Process new candles every 5 minutes (configurable)
- Extract patterns incrementally
- Sync to Google Drive automatically

### 5. Check Status

```bash
# Check daemon status
./scripts/status_learning_daemon.sh

# Check health endpoint
curl http://localhost:3014/learn/health | jq

# Check detailed status
curl http://localhost:3014/learn/status | jq
```

## Commands

### Daemon Management

```bash
# Start daemon
./scripts/start_learning_daemon.sh

# Stop daemon
./scripts/stop_learning_daemon.sh

# Check status
./scripts/status_learning_daemon.sh
```

### One-Command Operations

```bash
# Backfill historical data
./scripts/learn_backfill.sh

# Run one learning cycle
./scripts/learn_once.sh

# Daily maintenance (prune, compact, metrics)
./scripts/learn_daily_maintenance.sh
```

## File Structure

```
neuro-pilot-ai/
├── config/
│   ├── tradingview_universe.json      # Symbol/timeframe config
│   └── tradingview_watchlist.txt       # Optional watchlist
├── backend/
│   ├── services/
│   │   ├── patternLearningEngine.js    # Core learning engine
│   │   ├── learningDaemon.js           # Always-on daemon
│   │   ├── marketDataProvider.js       # Provider interface
│   │   ├── providers/
│   │   │   ├── binanceProvider.js      # Binance OHLCV
│   │   │   └── localCsvProvider.js     # Local CSV
│   │   ├── ohlcvCache.js               # Local candle cache
│   │   ├── checkpointManager.js        # Processing checkpoints
│   │   └── universeLoader.js           # Config loader
│   └── scripts/
│       ├── backfillHistory.js          # Backfill script
│       ├── runOnce.js                   # Single cycle
│       └── dailyMaintenance.js          # Maintenance
├── scripts/
│   ├── start_learning_daemon.sh         # Start daemon
│   ├── stop_learning_daemon.sh          # Stop daemon
│   ├── status_learning_daemon.sh        # Check status
│   ├── learn_backfill.sh                # Backfill command
│   ├── learn_once.sh                    # Single cycle command
│   └── learn_daily_maintenance.sh       # Maintenance command
└── data/
    ├── ohlcv/                           # Cached candles (JSONL)
    │   └── <symbol>/
    │       └── <timeframe>.jsonl
    ├── checkpoints/                     # Processing checkpoints
    │   └── <symbol>_<timeframe>.json
    ├── logs/
    │   └── learning.log                 # Daemon logs
    ├── metrics/                          # Metrics snapshots
    │   └── metrics_<timestamp>.json
    └── pids/
        └── learning.pid                 # Daemon PID
```

## API Endpoints

### Health Check
```bash
GET /learn/health
```
Returns: Status, last run, pattern count

### Detailed Status
```bash
GET /learn/status
```
Returns: Daemon status, engine stats, Google Drive sync, errors

**Heartbeat System:**
The daemon writes a heartbeat file (`data/learning/heartbeat.json`) on startup and after every learning cycle. This ensures accurate status reporting:

- **Location:** `data/learning/heartbeat.json`
- **Written:** On startup, after each cycle (success or error)
- **Atomic Write:** Uses temp file then rename to prevent partial reads
- **Fields:**
  - `pid` - Process ID
  - `startedAt` - Daemon start timestamp
  - `lastCycleAt` - Last cycle completion timestamp
  - `candlesProcessed` - Candles processed in last cycle
  - `patternsFound` - Patterns found in last cycle
  - `patternsTotal` - Total patterns in bank
  - `storageMode` - GOOGLE_DRIVE_PRIMARY or LOCAL_CACHE
  - `googleDriveEnabled` - Drive sync status
  - `errorCount` - Total error count
  - `lastError` - Last error (if any)

The `/learn/status` endpoint:
1. Reads heartbeat file for accurate metrics
2. Checks PID liveness using `process.kill(pid, 0)`
3. Returns `running=true` when daemon is actually alive
4. Returns `lastCycleAt` from heartbeat (not null)

**Verification:**
```bash
# Check heartbeat file
cat data/learning/heartbeat.json | jq .

# Verify status accuracy
./scripts/verify_daemon_status.sh

# Check status endpoint
curl http://localhost:3014/learn/status | jq .daemon
```

### Latest Metrics
```bash
GET /learn/metrics/latest
```
Returns: Latest metrics snapshot JSON

## Data Flow

### 1. Configuration
- Load `tradingview_universe.json`
- Merge with `tradingview_watchlist.txt` if present
- Determine provider for each symbol

### 2. Data Ingestion
- Fetch OHLCV from provider (Binance, OANDA, CSV)
- Cache locally in `data/ohlcv/<symbol>/<timeframe>.jsonl`
- Rate limiting and exponential backoff

### 3. Pattern Extraction
- Load cached candles
- Compute features (volatility, ATR, trend, volume)
- Detect patterns (breakout, mean reversion, momentum, etc.)
- Generate pattern signatures for deduplication

### 4. Pattern Storage
- **Primary:** Google Drive (`TradingPatterns/pattern_bank.json`)
- **Backup:** Local cache (`data/patterns.json`)
- Atomic writes (temp file → rename)

### 5. Incremental Processing
- Checkpoint tracks last processed candle
- Only process new candles since checkpoint
- Update checkpoint after each batch

## Pattern Types Detected

1. **Breakout Up/Down** - Price breaks above/below range
2. **Mean Reversion** - Price returns to average
3. **Momentum Burst** - Volume spike with price movement
4. **Volatility Expansion** - Sudden increase in volatility
5. **Support/Resistance Touch** - Price touches key levels

## M3 Optimization

- **Concurrency:** 4 parallel workers (tuned for M3)
- **Memory:** Bounded queues, efficient data structures
- **CPU:** Non-blocking I/O, worker threads for heavy computation
- **Storage:** Atomic writes, efficient JSONL format

## Google Drive Integration

### Primary Storage
- Patterns stored in Google Drive first
- Local cache as backup
- Automatic sync on every save

### Folder Structure
```
TradingPatterns/
├── pattern_bank.json          # Consolidated bank
├── PATTERN_1234567890.json    # Individual patterns
└── ...
```

### Sync Strategy
- **On Save:** Immediate sync to Google Drive
- **On Load:** Load from Google Drive first, fallback to cache
- **Retry:** Automatic retry on transient failures

## Troubleshooting

### Google Drive Auth Issues

**Problem:** `Google Drive credentials not configured`

**Solution:**
1. Create Google Cloud Project
2. Enable Google Drive API
3. Create OAuth 2.0 credentials
4. Get refresh token
5. Add to `.env`:
   ```bash
   GOOGLE_DRIVE_CLIENT_ID=...
   GOOGLE_DRIVE_CLIENT_SECRET=...
   GOOGLE_DRIVE_REFRESH_TOKEN=...
   ```

### Provider Rate Limits

**Problem:** `Rate limit exceeded` or `429 Too Many Requests`

**Solution:**
- System includes automatic rate limiting
- Exponential backoff on errors
- Reduce `LEARN_CONCURRENCY` if needed
- Check provider-specific limits

### Missing Candles

**Problem:** Gaps in OHLCV data

**Solution:**
- Check provider API status
- Verify symbol is valid for provider
- Check network connectivity
- Review logs: `data/logs/learning.log`

### Pattern Bank Conflicts

**Problem:** Patterns not syncing correctly

**Solution:**
- System uses atomic writes (temp → rename)
- Deduplication prevents duplicates
- Check Google Drive permissions
- Verify `ENABLE_GOOGLE_DRIVE_SYNC=true`

### Daemon Not Starting

**Problem:** Daemon fails to start

**Solution:**
1. Check logs: `data/logs/daemon.log`
2. Verify environment variables
3. Check if port 3014 is available
4. Verify Node.js version (20+)
5. Check disk space

## Recommended Defaults for M3

```bash
LEARN_CONCURRENCY=4              # 4 parallel workers
LEARN_INTERVAL_MINUTES=5         # Process every 5 minutes
LEARN_RETENTION_DAYS=90         # Keep patterns for 90 days
LEARN_BACKFILL_BARS_5=5000      # 5min: 5000 bars (~17 days)
LEARN_BACKFILL_BARS_15=3000     # 15min: 3000 bars (~31 days)
```

## Monitoring

### Logs
- **Daemon:** `data/logs/daemon.log`
- **Learning:** `data/logs/learning.log`

### Metrics
- **Snapshots:** `data/metrics/metrics_<timestamp>.json`
- **API:** `GET /learn/metrics/latest`

### Health Checks
```bash
# Quick health check
curl http://localhost:3014/learn/health

# Detailed status
curl http://localhost:3014/learn/status

# Pattern stats
curl http://localhost:3014/api/patterns/stats
```

## Safety Features

✅ **Idempotent Writes** - Safe to retry  
✅ **Deduplication** - No duplicate patterns  
✅ **Atomic Saves** - Temp file → rename  
✅ **Checkpoint Recovery** - Resume from last processed candle  
✅ **Error Handling** - Graceful degradation  
✅ **Rate Limiting** - Respects API limits  
✅ **Offline Mode** - Works with local cache if Drive fails  

## Next Steps

1. **Configure universe** - Edit `config/tradingview_universe.json`
2. **Set up Google Drive** - Add credentials to `.env`
3. **Run backfill** - `./scripts/learn_backfill.sh`
4. **Start daemon** - `./scripts/start_learning_daemon.sh`
5. **Monitor** - Check status and metrics regularly

---

**Status:** ✅ Production Ready  
**Platform:** macOS (Apple Silicon M3)  
**Storage:** Google Drive (Primary) + Local Cache (Backup)


