# 🚀 Quick Deploy - Sysco Import

## 3-Step Deployment

### Step 1: Push Code
```bash
git add .
git commit -m "Add Sysco invoice import system"
git push origin main
```

### Step 2: Run Migration
In Railway Dashboard → Database → Query:
```sql
-- Copy/paste contents of: migrations/postgres/042_sysco_invoices.sql
```

### Step 3: Set Environment Variables
Railway → Variables → Add:
- `GOOGLE_SERVICE_ACCOUNT_KEY` = (your JSON key)
- `GDRIVE_INBOX_FOLDER_ID` = `12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l`
- `GDRIVE_PROCESSED_FOLDER_ID` = `1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R`
- `SYSCO_IMPORT_ENABLED` = `true`

**Don't forget:** Share Google Drive folders with service account email!

## Test
```bash
curl -X POST https://your-url/api/admin/sysco/import \
  -H "Authorization: Bearer TOKEN" \
  -d '{"dryRun": true}'
```

Done! 🎉

