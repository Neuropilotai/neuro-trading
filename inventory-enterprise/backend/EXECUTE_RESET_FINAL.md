# Execute Targeted Reset - Final Guide

**Date:** 2025-01-20  
**Status:** ✅ Ready to Execute

---

## ⚠️ CRITICAL WARNINGS

1. **This will PERMANENTLY DELETE data** - Cannot be undone
2. **Create database backup FIRST** - Required before execution
3. **Verify counts with dry-run** - Make sure you want to delete these items
4. **Owner role required** - Only owners can execute this

---

## 📋 Pre-Execution Checklist

### Before Running Reset:

- [ ] **Database backup created**
  ```bash
  pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
  ```

- [ ] **Dry-run completed successfully**
  - Verified endpoint works
  - Reviewed counts
  - Counts match expectations

- [ ] **Verified what will be deleted:**
  - PDFs from `documents` table
  - PDFs from `vendor_orders` table
  - All active inventory products
  - Related data (balances, ledger, FIFO, assignments)

- [ ] **Verified what will be preserved:**
  - User accounts
  - Locations
  - Vendors/suppliers
  - System configuration

- [ ] **Ready to proceed** - Confirmed you want to delete the data

---

## 🚀 Execution Methods

### Method 1: Browser Console (Recommended)

**Step 1: Open Owner Console**
- Go to: `https://api.neuropilot.dev/console-v15.html`
- Login as owner
- Open Developer Console (F12)

**Step 2: Run Dry-Run First (Verify Counts)**
```javascript
(async function() {
  const token = localStorage.getItem('np_owner_jwt') || localStorage.getItem('NP_TOKEN');
  if (!token) { alert('No token!'); return; }
  
  const url = 'https://api.neuropilot.dev/api/admin/reset/target';
  
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      confirm: 'RESET',
      deleteOrderPdfs: true,
      clearInventoryProducts: true,
      dryRun: true  // DRY RUN - SAFE
    })
  });
  
  const data = await r.json();
  console.log('Dry Run Results:', data);
  
  if (r.ok) {
    const pdfs = data.deleted?.orderPdfRecords || 0;
    const products = data.deleted?.products || 0;
    alert(`Dry Run Results:\n\nPDFs: ${pdfs}\nProducts: ${products}\n\nReview these counts before proceeding!`);
  } else {
    alert('Error: ' + (data.error || data.message));
  }
})();
```

**Step 3: Execute Actual Reset (After Reviewing Dry-Run)**
```javascript
(async function() {
  const token = localStorage.getItem('np_owner_jwt') || localStorage.getItem('NP_TOKEN');
  if (!token) { alert('No token!'); return; }
  
  // CONFIRM: Are you sure?
  if (!confirm('⚠️ WARNING: This will PERMANENTLY DELETE all PDFs and products!\n\nThis cannot be undone.\n\nHave you created a database backup?\n\nClick OK to proceed, Cancel to abort.')) {
    alert('Reset cancelled.');
    return;
  }
  
  const url = 'https://api.neuropilot.dev/api/admin/reset/target';
  
  console.log('🔄 Starting reset...');
  
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        confirm: 'RESET',
        deleteOrderPdfs: true,
        clearInventoryProducts: true,
        dryRun: false  // ACTUAL RESET
      })
    });
    
    const data = await r.json();
    console.log('📊 Reset Results:', data);
    
    if (r.ok) {
      const pdfs = data.deleted?.orderPdfRecords || 0;
      const products = data.deleted?.products || 0;
      alert(`✅ Reset completed!\n\nDeleted:\n- PDFs: ${pdfs}\n- Products: ${products}\n\nPage will refresh in 3 seconds...`);
      setTimeout(() => location.reload(), 3000);
    } else {
      alert('❌ Error: ' + (data.error || data.message));
      console.error('Error:', data);
    }
  } catch (err) {
    alert('❌ Network error: ' + err.message);
    console.error('Error:', err);
  }
})();
```

### Method 2: Using curl

