# 🗑️ Execute GFS Removal - Use Your Actual Token

You already have:
- ✅ Console working at `console-v15.html`
- ✅ 181 invoices ($2.13M) showing in reports
- ✅ 3 PDFs showing in Orders/PDF

Let's remove them **now** using your actual token.

---

## Step 1: Get Your Token (Network Tab)

1. **On your console page**, open **Developer Tools** (F12)
2. **Network tab**
3. **Refresh page** or click any button
4. **Click any API request** (like `/api/owner/dashboard`)
5. **Headers tab** → **Request Headers**
6. **Find `Authorization: Bearer ...`**
7. **Copy the token** (everything after `Bearer `)

---

## Step 2: Run Removal Commands

**Replace `YOUR_ACTUAL_TOKEN` with the token you just copied:**

```bash
# Check what will be removed
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_ACTUAL_TOKEN"

# Remove GFS data
curl -X POST https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_ACTUAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation": "REMOVE_GFS",
    "createBackup": true
  }'

# Verify removal (should show 0)
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_ACTUAL_TOKEN"
```

---

## Or: Use the Quick Script

If you have your token, I can create a script that uses it directly.

**Just paste your token here and I'll create the exact commands for you.**

---

**Ready? Get your token from Network tab and run the commands above!** 🚀


