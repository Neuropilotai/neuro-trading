# Sysco Import Setup Guide

Quick setup guide for the Sysco invoice import system.

## Step 1: Run Database Migration

```bash
psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql
```

Or if using Railway/cloud:
```bash
railway run psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql
```

## Step 2: Configure Environment Variables

Add to your `.env` file or Railway dashboard:

```bash
# Google Drive Service Account (required)
GOOGLE_SERVICE_ACCOUNT_KEY=<base64-encoded-json-or-raw-json>

# Google Drive Folder IDs (required)
GDRIVE_INBOX_FOLDER_ID=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l
GDRIVE_PROCESSED_FOLDER_ID=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R

# Enable automated imports (optional, default: false)
SYSCO_IMPORT_ENABLED=true

# Cron schedule (optional, default: every 15 minutes)
SYSCO_IMPORT_SCHEDULE=*/15 * * * *

# Auto-update inventory (optional, default: false)
SYSCO_AUTO_UPDATE_INVENTORY=true
```

## Step 3: Google Drive Setup

1. **Create Service Account:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - IAM & Admin → Service Accounts
   - Create new service account
   - Download JSON key file

2. **Share Folders:**
   - Open Google Drive
   - Right-click INBOX folder → Share
   - Add service account email (from JSON key: `client_email`)
   - Grant "Editor" access
   - Repeat for PROCESSED folder

3. **Set Environment Variable:**
   ```bash
   # Option 1: Base64 encode
   cat service-account-key.json | base64 > key.b64
   GOOGLE_SERVICE_ACCOUNT_KEY=$(cat key.b64)
   
   # Option 2: Raw JSON (works too)
   GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'
   ```

## Step 4: Verify Setup

Run the test script:

```bash
node scripts/test-sysco-import.js
```

Expected output:
```
✅ All tests passed! System is ready.
```

## Step 5: Test Manual Import

```bash
# Get owner token first (from login)
TOKEN="your-owner-token"

# Dry run (test without processing)
curl -X POST http://localhost:8080/api/admin/sysco/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'

# Real import
curl -X POST http://localhost:8080/api/admin/sysco/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

## Step 6: Check Status

```bash
curl http://localhost:8080/api/admin/sysco/status \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Troubleshooting

### Migration Fails
- Check PostgreSQL connection: `psql $DATABASE_URL -c "SELECT 1"`
- Verify you have CREATE TABLE permissions
- Check if tables already exist: `\dt sysco_*`

### Google Drive Access Denied
- Verify service account email has "Editor" access to both folders
- Check service account key is valid JSON
- Test connection: `node -e "require('./services/GoogleDriveService').testConnection()"`

### Import Returns 401
- Ensure you're using owner token (not regular user token)
- Check token hasn't expired
- Verify `requireOwner` middleware is working

### Files Not Processing
- Check server logs for `[SyscoImport]` messages
- Verify files are PDFs in INBOX folder
- Check `sysco_import_jobs` table for error details
- Ensure cron is enabled: `SYSCO_IMPORT_ENABLED=true`

## Production Deployment

1. **Railway:**
   - Add all environment variables in Railway dashboard
   - Deploy code
   - Run migration via Railway CLI or SQL tab

2. **Verify:**
   - Check `/api/admin/sysco/status` endpoint
   - Monitor logs for cron job execution
   - Test with a sample PDF in INBOX

## Next Steps

- Monitor first few imports manually
- Review parsed data in database
- Adjust parser patterns if needed (in `SyscoInvoiceParser.js`)
- Set up corrections for any parsing issues
- Enable inventory updates if desired

For detailed documentation, see `SYSCO_IMPORT_README.md`.

