# Railway Setup - Step 2: Environment Variables

## Set Environment Variables in Railway

Go to Railway Dashboard → Your Project → **Variables** tab → **Add Variable**

### Required Variables

#### 1. Google Service Account Key
```
Name: GOOGLE_SERVICE_ACCOUNT_KEY
Value: <paste your service account JSON key>
```

**How to get:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. IAM & Admin → Service Accounts
3. Create or select service account
4. Create Key → JSON
5. Download JSON file
6. Copy entire JSON content and paste as value

**Or base64 encode:**
```bash
cat service-account-key.json | base64
# Paste the base64 string as value
```

#### 2. Google Drive INBOX Folder ID
```
Name: GDRIVE_INBOX_FOLDER_ID
Value: 12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l
```

#### 3. Google Drive PROCESSED Folder ID
```
Name: GDRIVE_PROCESSED_FOLDER_ID
Value: 1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R
```

### Optional Variables

#### 4. Enable Sysco Import Cron
```
Name: SYSCO_IMPORT_ENABLED
Value: true
```

#### 5. Cron Schedule (if different from default)
```
Name: SYSCO_IMPORT_SCHEDULE
Value: */15 * * * *
```
Default: Every 15 minutes

#### 6. Auto-Update Inventory
```
Name: SYSCO_AUTO_UPDATE_INVENTORY
Value: true
```
If true, automatically creates inventory transactions for invoice lines

## Verify Variables

After setting, Railway will automatically redeploy. Check logs for:
```
[STARTUP] ✓ sysco-import loaded
[STARTUP] ✓ Sysco import cron scheduled: */15 * * * *
```

## Next Step

After variables are set, proceed to Step 3: Google Drive Setup

See `RAILWAY_SETUP_STEP3.md` for Google Drive configuration.



