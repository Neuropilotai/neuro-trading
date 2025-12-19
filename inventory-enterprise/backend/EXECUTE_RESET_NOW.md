# 🗑️ Execute Targeted Reset - Quick Guide

## Option 1: Via Script (Easiest)

```bash
cd /Users/davidmikulis/neuro-inventory-enterprise/inventory-enterprise/backend

# Get your token from browser console:
# localStorage.getItem('np_owner_jwt')

# Run the script:
./scripts/execute-reset.sh https://your-railway-url.up.railway.app YOUR_TOKEN
```

## Option 2: Via Browser Console

1. Open your owner console in browser
2. Open Developer Console (F12)
3. Run this:

```javascript
const token = localStorage.getItem('np_owner_jwt');
const url = 'https://your-railway-url.up.railway.app/api/admin/reset/target';

// First, dry run
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
.then(r => r.json())
.then(data => {
  console.log('Dry run:', data);
  
  // If dry run looks good, execute:
  if (confirm('Execute reset? This cannot be undone!')) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        confirm: 'RESET',
        deleteOrderPdfs: true,
        clearInventoryProducts: true,
        dryRun: false
      })
    });
  }
})
.then(r => r && r.json())
.then(data => {
  console.log('Reset result:', data);
  alert('Reset complete! Refresh the page.');
  location.reload();
})
.catch(err => console.error('Error:', err));
```

## Option 3: Via curl

```bash
# Get token from browser: localStorage.getItem('np_owner_jwt')

# Dry run first
curl -X POST https://your-railway-url.up.railway.app/api/admin/reset/target \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": true
  }'

# If dry run looks good, execute:
curl -X POST https://your-railway-url.up.railway.app/api/admin/reset/target \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": false
  }'
```

## Troubleshooting

### 403 Forbidden - Reset disabled in production
**Fix:** Set environment variable in Railway:
```
RESET_ENABLED=true
```

### 401 Unauthorized
**Fix:** Ensure you're using an owner token (not regular user token)
- Token must have `role: "owner"` in JWT payload
- Get token from: `localStorage.getItem('np_owner_jwt')`

### 500 Error
**Fix:** Check Railway logs for specific error
- Route might not be loaded: Check for `[STARTUP] ✓ admin-reset loaded`
- Database connection issue
- Missing environment variables

### Route not found (404)
**Fix:** 
1. Verify Railway has redeployed (check deployment logs)
2. Check that `server-v21_1.js` has the route registered
3. Check Railway logs for: `[STARTUP] Loading admin-reset...`

## What Gets Deleted

✅ **PDFs:**
- All `documents` table records
- All local PDF files
- All `vendor_orders` with PDFs
- All Google Drive PDFs (if configured)

✅ **Products:**
- All active `inventory_items` (is_active = 1)
- All `inventory_balances`
- All `inventory_ledger` entries
- All `fifo_cost_layers`
- All `item_location_assignments`

## What's Preserved

✅ Users, locations, vendors, item bank, configuration

## After Reset

1. Refresh your console (hard refresh: Cmd+Shift+R / Ctrl+Shift+R)
2. PDFs tab should show 0 PDFs
3. Inventory list should show 0 products
4. You can now import fresh Sysco PDFs

