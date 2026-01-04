# 🗑️ Step-by-Step: Remove GFS Data

## Current Status
- **3 invoices** showing in console under "Orders/PDF"
- **181 invoices** with **$2.13M** showing in reports

---

## Step 1: Get Your Owner Token

### Option A: From Owner Console (Easiest)

1. Open your owner console:
   ```
   https://inventory-backend-production-3a2c.up.railway.app/owner-super-console-v15.html
   ```

2. Open browser Developer Tools:
   - **Chrome/Edge**: Press `F12` or `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows)
   - **Firefox**: Press `F12` or `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows)

3. Go to **Console** tab

4. Type this command and press Enter:
   ```javascript
   localStorage.getItem('ownerToken')
   ```

5. Copy the token (it will look like: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`)

### Option B: From Login Response

1. Login to owner console
2. Check Network tab in Developer Tools
3. Find the login request
4. Copy the token from the response

---

## Step 2: Check What Will Be Removed (Analytics)

Run this command in your terminal:

```bash
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

**Replace `YOUR_TOKEN_HERE` with your actual token from Step 1**

**Expected Response:**
```json
{
  "success": true,
  "analytics": {
    "operational": {
      "vendorOrders": 3,
      "invoices": 181,
      "invoiceTotalCents": 213000000
    },
    "learning": {
      "parseJobs": X,
      "lineMatches": Y
    }
  }
}
```

This shows you exactly what will be removed.

---

## Step 3: Remove GFS Data

Run this command in your terminal:

```bash
curl -X POST https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation": "REMOVE_GFS",
    "createBackup": true
  }'
```

**Replace `YOUR_TOKEN_HERE` with your actual token from Step 1**

**Expected Response:**
```json
{
  "success": true,
  "message": "GFS operational data removed successfully...",
  "stats": {
    "orders": 3,
    "invoices": 181,
    "invoiceLines": X,
    ...
  }
}
```

---

## Step 4: Verify Removal

### Check Console
1. Go to: `https://inventory-backend-production-3a2c.up.railway.app/owner-super-console-v15.html`
2. Navigate to **Orders/PDF** section
3. Should show **0 GFS invoices**

### Check Reports
1. Go to **Reports** section
2. Should show **0 GFS invoices** and **$0.00**

### Verify via API
```bash
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

Should show:
```json
{
  "analytics": {
    "operational": {
      "vendorOrders": 0,
      "invoices": 0,
      "invoiceTotalCents": 0
    }
  }
}
```

---

## Complete Example (Copy-Paste Ready)

Replace `YOUR_TOKEN_HERE` with your actual token:

```bash
# Step 1: Check analytics
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

# Step 2: Remove GFS data
curl -X POST https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation": "REMOVE_GFS",
    "createBackup": true
  }'

# Step 3: Verify removal
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## Troubleshooting

### Error: 401 Unauthorized
- **Problem**: Token is invalid or expired
- **Solution**: Get a fresh token from Step 1

### Error: 403 Forbidden
- **Problem**: Token doesn't have owner permissions
- **Solution**: Make sure you're logged in as **owner** (not regular user)

### Error: 400 Bad Request - "Removal requires confirmation"
- **Problem**: Missing or incorrect confirmation
- **Solution**: Make sure `"confirmation": "REMOVE_GFS"` is exactly as shown

### Error: 500 Internal Server Error
- **Problem**: Database or server issue
- **Solution**: Check Railway logs for specific error

---

## What Gets Removed ✅

- ✅ 181 GFS invoices ($2.13M)
- ✅ 3 GFS vendor orders
- ✅ All GFS invoice line items
- ✅ GFS FIFO cost layers
- ✅ GFS reconciliation links
- ✅ GFS processed invoices

## What's Preserved 📚

- ✅ Parse jobs (learning data)
- ✅ Line matches (learning data)
- ✅ Parsing corrections
- ✅ All table structures
- ✅ Users, roles, configuration
- ✅ Sysco data (if any)

---

## After Removal

✅ Console shows **0 GFS invoices**  
✅ Reports show **0 GFS invoices**  
✅ System ready for **fresh Sysco imports**  
✅ Learning data preserved for future parsing

---

**Ready? Start with Step 1 to get your token!** 🚀


