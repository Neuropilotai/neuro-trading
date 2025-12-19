# 🚀 Deploy Now - Quick Instructions

## Option 1: Use the Deployment Script

```bash
cd /Users/davidmikulis/neuro-inventory-enterprise/inventory-enterprise/backend
./scripts/deploy-now.sh
```

## Option 2: Manual Git Commands

If the script doesn't work, run these manually:

```bash
cd /Users/davidmikulis/neuro-inventory-enterprise/inventory-enterprise/backend

# Stage files
git add migrations/postgres/042_sysco_invoices.sql
git add src/finance/SyscoInvoiceParser.js
git add services/SyscoImportService.js
git add routes/sysco-import.js
git add scripts/*.js scripts/*.sh
git add server-v21_1.js
git add *.md

# Commit
git commit -m "Add Sysco invoice import system with Google Drive integration"

# Push
git push origin main
```

## After Pushing

### 1. Run Database Migration

In Railway Dashboard:
- Go to your project → Database → Query
- Copy contents of `migrations/postgres/042_sysco_invoices.sql`
- Paste and execute

### 2. Set Environment Variables

Railway → Variables → Add:

```
GOOGLE_SERVICE_ACCOUNT_KEY=<your-json-key>
GDRIVE_INBOX_FOLDER_ID=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l
GDRIVE_PROCESSED_FOLDER_ID=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R
SYSCO_IMPORT_ENABLED=true
SYSCO_IMPORT_SCHEDULE=*/15 * * * *
SYSCO_AUTO_UPDATE_INVENTORY=true
```

### 3. Google Drive Setup

1. Get service account email from JSON key (`client_email` field)
2. Share INBOX folder with service account (Editor access)
3. Share PROCESSED folder with service account (Editor access)

### 4. Verify Deployment

Check Railway logs for:
```
[STARTUP] ✓ sysco-import loaded
[STARTUP] ✓ Sysco import cron scheduled: */15 * * * *
```

### 5. Test

```bash
curl -X POST https://your-railway-url/api/admin/sysco/import \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

## Files Ready to Deploy

✅ `migrations/postgres/042_sysco_invoices.sql`
✅ `src/finance/SyscoInvoiceParser.js`
✅ `services/SyscoImportService.js`
✅ `routes/sysco-import.js`
✅ `scripts/reset-system-sysco.js`
✅ `scripts/test-sysco-import.js`
✅ `server-v21_1.js` (modified)
✅ All documentation files

---

**Ready to deploy!** 🚀

