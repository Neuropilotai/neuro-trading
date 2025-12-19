# 🗑️ Remove GFS Data - Quick Guide

You have **181 invoices ($2.13M)** and **3 PDFs** showing in the console. Here's how to remove them:

## Option 1: Via API (Recommended)

### Step 1: Get Analytics First

```bash
curl https://your-railway-url.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

This shows you what will be removed.

### Step 2: Remove GFS Data

```bash
curl -X POST https://your-railway-url.up.railway.app/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation": "REMOVE_GFS",
    "createBackup": true
  }'
```

**Parameters:**
- `confirmation`: Must be exactly `"REMOVE_GFS"` (required)
- `createBackup`: `true` to create backup before removal (optional, recommended)

### Step 3: Verify Removal

After removal, check:
- Console → Orders/PDFs → Should show 0 GFS invoices
- Reports → Should show 0 GFS invoices

---

## Option 2: Via Owner Console UI

1. Open owner console: `https://your-url/console-v15.html`
2. Navigate to Sysco Import section
3. Click "GFS Analytics" to see what will be removed
4. Click "Remove GFS Data"
5. Confirm with `REMOVE_GFS`

---

## Option 3: Via CLI Script

```bash
cd /Users/davidmikulis/neuro-inventory-enterprise/inventory-enterprise/backend
node scripts/remove-gfs-data.js
```

Follow the prompts:
1. Review analytics report
2. Choose to create backup (recommended: `y`)
3. Type `REMOVE_GFS` to confirm

---

## What Gets Removed

✅ **Removed:**
- GFS vendor orders (3 orders)
- GFS invoices (181 invoices, $2.13M)
- GFS invoice line items
- GFS FIFO cost layers
- GFS reconciliation links
- GFS processed invoices

✅ **Preserved (Learning Data):**
- Parse jobs (`vendor_invoice_parse_jobs`)
- Line matches (`vendor_invoice_line_matches`)
- Parsing corrections
- All table structures
- Users, roles, configuration

---

## After Removal

1. ✅ System will be clean for fresh Sysco imports
2. ✅ Learning data preserved for future parsing
3. ✅ Console will show 0 GFS invoices
4. ✅ Reports will show 0 GFS invoices

---

## Troubleshooting

### 401 Unauthorized
- Ensure you're using an **owner token** (not regular user token)
- Token must have `requireOwner` access

### 500 Error
- Check Railway logs for specific error
- Ensure database connection is working
- Verify `sysco_import_jobs` table exists (run migration first)

### Data Still Showing
- Hard refresh browser (Cmd+Shift+R / Ctrl+Shift+R)
- Clear browser cache
- Check if data is cached in frontend

---

**Ready to remove? Use Option 1 (API) for fastest execution!** 🚀

