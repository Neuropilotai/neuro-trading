# Sysco Import Deployment Checklist

Use this checklist to ensure a smooth deployment of the Sysco invoice import system.

## Pre-Deployment

### Code Verification
- [x] All files created and syntax validated
- [x] Routes registered in `server-v21_1.js`
- [x] Cron job configured in `server-v21_1.js`
- [x] Database migration file created

### Database
- [ ] Backup production database
- [ ] Review migration: `migrations/postgres/042_sysco_invoices.sql`
- [ ] Test migration on staging database first

### Environment Variables
- [ ] `GOOGLE_SERVICE_ACCOUNT_KEY` - Service account JSON key
- [ ] `GDRIVE_INBOX_FOLDER_ID=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l`
- [ ] `GDRIVE_PROCESSED_FOLDER_ID=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R`
- [ ] `SYSCO_IMPORT_ENABLED=true` (to enable cron)
- [ ] `SYSCO_IMPORT_SCHEDULE=*/15 * * * *` (optional, default: every 15 min)
- [ ] `SYSCO_AUTO_UPDATE_INVENTORY=true` (optional, if you want auto inventory updates)

## Deployment Steps

### 1. Deploy Code
```bash
# Commit and push changes
git add .
git commit -m "Add Sysco invoice import system"
git push origin main

# Railway will auto-deploy, or trigger manually
```

### 2. Run Database Migration

**Option A: Via Railway CLI**
```bash
railway run psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql
```

**Option B: Via Railway Dashboard**
1. Go to Railway project → Database → Query
2. Copy contents of `migrations/postgres/042_sysco_invoices.sql`
3. Paste and execute

**Option C: Via psql directly**
```bash
psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql
```

### 3. Set Environment Variables in Railway

1. Go to Railway project → Variables
2. Add each environment variable:
   - `GOOGLE_SERVICE_ACCOUNT_KEY` (paste JSON or base64)
   - `GDRIVE_INBOX_FOLDER_ID=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l`
   - `GDRIVE_PROCESSED_FOLDER_ID=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R`
   - `SYSCO_IMPORT_ENABLED=true`
   - `SYSCO_IMPORT_SCHEDULE=*/15 * * * *` (optional)
   - `SYSCO_AUTO_UPDATE_INVENTORY=true` (optional)

### 4. Google Drive Setup

1. **Get Service Account Email:**
   - From the JSON key, find `client_email` field
   - Example: `sysco-import@project-id.iam.gserviceaccount.com`

2. **Share Folders:**
   - Open Google Drive
   - Right-click INBOX folder → Share
   - Add service account email
   - Grant "Editor" access
   - Repeat for PROCESSED folder

3. **Verify Access:**
   - Service account should be able to list files in both folders
   - Test with: `node scripts/test-sysco-import.js`

### 5. Restart Server

Railway will auto-restart after environment variable changes, or:
```bash
# Via Railway CLI
railway restart

# Or trigger redeploy in Railway dashboard
```

## Post-Deployment Verification

### 1. Check Server Logs
```bash
# Look for these messages in Railway logs:
[STARTUP] ✓ sysco-import loaded
[STARTUP] ✓ Sysco import cron scheduled: */15 * * * *
```

### 2. Test API Endpoints

**Get Status:**
```bash
curl https://your-railway-url.up.railway.app/api/admin/sysco/status \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

**Manual Import (Dry Run):**
```bash
curl -X POST https://your-railway-url.up.railway.app/api/admin/sysco/import \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

### 3. Verify Database Tables
```sql
-- Check tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name LIKE 'sysco_%';

-- Check for any existing data
SELECT COUNT(*) FROM sysco_invoices;
SELECT COUNT(*) FROM sysco_import_jobs;
```

### 4. Test Google Drive Connection
```bash
# Run test script (if you have local access)
node scripts/test-sysco-import.js
```

### 5. Monitor First Import

1. Place a test PDF in the INBOX folder
2. Wait for cron job (or trigger manually)
3. Check logs for processing messages
4. Verify file moved to PROCESSED folder
5. Check database for invoice record

## Troubleshooting

### Migration Fails
- **Error:** `relation "sysco_invoices" already exists`
  - **Fix:** Tables already exist, migration is idempotent (safe to ignore)

- **Error:** `permission denied`
  - **Fix:** Check database user has CREATE TABLE permissions

### Google Drive Access Denied
- **Error:** `403 Forbidden` or `404 Not Found`
  - **Fix:** Verify service account email has "Editor" access to both folders
  - **Fix:** Check folder IDs are correct

### Import Not Running
- **Issue:** Cron job not executing
  - **Fix:** Check `SYSCO_IMPORT_ENABLED=true` is set
  - **Fix:** Check server logs for cron errors
  - **Fix:** Verify cron schedule format is correct

### Files Not Processing
- **Issue:** Files stay in INBOX
  - **Fix:** Check server logs for `[SyscoImport]` messages
  - **Fix:** Verify PDFs are valid and not corrupted
  - **Fix:** Check `sysco_import_jobs` table for error details

### API Returns 401
- **Issue:** Unauthorized error
  - **Fix:** Ensure using owner token (not regular user token)
  - **Fix:** Check token hasn't expired
  - **Fix:** Verify `requireOwner` middleware is working

## Rollback Plan

If deployment fails:

1. **Remove Environment Variables:**
   - Set `SYSCO_IMPORT_ENABLED=false` to disable cron
   - Remove other Sysco-related variables (optional)

2. **Database Rollback (if needed):**
   ```sql
   -- Only if you need to remove tables
   DROP TABLE IF EXISTS sysco_invoice_lines CASCADE;
   DROP TABLE IF EXISTS sysco_parsing_corrections CASCADE;
   DROP TABLE IF EXISTS sysco_import_jobs CASCADE;
   DROP TABLE IF EXISTS sysco_invoices CASCADE;
   ```

3. **Code Rollback:**
   - Revert git commit
   - Redeploy previous version

## Success Criteria

✅ Database migration runs successfully
✅ All environment variables are set
✅ Google Drive folders are accessible
✅ Server starts without errors
✅ API endpoints respond correctly
✅ Test import processes successfully
✅ Files move from INBOX to PROCESSED
✅ Invoice data appears in database

## Monitoring

After deployment, monitor:
- Server logs for `[SyscoImport]` messages
- `sysco_import_jobs` table for job history
- `sysco_invoices` table for processed invoices
- Google Drive folders for file movement
- API endpoint `/api/admin/sysco/status` for statistics

## Support

- Documentation: `SYSCO_IMPORT_README.md`
- Setup Guide: `SYSCO_IMPORT_SETUP.md`
- Environment Variables: `SYSCO_IMPORT_ENV.md`
- Test Script: `node scripts/test-sysco-import.js`

---

**Deployment Date:** _______________
**Deployed By:** _______________
**Status:** ☐ In Progress  ☐ Complete  ☐ Rolled Back

