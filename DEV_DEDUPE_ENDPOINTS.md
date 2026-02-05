# Dev-Only Dedupe Endpoints

## Overview

Added dev-only endpoints to inspect and reset the deduplication cache for easier testing.

## Endpoints

### GET /api/dedupe/stats

Returns statistics about the deduplication cache.

**Security:** Only available when `NODE_ENV === "development"` OR `ENABLE_DEV_ENDPOINTS === "true"`

**Response:**
```json
{
  "enabled": true,
  "size": 5,
  "ttlSeconds": 3600,
  "sampleKeys": [
    "alert_test_xau_1",
    "alert_test_btc_1",
    "hash_abc123def456"
  ],
  "source": "in_memory",
  "cacheFile": "./data/alert_cache.json"
}
```

**Fields:**
- `enabled` (bool): Whether deduplication is enabled
- `size` (number): Number of keys in the cache
- `ttlSeconds` (number): Time-to-live in seconds
- `sampleKeys` (array): Up to 20 sample idempotency keys
- `source` (string): Always "in_memory" (cache is in-memory with optional file persistence)
- `cacheFile` (string|null): Path to cache file if it exists, null otherwise

---

### POST /api/dedupe/reset

Clears the in-memory deduplication cache and deletes the cache file if it exists.

**Security:** Only available when `NODE_ENV === "development"` OR `ENABLE_DEV_ENDPOINTS === "true"`

**Response:**
```json
{
  "status": "ok",
  "cleared": 5,
  "deletedFile": true
}
```

**Fields:**
- `status` (string): Always "ok" on success
- `cleared` (number): Number of keys cleared from in-memory cache
- `deletedFile` (bool): Whether the cache file was deleted

---

## Security

Both endpoints return **404 (Not Found)** if dev mode is not enabled, to avoid advertising their existence.

**Dev mode is enabled when:**
- `NODE_ENV === "development"` OR
- `ENABLE_DEV_ENDPOINTS === "true"`

---

## Test Plan

### Test A: Check Stats (Dev Mode Enabled)

```bash
# 1. Set dev mode
export NODE_ENV=development
# OR
export ENABLE_DEV_ENDPOINTS=true

# 2. Start server
node simple_webhook_server.js

# 3. Check stats (should return 200)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: JSON with enabled, size, ttlSeconds, sampleKeys, source, cacheFile
```

### Test B: Send Duplicate Webhook

```bash
# 1. Send first webhook
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"BTCUSDT",
    "action":"BUY",
    "price":50000,
    "quantity":0.01,
    "alert_id":"test_duplicate_1",
    "timestamp":1738230000,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 200, trade accepted

# 2. Send same webhook again (duplicate)
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"BTCUSDT",
    "action":"BUY",
    "price":50000,
    "quantity":0.01,
    "alert_id":"test_duplicate_1",
    "timestamp":1738230000,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 409, "Duplicate alert"

# 3. Check stats (should show 1 key)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: size: 1, sampleKeys: ["alert_test_duplicate_1"]
```

### Test C: Reset Cache

```bash
# 1. Reset cache
curl -s -X POST http://localhost:3001/api/dedupe/reset | jq .

# Expected: {status:"ok", cleared:1, deletedFile:true}

# 2. Check stats (should show empty)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: size: 0, sampleKeys: []

# 3. Resend same webhook (should be accepted now)
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"BTCUSDT",
    "action":"BUY",
    "price":50000,
    "quantity":0.01,
    "alert_id":"test_duplicate_1",
    "timestamp":1738230000,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 200, trade accepted (no longer duplicate)
```

### Test D: Security Gate (Dev Mode Disabled)

```bash
# 1. Unset dev mode
unset NODE_ENV
unset ENABLE_DEV_ENDPOINTS

# 2. Restart server
node simple_webhook_server.js

# 3. Try to access stats (should return 404)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: HTTP 404, {error:"Not found"}

# 4. Try to reset (should return 404)
curl -s -X POST http://localhost:3001/api/dedupe/reset | jq .

# Expected: HTTP 404, {error:"Not found"}
```

---

## Files Changed

1. **`backend/services/deduplicationService.js`**
   - Added `getSampleKeys(maxKeys)` method
   - Added `clearCache()` method
   - Added `getCacheFilePath()` method

2. **`simple_webhook_server.js`**
   - Added `isDevEndpointsEnabled()` helper function
   - Added `GET /api/dedupe/stats` endpoint
   - Added `POST /api/dedupe/reset` endpoint

---

## Implementation Details

### Deduplication Service Methods

```javascript
// Get sample keys (max 20)
getSampleKeys(maxKeys = 20) {
  const keys = Array.from(this.cache.keys());
  return keys.slice(0, maxKeys);
}

// Clear cache and return count
clearCache() {
  const count = this.cache.size;
  this.cache.clear();
  return count;
}

// Get cache file path
getCacheFilePath() {
  return this.cacheFile;
}
```

### Security Gate

```javascript
const isDevEndpointsEnabled = () => {
    return process.env.NODE_ENV === 'development' || 
           process.env.ENABLE_DEV_ENDPOINTS === 'true';
};
```

Both endpoints check this before processing and return 404 if not enabled.

---

## Summary

✅ **Added:** GET /api/dedupe/stats - View cache statistics  
✅ **Added:** POST /api/dedupe/reset - Clear cache and delete file  
✅ **Security:** 404 when dev mode disabled (not 403)  
✅ **No Dependencies:** Uses existing Node.js modules only  

---

**Status:** ✅ Implementation complete and ready for testing

