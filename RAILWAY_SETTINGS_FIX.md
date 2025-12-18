# Railway Dashboard Settings - EXACT FIXES NEEDED

## Current Settings (WRONG)
- Root Directory: `inventory-enterprise/backend` ❌
- Watch Paths: `**/*` ❌
- Start Command: `npm run start:postgres` ❌

## Required Changes

### 1. Root Directory
**Current**: `inventory-enterprise/backend`  
**Change to**: `backend`

**Steps**:
1. In Railway Dashboard → Settings → Source
2. Find "Root Directory" field
3. Change from `inventory-enterprise/backend` to `backend`
4. Click "Update"

### 2. Watch Paths
**Current**: `**/*`  
**Change to**: Remove the pattern entirely OR change to `backend/**/*`

**Steps**:
1. In Railway Dashboard → Settings → Build
2. Find "Watch Paths" section
3. Click the "X" next to `**/*` to remove it
4. OR change it to: `backend/**/*`
5. Click "Update"

### 3. Start Command
**Current**: `npm run start:postgres`  
**Change to**: `cd backend && node server.js`

**Steps**:
1. In Railway Dashboard → Settings → Deploy
2. Find "Custom Start Command" field
3. Change from `npm run start:postgres` to `cd backend && node server.js`
4. Click "Update"

**OR** (Better option): Remove the custom start command entirely and let `railway.toml` handle it

**Steps to use railway.toml**:
1. In Railway Dashboard → Settings → Deploy
2. Find "Custom Start Command" field
3. Clear/delete the command: `npm run start:postgres`
4. Leave it empty (Railway will use `railway.toml`)
5. Click "Update"

## After Making Changes

1. Go to **Deployments** tab
2. Click **"Deploy"** button
3. Select **"Deploy Latest Commit"**
4. Watch the build logs to verify:
   - Build command: `cd backend && npm install`
   - Start command: `cd backend && node server.js`

## Verification

After deployment completes, check:
- ✅ Build logs show correct paths
- ✅ Server starts with: `🚀 Secure Inventory backend running on port`
- ✅ `/health` endpoint returns 200 OK
- ✅ `/console-v15.html` loads successfully

