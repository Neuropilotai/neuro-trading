# ✅ Targeted Reset Tool - Deployment Verified

**Date:** 2025-01-20  
**Status:** ✅ **Deployment Complete - Ready for Testing**

---

## ✅ Deployment Status

- ✅ Code deployed to Railway
- ✅ `RESET_ENABLED=true` configured
- ✅ Endpoint should be accessible

---

## 🧪 Step 1: Verify Endpoint is Accessible

**Quick Test (No Auth Required):**
```bash
curl -X POST "https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET"}'
```

**Expected Results:**
- ✅ `401 Unauthorized` - Perfect! Endpoint exists and requires auth
- ✅ `400 Bad Request` - Perfect! Endpoint exists and validates requests
- ❌ `404 Not Found` - Problem! Endpoint not deployed (check logs)
- ⚠️ `403 Forbidden` - Check if RESET_ENABLED is set correctly

**Or use the verification script:**
```bash
cd inventory-enterprise/backend
./scripts/verify-railway-reset-enabled.sh
```

---

## 🧪 Step 2: Test Dry Run

**Get Your JWT Token:**
1. Login to owner console
2. Open browser console (F12)
3. Run: `localStorage.getItem('np_owner_jwt')`
4. Copy the token

**Run Dry Run Test:**
```bash
export TOKEN="your-jwt-token-here"
export BASE_URL="https://inventory-backend-production-3a2c.up.railway.app"

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

**Expected Response:**
```json
{
  "dryRun": true,
  "deleted": {
    "orderPdfRecords": 3,
    "vendorOrders": 2,
    "products": 65,
    "inventoryBalances": 65,
    "inventoryLedger": 120,
    "fifoCostLayers": 45,
    "itemLocationAssignments": 30
  },
  "message": "Dry run complete. No data was deleted."
}
```

---

## 🧪 Step 3: Browser Console Test (Easier)

**Quick test from browser console:**

1. Open owner console in browser
2. Open Developer Console (F12)
3. Paste this code:

```javascript
(async function() {
  const token = localStorage.getItem('np_owner_jwt') || localStorage.getItem('NP_TOKEN');
  if (!token) { 
    alert('No token found! Please login first.'); 
    return; 
  }
  
  const url = 'https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target';
  
  console.log('🔄 Starting dry-run test...');
  
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
        dryRun: true
      })
    });
    
    const data = await r.json();
    console.log('📊 Dry Run Results:', data);
    
    if (r.ok) {
      alert('✅ Dry run complete! Check console for results.\n\nPDFs: ' + (data.deleted?.orderPdfRecords || 0) + '\nProducts: ' + (data.deleted?.products || 0));
    } else {
      alert('❌ Error: ' + (data.error || data.message) + '\n\nStatus: ' + r.status);
      console.error('Error response:', data);
    }
  } catch (err) {
    alert('❌ Network error: ' + err.message);
    console.error('Error:', err);
  }
})();
```

**What to Look For:**
- ✅ Status 200 - Success!
- ✅ `dryRun: true` in response
- ✅ Counts shown in `deleted` object
- ✅ No actual data deleted (dry-run is safe)

---

## 📋 Verification Checklist

- [ ] Endpoint accessible (returns 401 or 400, not 404)
- [ ] Dry-run test successful (returns 200)
- [ ] Counts displayed correctly
- [ ] No errors in response
- [ ] No data actually deleted (dry-run is safe)

---

## 🚀 Next Steps

### If Dry Run Looks Good:

1. **Create Database Backup:**
   ```bash
   pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
   ```

2. **Review the Counts:**
   - Verify PDF count matches what you see in console
   - Verify product count matches what you see in inventory
   - Make sure you want to delete these items

3. **Run Actual Reset (if ready):**
   ```bash
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

4. **Verify Results:**
   ```bash
   # Check PDFs deleted
   curl "$BASE_URL/api/owner/pdfs" \
     -H "Authorization: Bearer $TOKEN" | jq 'length'
   # Should return 0
   
   # Check products deleted
   curl "$BASE_URL/api/inventory/items" \
     -H "Authorization: Bearer $TOKEN" | jq 'length'
   # Should return 0
   ```

---

## 🐛 Troubleshooting

### Endpoint Returns 404
- **Issue:** Route not deployed
- **Solution:** Check Railway deployment logs, verify code was deployed

### Endpoint Returns 403
- **Issue:** RESET_ENABLED not set or user not owner
- **Solution:** 
  - Verify `RESET_ENABLED=true` in Railway Variables
  - Verify user has owner role
  - Wait a few more minutes for deployment to fully complete

### Endpoint Returns 401
- **Issue:** Invalid or expired token
- **Solution:** Get fresh JWT token from login

### Dry Run Shows 0 Counts
- **Issue:** No data to delete (system already clean)
- **Solution:** This is normal if system is already reset

### Dry Run Fails with Error
- **Issue:** Database connection or other error
- **Solution:** Check Railway logs for detailed error message

---

## ✅ Success Indicators

- ✅ Endpoint returns 200 on dry-run
- ✅ Counts match expectations
- ✅ No errors in response
- ✅ Verification checks pass
- ✅ Ready for actual reset (if needed)

---

## 📚 Related Documentation

- `TARGETED_RESET_QUICK_START.md` - Quick reference
- `TARGETED_RESET_GUIDE.md` - Complete guide
- `TARGETED_RESET_POST_PUSH.md` - Post-deployment steps
- `RAILWAY_SETUP_RESET_ENABLED.md` - Railway setup guide

---

## 🎯 Current Status

- ✅ Code deployed
- ✅ Environment variable set
- ⏳ Testing in progress
- ⏳ Ready for use after verification

---

**Last Updated:** 2025-01-20  
**Next:** Run dry-run test to verify everything works

