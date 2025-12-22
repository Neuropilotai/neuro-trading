# Test Reset Endpoint - Ready Now

**Deployment Status:** ✅ Active (aa3acff5)  
**Service URL:** `api.neuropilot.dev`  
**Date:** 2025-01-20

---

## ✅ Deployment Verified

From Railway logs, I can see:
- ✅ Service is running at `api.neuropilot.dev`
- ✅ Endpoints are responding (200 status codes)
- ✅ `/api/owner/pdfs` is accessible
- ✅ `/api/vendor-orders` is accessible
- ✅ Service is healthy

---

## 🧪 Test the Reset Endpoint Now

### Quick Test 1: Verify Endpoint Exists

```bash
curl -X POST "https://api.neuropilot.dev/api/admin/reset/target" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET"}'
```

**Expected:** `401 Unauthorized` or `400 Bad Request` (NOT 404)

### Quick Test 2: Browser Console (Easiest)

1. **Open owner console** at `https://api.neuropilot.dev/console-v15.html`
2. **Open Developer Console** (F12)
3. **Paste this code:**

```javascript
(async function() {
  const token = localStorage.getItem('np_owner_jwt') || localStorage.getItem('NP_TOKEN');
  if (!token) { 
    alert('❌ No token! Please login first.'); 
    return; 
  }
  
  const url = 'https://api.neuropilot.dev/api/admin/reset/target';
  
  console.log('🔄 Testing reset endpoint...');
  console.log('Token:', token.substring(0, 20) + '...');
  
  try {
    // First, test endpoint exists
    const testR = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESET' })
    });
    
    console.log('Endpoint test status:', testR.status);
    
    if (testR.status === 404) {
      alert('❌ Endpoint not found (404). Check deployment logs.');
      return;
    }
    
    // Now test with auth (dry-run)
    console.log('🔄 Running dry-run test...');
    
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
    console.log('📊 Response Status:', r.status);
    console.log('📊 Response Data:', data);
    
    if (r.ok) {
      const pdfs = data.deleted?.orderPdfRecords || 0;
      const products = data.deleted?.products || 0;
      alert(`✅ Dry run successful!\n\n📄 PDFs to delete: ${pdfs}\n📦 Products to delete: ${products}\n\nCheck console for full details.`);
    } else {
      alert(`❌ Error (${r.status}): ${data.error || data.message}\n\nCheck console for details.`);
      console.error('Error response:', data);
    }
  } catch (err) {
    alert('❌ Network error: ' + err.message);
    console.error('Error:', err);
  }
})();
```

### Quick Test 3: Using curl (if you have token)

```bash
export TOKEN="your-jwt-token-here"

curl -X POST "https://api.neuropilot.dev/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": true
  }' | jq .
```

---

## 📊 What to Look For

### ✅ Success Indicators:
- Status 200 on dry-run
- Response contains `"dryRun": true`
- Response contains `"deleted"` object with counts
- No errors in response

### ⚠️ Common Issues:

**403 Forbidden:**
- RESET_ENABLED not set correctly
- User doesn't have owner role
- Check Railway Variables

**401 Unauthorized:**
- Token expired or invalid
- Get fresh token from login

**404 Not Found:**
- Endpoint not deployed
- Check Railway deployment logs
- Verify route registration

**500 Internal Server Error:**
- Check Railway logs for details
- Database connection issue
- Code error

---

## 🎯 Expected Response Format

```json
{
  "dryRun": true,
  "deleted": {
    "orderPdfRecords": 3,
    "pdfFiles": 3,
    "vendorOrders": 2,
    "products": 65,
    "inventoryBalances": 65,
    "inventoryLedger": 120,
    "fifoCostLayers": 45,
    "itemLocationAssignments": 30
  },
  "errors": [],
  "warnings": [],
  "message": "Dry run complete. No data was deleted."
}
```

---

## 🚀 Next Steps After Successful Test

1. **Review the counts** - Make sure they match what you expect
2. **Create backup** - Before actual reset:
   ```bash
   pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
   ```
3. **Run actual reset** (if ready):
   - Change `dryRun: true` to `dryRun: false`
   - Execute the same request
4. **Verify results** - Check that PDFs and products are deleted

---

## 📝 Test Checklist

- [ ] Endpoint accessible (not 404)
- [ ] Dry-run returns 200
- [ ] Counts displayed correctly
- [ ] No errors in response
- [ ] Ready for actual reset (if needed)

---

**Service URL:** `https://api.neuropilot.dev`  
**Endpoint:** `/api/admin/reset/target`  
**Status:** ✅ Ready for testing

