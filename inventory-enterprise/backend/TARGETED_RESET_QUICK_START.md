# Targeted Reset Tool - Quick Start Guide

**Quick reference for using the Targeted Reset Tool**

---

## 🚀 Quick Start

### Option 1: API Endpoint (Recommended)

```bash
# 1. Get your JWT token (if not already set)
export TOKEN="your-jwt-token-here"

# 2. Set base URL
export BASE_URL="https://inventory-backend-production-3a2c.up.railway.app"
# Or for local: export BASE_URL="http://localhost:8083"

# 3. Dry run first (recommended)
curl -X POST "$BASE_URL/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": true
  }' | jq .

# 4. Actual reset (after reviewing dry run results)
curl -X POST "$BASE_URL/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": false
  }' | jq .
```

### Option 2: Browser Console

```javascript
// Open browser console on owner console page
(async function() {
  const token = localStorage.getItem('np_owner_jwt') || localStorage.getItem('NP_TOKEN');
  if (!token) { alert('No token!'); return; }
  
  const url = 'https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target';
  
  // Dry run
  const dryRun = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      confirm: 'RESET',
      deleteOrderPdfs: true,
      clearInventoryProducts: true,
      dryRun: true
    })
  });
  
  const dryRunData = await dryRun.json();
  console.log('Dry Run Results:', dryRunData);
  
  // If results look good, uncomment to run actual reset:
  /*
  const actual = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      confirm: 'RESET',
      deleteOrderPdfs: true,
      clearInventoryProducts: true,
      dryRun: false
    })
  });
  
  const actualData = await actual.json();
  console.log('Reset Results:', actualData);
  alert('Reset complete! PDFs: ' + (actualData.deleted?.orderPdfRecords || 0) + ', Products: ' + (actualData.deleted?.products || 0));
  location.reload();
  */
})();
```

### Option 3: CLI Script

```bash
cd inventory-enterprise/backend

# Dry run
node scripts/reset-target.js --confirm=RESET --dry-run

# Actual reset
# ⚠️ WARNING: CLI script has a known bug with product deletion
# Use API endpoint for product deletion until bug is fixed
node scripts/reset-target.js --confirm=RESET --pdfs=true --products=false
```

---

## 📋 Prerequisites

1. **Authentication**: Must have OWNER role JWT token
2. **Environment**: In production, set `RESET_ENABLED=true` (or use owner bypass)
3. **Backup**: Create database backup before running actual reset

---

## ⚙️ Configuration

### Environment Variables

**Required for Production:**
```bash
RESET_ENABLED=true  # Must be set to enable reset in production
```

**Optional:**
```bash
GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'  # For Google Drive file deletion
```

### Railway Setup

1. Go to Railway Dashboard → Your Project → Variables
2. Add variable: `RESET_ENABLED` = `true`
3. Save (Railway will auto-redeploy)

---

## 🔍 Verification

After running reset, verify results:

```bash
# Check PDFs
curl "$BASE_URL/api/owner/pdfs" \
  -H "Authorization: Bearer $TOKEN" | jq 'length'

# Check Products
curl "$BASE_URL/api/inventory/items" \
  -H "Authorization: Bearer $TOKEN" | jq 'length'

# Both should return 0
```

---

## ⚠️ Important Notes

1. **Destructive Operation**: This permanently deletes data. Cannot be undone.
2. **Always Dry Run First**: Review counts before actual reset
3. **Backup Required**: Create database backup before running
4. **CLI Bug**: CLI script has known bug with product deletion - use API for products
5. **Idempotent**: Safe to run multiple times (will just delete 0 records if already empty)

---

## 🐛 Known Issues

- **CLI Script Bug**: `deleteProducts` function name conflict prevents product deletion via CLI
  - **Workaround**: Use API endpoint for product deletion
  - **Status**: Fix pending

---

## 📚 Full Documentation

See `TARGETED_RESET_GUIDE.md` for complete documentation.

---

## 🧪 Testing

Run test suite:
```bash
cd inventory-enterprise/backend
./scripts/test-reset-target.sh
```

Or test specific components:
```bash
./scripts/test-reset-target.sh --api-only    # Test only API
./scripts/test-reset-target.sh --cli-only    # Test only CLI
./scripts/test-reset-target.sh --production   # Test against production
```

---

**Last Updated:** 2025-01-20

