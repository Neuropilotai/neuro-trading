# Port Consistency Fix

**Date:** 2026-01-21  
**Status:** ✅ **COMPLETE**

---

## Problem

The server was using `WEBHOOK_PORT` while scripts assumed `PORT` or hardcoded `3014`, causing inconsistencies:
- `simple_webhook_server.js` used: `process.env.WEBHOOK_PORT || 3014`
- Scripts hardcoded: `http://localhost:3014`
- No port detection if server was on a different port

---

## Solution

### 1. Updated `simple_webhook_server.js` ✅

**Changed:**
```javascript
// Before:
const port = process.env.WEBHOOK_PORT || 3014;

// After:
const port = Number(process.env.PORT || process.env.WEBHOOK_PORT || 3014);
```

**Benefits:**
- Supports standard `PORT` environment variable (convention)
- Maintains backward compatibility with `WEBHOOK_PORT`
- Defaults to 3014 if neither is set
- Uses `Number()` to ensure numeric type

**Console logs:** Already print the chosen port in all URLs (no changes needed)

---

### 2. Updated `scripts/verify_tradingview_webhook.sh` ✅

**Changed:**
```bash
# Before:
LOCAL_URL="http://localhost:3014"

# After:
LOCAL_PORT="${PORT:-${WEBHOOK_PORT:-3014}}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
```

**Added port detection:**
- If health check fails on configured port, scans ports 3014 and 3000
- If server found on different port, updates `LOCAL_PORT` and `LOCAL_URL`
- Warns user about port mismatch

---

### 3. Updated `check_tradingview_status.sh` ✅

**Changed:**
```bash
# Before:
LOCAL_URL="http://localhost:3014"
PORT=3014

# After:
LOCAL_PORT="${PORT:-${WEBHOOK_PORT:-3014}}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
```

**Added port detection:**
- In "Server Process Check" section: detects server on ports 3014/3000 if configured port not in use
- In "Health Endpoint" section: if health check fails, scans other ports and retries
- Provides helpful hints: "Set PORT=X or WEBHOOK_PORT=X and restart"

---

## Acceptance Criteria ✅

- [x] `PORT=3014 node simple_webhook_server.js` listens on 3014
- [x] `WEBHOOK_PORT=3014 node simple_webhook_server.js` listens on 3014
- [x] `PORT=3000 node simple_webhook_server.js` listens on 3000
- [x] `verify_tradingview_webhook.sh` works with either `PORT` or `WEBHOOK_PORT`
- [x] `check_tradingview_status.sh` works with either `PORT` or `WEBHOOK_PORT`
- [x] Scripts detect server on different port and provide helpful hints

---

## Testing

### Test Server Port Selection

```bash
# Test 1: PORT takes precedence
PORT=3000 node simple_webhook_server.js
# Should listen on 3000

# Test 2: WEBHOOK_PORT works (backward compatibility)
WEBHOOK_PORT=3014 node simple_webhook_server.js
# Should listen on 3014

# Test 3: Default to 3014
node simple_webhook_server.js
# Should listen on 3014

# Test 4: PORT overrides WEBHOOK_PORT
PORT=3000 WEBHOOK_PORT=3014 node simple_webhook_server.js
# Should listen on 3000 (PORT takes precedence)
```

### Test Scripts

```bash
# Test with PORT
PORT=3014 ./scripts/verify_tradingview_webhook.sh
PORT=3014 ./check_tradingview_status.sh

# Test with WEBHOOK_PORT
WEBHOOK_PORT=3014 ./scripts/verify_tradingview_webhook.sh
WEBHOOK_PORT=3014 ./check_tradingview_status.sh

# Test port detection (server on 3014, script expects 3000)
PORT=3000 ./check_tradingview_status.sh
# Should detect server on 3014 and warn user
```

---

## Files Changed

1. **`simple_webhook_server.js`** (line 45)
   - Changed port selection to: `Number(process.env.PORT || process.env.WEBHOOK_PORT || 3014)`

2. **`scripts/verify_tradingview_webhook.sh`** (lines 24-26)
   - Added `LOCAL_PORT` variable with fallback logic
   - Updated `LOCAL_URL` to use `LOCAL_PORT`
   - Added port detection in health check section

3. **`check_tradingview_status.sh`** (lines 20-24, 84-114, 116-140)
   - Added `LOCAL_PORT` variable with fallback logic
   - Updated all port references to use `LOCAL_PORT`
   - Added port detection in server process check
   - Added port detection in health endpoint check

---

## Migration Notes

**No breaking changes:**
- Existing setups using `WEBHOOK_PORT` continue to work
- Scripts default to 3014 if neither `PORT` nor `WEBHOOK_PORT` is set
- Server defaults to 3014 if neither is set

**Recommended:**
- Use `PORT` for new deployments (standard convention)
- `WEBHOOK_PORT` still works for backward compatibility
- Scripts automatically detect port mismatches and provide hints

---

**Port selection is now consistent across the codebase!** ✅

