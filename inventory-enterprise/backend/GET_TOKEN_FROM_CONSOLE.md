# 🔑 Get Token from Console (You're Already Logged In!)

Since you're already on `console-v15.html` and it's working, you're **already logged in**! Just get your token from there.

---

## ✅ Step 1: Get Token from Console Page

**You're already on the right page!** Just follow these steps:

1. **Stay on:** `https://inventory-backend-production-3a2c.up.railway.app/console-v15.html`

2. **Open Developer Tools:**
   - Press `F12` or `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows)

3. **Go to Console tab**

4. **Type this and press Enter:**
   ```javascript
   localStorage.getItem('ownerToken')
   ```

5. **Copy the token** (it will look like: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`)

---

## ✅ Step 2: Check Analytics (See What Will Be Removed)

Open a **new terminal** and run (replace `YOUR_TOKEN_HERE` with your token):

```bash
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

This shows:
- 181 invoices ($2.13M)
- 3 vendor orders
- What will be preserved

---

## ✅ Step 3: Remove GFS Data

Run this command (replace `YOUR_TOKEN_HERE` with your token):

```bash
curl -X POST https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation": "REMOVE_GFS",
    "createBackup": true
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "GFS operational data removed successfully...",
  "stats": {
    "orders": 3,
    "invoices": 181,
    ...
  }
}
```

---

## ✅ Step 4: Verify Removal

1. **Refresh your console page** (`console-v15.html`)
2. Go to **Orders/PDF** section → Should show **0 GFS invoices**
3. Go to **Reports** section → Should show **0 GFS invoices** ($0.00)

---

## 🔍 Alternative: Get Token from Network Tab

If `localStorage.getItem('ownerToken')` still returns `null`, try this:

1. **Stay on console page** (`console-v15.html`)

2. **Open Developer Tools** → **Network tab**

3. **Refresh the page** (F5)

4. **Find any API request** (like `/api/owner/dashboard` or similar)

5. **Click on it** → Go to **Headers** tab

6. **Look for `Authorization: Bearer ...`** header

7. **Copy the token** (the part after `Bearer `)

---

## 📝 Complete Example

Once you have your token, here's the complete sequence:

```bash
# Replace YOUR_TOKEN_HERE with your actual token

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

# Step 3: Verify (should show 0 invoices)
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## ❓ If Token is Still null

Try these in the console (one at a time):

```javascript
// Check all localStorage keys
Object.keys(localStorage)

// Try different token keys
localStorage.getItem('ownerToken')
localStorage.getItem('token')
localStorage.getItem('authToken')
localStorage.getItem('NP_TOKEN')

// Check if you're logged in
localStorage.getItem('ownerUser')
```

If all return `null`, you might need to:
1. Log out and log back in
2. Or capture the token from Network tab during page load

---

**You're already logged in - just get the token from the console!** 🚀


