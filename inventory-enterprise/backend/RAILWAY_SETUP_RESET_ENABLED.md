# Railway Setup: RESET_ENABLED Environment Variable

**Step-by-step guide to enable the Targeted Reset Tool in Railway**

---

## 🎯 Goal

Set `RESET_ENABLED=true` in Railway to enable the Targeted Reset Tool endpoint in production.

---

## 📋 Step-by-Step Instructions

### Method 1: Railway Web Dashboard (Recommended)

#### Step 1: Access Railway Dashboard
1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. Login with your Railway account
3. Navigate to your project: **`inventory-backend-production`** (or your project name)

#### Step 2: Select Your Service
1. Click on your service/application (usually named something like `inventory-backend` or `backend`)
2. This will open the service details page

#### Step 3: Open Variables Tab
1. Click on the **"Variables"** tab in the top navigation
2. You'll see a list of existing environment variables

#### Step 4: Add New Variable
1. Click the **"+ New Variable"** button (usually in the top right)
2. A form will appear

#### Step 5: Enter Variable Details
- **Variable Name:** `RESET_ENABLED`
- **Variable Value:** `true`
- **Note:** Make sure the value is exactly `true` (lowercase, no quotes)

#### Step 6: Save
1. Click **"Add"** or **"Save"** button
2. Railway will automatically trigger a redeployment

#### Step 7: Verify Deployment
1. Go to the **"Deployments"** tab
2. You should see a new deployment starting
3. Wait 2-5 minutes for deployment to complete
4. Check the deployment logs for any errors

---

### Method 2: Railway CLI (Alternative)

If you have Railway CLI installed:

```bash
# Install Railway CLI (if not installed)
npm i -g @railway/cli

# Login to Railway
railway login

# Link to your project
railway link

# Set the environment variable
railway variables set RESET_ENABLED=true

# Verify it was set
railway variables
```

---

## ✅ Verification Steps

### 1. Check Variable is Set

**In Railway Dashboard:**
- Go to Variables tab
- Verify `RESET_ENABLED` appears in the list with value `true`

**Or via CLI:**
```bash
railway variables | grep RESET_ENABLED
# Should show: RESET_ENABLED=true
```

### 2. Check Deployment Status

**In Railway Dashboard:**
- Go to Deployments tab
- Latest deployment should show "Active" or "Success"
- Check logs for any errors

### 3. Test Endpoint (After Deployment Completes)

```bash
# This should return 401 (unauthorized) or 400 (bad request), NOT 404
curl -X POST "https://inventory-backend-production-3a2c.up.railway.app/api/admin/reset/target" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET"}'
```

**Expected Responses:**
- ✅ `401 Unauthorized` - Good! Endpoint exists, needs authentication
- ✅ `400 Bad Request` - Good! Endpoint exists, invalid request
- ❌ `404 Not Found` - Bad! Endpoint not deployed (check deployment logs)

---

## 🐛 Troubleshooting

### Variable Not Appearing
- **Issue:** Variable not showing in list
- **Solution:** Refresh the page, check if you're in the correct service

### Deployment Failing
- **Issue:** Deployment shows error after adding variable
- **Solution:** 
  - Check deployment logs for specific error
  - Verify variable name is exactly `RESET_ENABLED` (case-sensitive)
  - Verify value is exactly `true` (lowercase, no quotes)

### Endpoint Still Returns 403
- **Issue:** After setting variable, endpoint returns 403
- **Solution:**
  - Wait a few more minutes for deployment to complete
  - Verify variable is set correctly
  - Check if you're using owner JWT token
  - Verify user has owner role

### Endpoint Returns 404
- **Issue:** Endpoint not found
- **Solution:**
  - Check deployment logs - code may not have deployed
  - Verify `server-v21_1.js` was included in deployment
  - Check if route registration is correct
  - Wait longer for deployment to complete

---

## 📝 Quick Reference

**Variable Name:** `RESET_ENABLED`  
**Variable Value:** `true`  
**Location:** Railway Dashboard → Your Project → Service → Variables Tab  
**Effect:** Enables `/api/admin/reset/target` endpoint in production  
**Deployment:** Automatic (Railway redeploys when variables change)

---

## ⚠️ Important Notes

1. **Case Sensitive:** Variable name must be exactly `RESET_ENABLED` (uppercase)
2. **Value Format:** Value must be exactly `true` (lowercase, no quotes)
3. **Deployment Time:** Allow 2-5 minutes for deployment to complete
4. **Owner Only:** Endpoint requires owner role JWT token
5. **Temporary Bypass:** Currently allows owner role to bypass this check (will be removed later)

---

## 🎯 Next Steps After Setup

Once `RESET_ENABLED=true` is set and deployment completes:

1. **Test Endpoint Access:**
   ```bash
   curl -X POST "$BASE_URL/api/admin/reset/target" \
     -H "Content-Type: application/json" \
     -d '{"confirm":"RESET"}'
   ```

2. **Run Dry Run Test:**
   See `TARGETED_RESET_POST_PUSH.md` for dry-run test instructions

3. **Verify Everything Works:**
   - Endpoint accessible (not 404)
   - Dry-run returns counts
   - No errors in logs

---

## 📚 Related Documentation

- `TARGETED_RESET_POST_PUSH.md` - Post-deployment testing
- `TARGETED_RESET_QUICK_START.md` - Quick start guide
- `TARGETED_RESET_GUIDE.md` - Complete documentation

---

**Last Updated:** 2025-01-20  
**Status:** Ready for setup


