# Enable Reset in Railway - Quick Guide

## Problem
You're getting: `403 Forbidden - Reset disabled in production`

## Solution: Add Environment Variable

### Step 1: Go to Railway Dashboard
1. Open https://railway.app
2. Select your project: `inventory-backend`
3. Click on the service (not the database)

### Step 2: Add Variable
1. Click on **"Variables"** tab
2. Click **"+ New Variable"**
3. Enter:
   - **Name:** `RESET_ENABLED`
   - **Value:** `true`
4. Click **"Add"**

### Step 3: Redeploy
Railway will automatically redeploy. Wait 1-2 minutes.

### Step 4: Test Again
Run the reset code in browser console again.

---

## Alternative: Temporary Bypass (NOT RECOMMENDED)

If you need to reset immediately without waiting for Railway redeploy, you can temporarily modify the code to bypass the check. **Only do this if you understand the risks.**

The check is in `routes/admin-reset.js` line 53:
```javascript
if (process.env.NODE_ENV === 'production' && process.env.RESET_ENABLED !== 'true') {
```

You could temporarily comment it out, but **remember to revert it after** for security.

---

## Verify Variable is Set

After adding the variable, check Railway logs for:
```
[STARTUP] Environment: RESET_ENABLED=true
```

Or test with:
```bash
curl https://your-url/api/admin/reset/target \
  -H "Authorization: Bearer TOKEN" \
  -d '{"confirm":"RESET","dryRun":true}'
```

If you still get 403, the variable might not be set correctly.

