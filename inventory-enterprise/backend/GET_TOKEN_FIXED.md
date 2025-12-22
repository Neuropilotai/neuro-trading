# 🔑 How to Get Your Owner Token

## Problem: `localStorage.getItem('ownerToken')` returns `null`

This means you're **not logged in**. Here's how to fix it:

---

## ✅ Solution: Log In First, Then Get Token

### Step 1: Log In to Owner Console

1. Go to the login page:
   ```
   https://inventory-backend-production-3a2c.up.railway.app/owner-login.html
   ```

2. Enter your owner credentials:
   - Email: (your admin email from Railway env vars)
   - Password: (your admin password from Railway env vars)

3. Click **Login**

4. You'll be redirected to the console

---

### Step 2: Get Token from Console

1. **Stay on the console page** (don't navigate away)

2. Open Developer Tools:
   - Press `F12` or `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows)

3. Go to **Console** tab

4. Type this (copy-paste exactly):
   ```javascript
   localStorage.getItem('ownerToken')
   ```

5. Press **Enter**

6. Copy the token (it will look like: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`)

---

## 🔄 Alternative: Get Token from Network Tab (During Login)

If you prefer to capture it during login:

### Step 1: Open Network Tab Before Login

1. Go to: `https://inventory-backend-production-3a2c.up.railway.app/owner-login.html`

2. Open Developer Tools (`F12`)

3. Go to **Network** tab

4. Check **Preserve log** checkbox (important!)

### Step 2: Log In

1. Enter credentials and click **Login**

2. In Network tab, find the request: `login` or `/api/auth/login`

3. Click on it

4. Go to **Response** tab (or **Preview** tab)

5. Look for `"token"` in the response

6. Copy the token value

---

## 🚀 Quick Test: Check All localStorage Keys

If you want to see what's stored:

1. Open Console (F12 → Console tab)

2. Type:
   ```javascript
   Object.keys(localStorage)
   ```

3. This shows all stored keys

4. Then check each one:
   ```javascript
   localStorage.getItem('ownerToken')
   localStorage.getItem('token')
   localStorage.getItem('authToken')
   localStorage.getItem('NP_TOKEN')
   ```

---

## 📝 Once You Have the Token

Use it in your curl commands:

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
```

---

## ❓ Still Getting null?

1. **Make sure you're on the correct domain** (Railway URL, not localhost)
2. **Make sure you're logged in** (check if console page loads)
3. **Try logging out and logging back in**
4. **Check if cookies/localStorage is enabled** in your browser
5. **Try a different browser** or incognito mode

---

**Next Step:** Log in, then get your token! 🔑


