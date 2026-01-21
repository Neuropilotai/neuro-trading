# Learning System Environment Variables

Add these to your `.env` file:

```bash
# ===== PATTERN LEARNING SYSTEM =====

# Enable pattern learning
ENABLE_PATTERN_LEARNING=true
ENABLE_PATTERN_RECOGNITION=true
ENABLE_PATTERN_LEARNING_AGENTS=true

# Google Drive (PRIMARY STORAGE - Required)
ENABLE_GOOGLE_DRIVE_SYNC=true
GOOGLE_DRIVE_CLIENT_ID=your-client-id-here
GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret-here
GOOGLE_DRIVE_REFRESH_TOKEN=your-refresh-token-here
GOOGLE_DRIVE_PATTERNS_FOLDER_ID=optional-folder-id

# Market Data Provider
MARKET_DATA_PROVIDER_DEFAULT=binance

# Learning Daemon Configuration (M3 Optimized - Scalping Focus)
LEARN_CONCURRENCY=4
LEARN_INTERVAL_MINUTES=1        # Scalping: Process every 1 minute
LEARN_RETENTION_DAYS=30         # Scalping: Shorter retention (patterns change faster)

# Backfill Limits (Scalping Focus - More history for 1min/5min)
LEARN_BACKFILL_BARS_1=20000     # 1min: ~14 days of history
LEARN_BACKFILL_BARS_5=10000     # 5min: ~35 days of history
```

## Notes

- **Google Drive is PRIMARY storage** - patterns are stored in cloud first
- **Local cache** - patterns are also cached locally for offline access
- **M3 Concurrency** - 4 parallel workers (tuned for Apple Silicon M3)
- **Secrets** - Never print GOOGLE_DRIVE_* secrets in logs

