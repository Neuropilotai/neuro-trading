# Targeted Reset Tool - Post-Push Deployment Steps

**Date:** 2025-01-20  
**Status:** ✅ Code pushed to repository

---

## ✅ What's Been Completed

- ✅ All files committed
- ✅ Code pushed to repository
- ✅ Railway will auto-deploy

---

## 🚀 Next Steps: Deploy to Production

### Step 1: Set Environment Variable in Railway

1. **Go to Railway Dashboard**
   - Navigate to your project: `inventory-backend-production`
   - Click on the service

2. **Add Environment Variable**
   - Go to **Variables** tab
   - Click **+ New Variable**
   - Name: `RESET_ENABLED`
   - Value: `true`
   - Click **Add**

3. **Verify Deployment**
   - Railway will automatically redeploy
   - Wait 2-5 minutes for deployment to complete
   - Check deployment logs for success

### Step 2: Verify Deployment

**Check if endpoint is accessible:**
```bash
# Should return 401 (unauthorized) or 400 (bad request), NOT 404
curl -X POST "https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET"}'
```

**Expected Response:**
- `401 Unauthorized` - Good (endpoint exists, needs auth)
- `400 Bad Request` - Good (endpoint exists, invalid request)
- `404 Not Found` - Bad (endpoint not deployed)

### Step 3: Test Dry Run

**Get your JWT token:**
- Login to owner console
- Open browser console (F12)
- Run: `localStorage.getItem('np_owner_jwt')`
- Copy the token

**Run dry-run test:**
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
    ...
  },
  "message": "Dry run complete. No data was deleted."
}
```

### Step 4: Review Results

- ✅ Check counts match expectations
- ✅ Verify no data was deleted (dry-run is safe)
- ✅ Review any warnings or errors

### Step 5: Run Actual Reset (if needed)

**⚠️ WARNING: This will permanently delete data!**

1. **Create Database Backup First:**
   ```bash
   pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
   ```

2. **Run Actual Reset:**
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

3. **Verify Results:**
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

## 🧪 Alternative: Browser Console Test

**Quick test from browser console:**

1. Open owner console in browser
2. Open Developer Console (F12)
3. Paste this code:

```javascript
(async function() {
  const token = localStorage.getItem('np_owner_jwt') || localStorage.getItem('NP_TOKEN');
  if (!token) { alert('No token!'); return; }
  
  const url = 'https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target';
  
  // Dry run
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
  console.log('Dry Run Results:', data);
  
  if (r.ok) {
    alert('Dry run complete! Check console for results.');
  } else {
    alert('Error: ' + (data.error || data.message));
  }
})();
```

---

## 📋 Deployment Checklist

- [ ] Code pushed to repository ✅
- [ ] Railway auto-deployment triggered
- [ ] Set `RESET_ENABLED=true` in Railway Variables
- [ ] Wait for deployment to complete (~2-5 minutes)
- [ ] Verify endpoint is accessible (not 404)
- [ ] Run dry-run test
- [ ] Review dry-run results
- [ ] Create database backup (before actual reset)
- [ ] Run actual reset (if needed)
- [ ] Verify data deleted correctly

---

## ⚠️ Important Reminders

1. **Always dry-run first** - Review counts before actual reset
2. **Create backup** - Database backup required before actual reset
3. **Environment variable** - Must set `RESET_ENABLED=true` in Railway
4. **Owner role required** - Only owners can use this endpoint
5. **Destructive operation** - Cannot be undone

---

## 🐛 Troubleshooting

### Endpoint Returns 404
- **Issue:** Route not registered
- **Solution:** Check Railway deployment logs, verify `server-v21_1.js` was deployed

### Endpoint Returns 403
- **Issue:** `RESET_ENABLED` not set or user not owner
- **Solution:** Set `RESET_ENABLED=true` in Railway, verify user has owner role

### Endpoint Returns 401
- **Issue:** Invalid or missing token
- **Solution:** Get fresh JWT token from login

### Dry Run Shows 0 Counts
- **Issue:** No data to delete (already clean)
- **Solution:** This is normal if system is already reset

---

## 📚 Documentation

- **Quick Start:** `TARGETED_RESET_QUICK_START.md`
- **Complete Guide:** `TARGETED_RESET_GUIDE.md`
- **Deployment:** `TARGETED_RESET_DEPLOYMENT_CHECKLIST.md`

---

## ✅ Success Criteria

- [x] Code committed and pushed
- [ ] Environment variable set in Railway
- [ ] Deployment successful
- [ ] Endpoint accessible
- [ ] Dry-run test passes
- [ ] Ready for actual reset (if needed)

---

**Last Updated:** 2025-01-20  
**Next:** Set `RESET_ENABLED=true` in Railway and test

