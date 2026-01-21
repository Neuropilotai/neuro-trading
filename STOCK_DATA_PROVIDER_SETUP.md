# Stock Data Provider Setup

## Current Status

The learning system successfully processes **crypto symbols** (BTCUSDT, ETHUSDT, SOLUSDT) using Binance API, but **stock symbols** (SPY, QQQ, AAPL, TSLA, NVDA) require CSV files that don't exist yet.

## Options for Stock Data

### Option 1: Local CSV Files (Current)

**Pros:** Free, offline, full control  
**Cons:** Manual data collection required

**Setup:**
1. Export OHLCV data from TradingView or your broker
2. Save as CSV in `data/csv/<SYMBOL>_<TIMEFRAME>.csv`
3. Format: `timestamp,open,high,low,close,volume` (one per line)

**Example:**
```csv
1704067200000,450.25,451.50,449.80,450.90,1250000
1704070800000,450.90,452.10,450.50,451.75,980000
```

### Option 2: Alpha Vantage API (Recommended - Free Tier)

**Pros:** Free API key, reliable, good for stocks  
**Cons:** Rate limited (5 calls/min, 500/day)

**Setup:**
1. Get free API key: https://www.alphavantage.co/support/#api-key
2. Add to `.env`:
   ```bash
   ALPHA_VANTAGE_API_KEY=your-api-key
   ```
3. Update `config/tradingview_universe.json`:
   ```json
   "providerMapping": {
     "stocks": "alpha_vantage"
   }
   ```

**Implementation:** Would need to create `alphaVantageProvider.js`

### Option 3: Polygon.io (Paid - Most Reliable)

**Pros:** Professional-grade, high rate limits, real-time  
**Cons:** Paid service ($29/month starter)

**Setup:**
1. Sign up: https://polygon.io/
2. Add to `.env`:
   ```bash
   POLYGON_API_KEY=your-api-key
   ```
3. Update provider mapping to use Polygon

### Option 4: IEX Cloud (Free Tier Available)

**Pros:** Free tier (50k calls/month), reliable  
**Cons:** Requires registration

**Setup:**
1. Sign up: https://iexcloud.io/
2. Add to `.env`:
   ```bash
   IEX_CLOUD_API_KEY=your-api-key
   ```

## Quick Fix: Skip Stocks for Now

If you only want to learn from crypto patterns, update `config/tradingview_universe.json`:

```json
{
  "symbols": [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT"
  ]
}
```

This will skip stocks and only process crypto symbols that work with Binance.

## Recommended Approach

For immediate use:
1. **Crypto:** Already working with Binance ✅
2. **Stocks:** Either:
   - Remove from universe (focus on crypto)
   - Add CSV files manually
   - Implement Alpha Vantage provider (free tier)

## Next Steps

1. **If focusing on crypto:** Remove stock symbols from config
2. **If need stocks:** Choose a provider and I can implement it
3. **For now:** System gracefully skips symbols without data (no errors)

---

**Current Status:** Crypto symbols working ✅ | Stock symbols need data provider ⚠️


