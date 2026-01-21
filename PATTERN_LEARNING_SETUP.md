# Pattern Learning System Setup Guide

## Overview

The Pattern Learning System is an advanced AI-powered feature that learns from historical trades and identifies repeating market patterns. It includes specialized learning agents, Google Drive integration for pattern storage, and real-time pattern matching.

## Features

✅ **Pattern Recognition** - Detects repeating patterns in price action  
✅ **Timeframe-Specific Learning** - Focus on 5min and 15min opening patterns  
✅ **Specialized Learning Agents** - Opening, Reversal, Support/Resistance agents  
✅ **Google Drive Integration** - Cloud storage for pattern bank  
✅ **Pattern Matching** - Real-time matching of current market to historical patterns  
✅ **Continuous Learning** - Improves with every trade

## Setup

### 1. Enable Pattern Recognition

Add to your `.env` file:

```bash
# Pattern Recognition
ENABLE_PATTERN_RECOGNITION=true
ENABLE_PATTERN_LEARNING_AGENTS=true

# Google Drive Sync (optional)
ENABLE_GOOGLE_DRIVE_SYNC=false  # Set to true if you want cloud sync
```

### 2. Google Drive Setup (Required - Primary Storage)

**Google Drive is now the PRIMARY storage location** (replaces local TradingDrive):

1. **Create Google Cloud Project:**
   - Go to https://console.cloud.google.com/
   - Create a new project
   - Enable Google Drive API

2. **Create OAuth Credentials:**
   - Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
   - Application type: "Desktop app"
   - Download credentials JSON

3. **Get Refresh Token:**
   ```bash
   # Install googleapis
   npm install googleapis
   
   # Run auth script (create this script to get refresh token)
   node scripts/get_google_drive_token.js
   ```

4. **Add to `.env` (REQUIRED for pattern storage):**
   ```bash
   # Google Drive is PRIMARY storage (required)
   ENABLE_GOOGLE_DRIVE_SYNC=true
   GOOGLE_DRIVE_CLIENT_ID=your-client-id
   GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret
   GOOGLE_DRIVE_REFRESH_TOKEN=your-refresh-token
   GOOGLE_DRIVE_PATTERNS_FOLDER_ID=optional-folder-id
   ```

**Note:** Without Google Drive configured, patterns will only be stored locally as a cache. Google Drive is recommended for cloud backup and multi-device access.

### 3. Install Dependencies

```bash
# Required for Google Drive (if using)
npm install googleapis
```

## Pattern Types

### Opening Patterns (5min/15min)
- **Opening Gap Up/Down** - Price gaps at market open
- **Opening Range Breakout** - Breakout from first 5/15min range
- **Opening Reversal** - Initial move followed by reversal

### Price Action Patterns
- **Double Top/Bottom** - Reversal patterns
- **Support/Resistance Bounce** - Key level reactions

## API Endpoints

### Get All Patterns
```bash
GET /api/patterns?limit=50&type=opening_range_breakout
```

### Get Pattern by ID
```bash
GET /api/patterns/PATTERN_1234567890
```

### Get Opening Patterns
```bash
GET /api/patterns/opening/5min
GET /api/patterns/opening/15min
```

### Get Pattern Statistics
```bash
GET /api/patterns/stats
```

### Match Current Market to Patterns
```bash
POST /api/patterns/match
Content-Type: application/json

{
  "symbol": "BTCUSDT",
  "timeframe": "5min",
  "marketData": {
    "price": 50000,
    "high": 50100,
    "low": 49900,
    "volume": 1000000,
    "indicators": {
      "rsi": 65,
      "macd": 0.5
    }
  }
}
```

### Sync to Google Drive
```bash
POST /api/patterns/sync
```

## How It Works

### 1. Pattern Detection
When a trade is executed, the system:
- Analyzes price action leading up to the trade
- Detects patterns (opening gaps, breakouts, reversals, etc.)
- Calculates pattern confidence

### 2. Pattern Learning
If the trade is successful:
- Pattern is stored in the pattern bank
- Pattern performance is tracked (win rate, avg PnL)
- Pattern is synced to Google Drive (if enabled)

### 3. Pattern Matching
Before executing new trades:
- System matches current market conditions to historical patterns
- Boosts confidence if similar patterns were successful
- Learning agents provide specialized predictions

### 4. Continuous Improvement
- Patterns improve with more occurrences
- Win rate and confidence adjust based on outcomes
- Agents specialize in different pattern types

## Learning Agents

### Opening Pattern Agent
- Specializes in 5min and 15min opening patterns
- Detects gaps, breakouts, and reversals at market open
- Best for: Day trading, scalping

### Reversal Pattern Agent
- Specializes in reversal patterns (double top/bottom)
- Detects trend reversals
- Best for: Swing trading, position trading

### Support/Resistance Agent
- Specializes in support/resistance bounces
- Detects key level reactions
- Best for: Range trading, breakout trading

## Pattern Storage

### Google Drive (Primary Storage) ☁️
Patterns are stored in Google Drive as the primary storage:
```
TradingPatterns/
├── pattern_bank.json          # Consolidated pattern bank (all patterns)
├── PATTERN_1234567890.json    # Individual pattern files
├── PATTERN_1234567891.json
└── ...
```

### Local Cache (Backup)
Patterns are cached locally for offline access:
```
data/patterns.json             # Local cache backup
```

**Storage Priority:**
1. **Google Drive** - Primary storage (cloud, accessible from anywhere)
2. **Local Cache** - Backup/offline access (fast local access)

## Monitoring

### Check Pattern Stats
```bash
curl http://localhost:3014/api/patterns/stats | jq
```

### View All Patterns
```bash
curl http://localhost:3014/api/patterns?limit=10 | jq
```

### View Opening Patterns
```bash
curl http://localhost:3014/api/patterns/opening/5min | jq
```

## Integration

The pattern learning system is automatically integrated with:
- ✅ Trade execution (learns from every trade)
- ✅ Trading learning service (enhances learning)
- ✅ Dashboard (shows pattern stats)
- ✅ Google Drive (cloud backup)

## Benefits

1. **Continuous Learning** - System improves with every trade
2. **Pattern Reuse** - Share patterns across instances
3. **Backup & Recovery** - Patterns stored in cloud
4. **Specialized Agents** - Different agents for different patterns
5. **Real-Time Matching** - Match current market to historical patterns

## Troubleshooting

### Patterns Not Detecting
- Check `ENABLE_PATTERN_RECOGNITION=true` in `.env`
- Ensure market data includes price, high, low, volume
- Check console logs for pattern detection errors

### Google Drive Sync Not Working
- Verify credentials are correct
- Check `ENABLE_GOOGLE_DRIVE_SYNC=true`
- Ensure Google Drive API is enabled
- Check console logs for sync errors

### Low Pattern Confidence
- Patterns need at least 5 occurrences for reliable confidence
- More successful trades = higher confidence
- Check pattern stats to see win rates

## Next Steps

1. **Enable pattern recognition** in `.env`
2. **Execute some trades** to start learning
3. **Check pattern stats** via API
4. **Optional: Set up Google Drive** for cloud backup
5. **Monitor pattern performance** in dashboard

---

**Status:** ✅ Ready to use  
**Documentation:** See `PATTERN_LEARNING_ARCHITECTURE.md` for detailed architecture