**Step 1: Dry-Run**
```bash
export TOKEN="your-jwt-token-here"
export BASE_URL="https://api.neuropilot.dev"

curl -X POST "$BASE_URL/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": true
  }' | jq .
```

**Step 2: Actual Reset (After Reviewing)**
```bash
# ⚠️ WARNING: This will delete data!
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

---

## ✅ Post-Execution Verification

### 1. Check PDFs Deleted
```bash
curl "$BASE_URL/api/owner/pdfs" \
  -H "Authorization: Bearer $TOKEN" | jq 'length'
# Should return 0
```

### 2. Check Products Deleted
```bash
curl "$BASE_URL/api/inventory/items" \
  -H "Authorization: Bearer $TOKEN" | jq 'length'
# Should return 0
```

### 3. Verify Preserved Data
```bash
# Users should still exist
curl "$BASE_URL/api/users" \
  -H "Authorization: Bearer $TOKEN" | jq 'length'
# Should return > 0

# Locations should still exist
curl "$BASE_URL/api/owner/console/locations" \
  -H "Authorization: Bearer $TOKEN" | jq 'length'
# Should return > 0
```

### 4. Check Response Verification
The reset response includes automatic verification:
```json
{
  "verification": {
    "passed": true,
    "checks": [
      {
        "check": "documents table",
        "expected": 0,
        "actual": 0,
        "passed": true
      },
      {
        "check": "active inventory_items",
        "expected": 0,
        "actual": 0,
        "passed": true
      }
    ]
  }
}
```

---

## 🎯 Expected Response

```json
{
  "dryRun": false,
  "deleted": {
    "orderPdfRecords": 3,
    "pdfFiles": 3,
    "googleDriveFiles": 2,
    "vendorOrders": 2,
    "vendorOrderLines": "CASCADE deleted with vendor_orders",
    "products": 65,
    "inventoryBalances": 65,
    "inventoryLedger": 120,
    "fifoCostLayers": 45,
    "itemLocationAssignments": 30,
    "vendorOrderLinesUpdated": 15
  },
  "errors": [],
  "warnings": [],
  "verification": {
    "passed": true,
    "checks": [...]
  },
  "duration": "234ms",
  "message": "Reset completed successfully. This operation cannot be undone."
}
```

---

## 🐛 Troubleshooting

### Reset Fails with Error
- **Check Railway logs** for detailed error message
- **Verify database connection** is working
- **Check transaction** wasn't rolled back

### Some Data Not Deleted
- **Check warnings** in response
- **Verify file permissions** for local files
- **Check Google Drive API** if using Google Drive

### Verification Fails
- **Check database** directly with SQL queries
- **Review verification checks** in response
- **Check for soft-deleted records** (may need hard delete)

---

## 📝 Post-Reset Actions

1. **Refresh browser** - Clear cached data
2. **Verify console** - Check PDFs and products tabs are empty
3. **Test system** - Ensure login and other features still work
4. **Document results** - Note what was deleted for records

---

## 🔄 Rollback (If Needed)

If something went wrong:

1. **Restore from backup:**
   ```bash
   psql $DATABASE_URL < backup-YYYYMMDD-HHMMSS.sql
   ```

2. **Note:** Google Drive files cannot be automatically restored
   - Must be re-uploaded if needed

---

## ✅ Success Criteria

- [x] Database backup created
- [x] Dry-run completed and reviewed
- [ ] Actual reset executed
- [ ] Verification passed
- [ ] PDFs deleted (count = 0)
- [ ] Products deleted (count = 0)
- [ ] Preserved data intact
- [ ] System still functional

---

## 📚 Related Documentation

- `TARGETED_RESET_QUICK_START.md` - Quick reference
- `TARGETED_RESET_GUIDE.md` - Complete guide
- `TEST_RESET_ENDPOINT_NOW.md` - Testing guide

---

**⚠️ Remember:** This is a destructive operation. Ensure you have a backup and have reviewed the dry-run results before proceeding.

---

**Last Updated:** 2025-01-20  
**Status:** Ready for execution (after backup and dry-run verification)

