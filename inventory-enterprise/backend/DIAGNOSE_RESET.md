# 🔍 Diagnose Reset Issue - Step by Step

## Step 1: Check if endpoint exists

Paste this in browser console:

```javascript
const token = localStorage.getItem('np_owner_jwt');
const url = 'https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target';

console.log('Token:', token ? token.substring(0, 20) + '...' : 'NOT FOUND');
console.log('URL:', url);

fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    confirm: 'RESET',
    deleteOrderPdfs: true,
    clearInventoryProducts: true,
    dryRun: true
  })
})
.then(r => {
  console.log('Status:', r.status, r.statusText);
  return r.text();
})
.then(text => {
  console.log('Response:', text);
  try {
    const json = JSON.parse(text);
    console.log('Parsed JSON:', json);
  } catch(e) {
    console.log('Not JSON:', text);
  }
})
.catch(err => console.error('Error:', err));
```

## Step 2: Check what error you get

Common errors:

### 404 Not Found
- Route not loaded on Railway
- Check Railway logs for: `[STARTUP] ✓ admin-reset loaded`
- Solution: Wait for Railway to redeploy or check if route is registered

### 403 Forbidden - "Reset disabled in production"
- Need to set `RESET_ENABLED=true` in Railway environment variables
- Solution: Add variable in Railway dashboard → Variables → Add `RESET_ENABLED=true`

### 401 Unauthorized
- Token invalid or expired
- Solution: Login again to get fresh token

### 500 Internal Server Error
- Check Railway logs for specific error
- Could be database connection issue

## Step 3: Test endpoint directly

```bash
# Get token from browser: localStorage.getItem('np_owner_jwt')

curl -v -X POST https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": true
  }'
```

## Step 4: Check Railway Logs

1. Go to Railway Dashboard
2. Click on your service
3. Go to "Deployments" → Latest → "Logs"
4. Look for:
   - `[STARTUP] Loading admin-reset...`
   - `[STARTUP] ✓ admin-reset loaded`
   - Any errors related to admin-reset

## Step 5: Verify Route is Registered

Check if the route is in `server-v21_1.js`:

```javascript
// Should see this line:
app.use('/api/admin/reset', authenticateToken, requireOwner, rateLimitMiddleware, auditLog('ADMIN_RESET'), safeRequire('./routes/admin-reset', 'admin-reset'));
```

