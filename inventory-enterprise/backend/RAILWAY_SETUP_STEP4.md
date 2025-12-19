# Railway Setup - Step 4: Test the System

## Verify Deployment

### 1. Check Server Logs

In Railway Dashboard → Deployments → Latest → Logs

Look for:
```
[STARTUP] ✓ sysco-import loaded
[STARTUP] ✓ Sysco import cron scheduled: */15 * * * *
```

If you see these, the routes are loaded correctly.

### 2. Test Status Endpoint

```bash
curl https://your-railway-url.up.railway.app/api/admin/sysco/status \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

**Expected response:**
```json
{
  "success": true,
  "latestJob": null,
  "invoiceStats": {
    "total_invoices": 0,
    "completed": 0,
    "failed": 0
  },
  "recentInvoices": []
}
```

### 3. Test Import (Dry Run)

```bash
curl -X POST https://your-railway-url.up.railway.app/api/admin/sysco/import \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

**Expected response:**
```json
{
  "success": true,
  "jobId": "...",
  "filesFound": 0,
  "filesProcessed": 0,
  "filesSkipped": 0,
  "filesFailed": 0,
  "errors": []
}
```

### 4. Test with Real File

1. Place a test Sysco invoice PDF in the INBOX folder
2. Trigger import:
   ```bash
   curl -X POST https://your-railway-url/api/admin/sysco/import \
     -H "Authorization: Bearer TOKEN" \
     -d '{"dryRun": false}'
   ```
3. Check response for processing results
4. Verify file moved to PROCESSED folder
5. Check database for invoice record

### 5. Verify Database

```sql
-- Check invoice was created
SELECT * FROM sysco_invoices ORDER BY created_at DESC LIMIT 5;

-- Check line items
SELECT * FROM sysco_invoice_lines ORDER BY created_at DESC LIMIT 10;

-- Check import job
SELECT * FROM sysco_import_jobs ORDER BY started_at DESC LIMIT 1;
```

## Common Issues

### 401 Unauthorized
- **Fix:** Ensure using owner token (not regular user token)
- **Fix:** Check token hasn't expired
- **Fix:** Verify `requireOwner` middleware is working

### 500 Internal Server Error
- **Fix:** Check Railway logs for specific error
- **Fix:** Verify database migration ran successfully
- **Fix:** Check environment variables are set correctly

### Google Drive Errors
- **Fix:** Verify service account has Editor access
- **Fix:** Check `GOOGLE_SERVICE_ACCOUNT_KEY` is valid JSON
- **Fix:** Ensure folder IDs are correct

### No Files Found
- **Fix:** Verify files are PDFs in INBOX folder
- **Fix:** Check folder ID is correct
- **Fix:** Ensure service account can access folder

## Success Indicators

✅ Status endpoint returns 200
✅ Dry run completes without errors
✅ Real import processes successfully
✅ Invoice appears in database
✅ File moves to PROCESSED folder
✅ Line items extracted correctly

## Next Steps

Once testing passes:
1. Enable cron job (if not already): `SYSCO_IMPORT_ENABLED=true`
2. Monitor first few imports
3. Review parsing confidence scores
4. Adjust parser patterns if needed
5. Start regular imports

---

**System is ready for production use!** 🚀

