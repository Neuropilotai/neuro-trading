# 🚂 Railway Quick Setup Guide

## 3-Step Setup for Sysco Import

### Step 1: Database Migration ⚡

**Railway Dashboard → Database → Query**

Copy and paste this entire SQL file:
```
migrations/postgres/042_sysco_invoices.sql
```

Click **Run**

---

### Step 2: Environment Variables ⚡

**Railway Dashboard → Variables → Add:**

```
GOOGLE_SERVICE_ACCOUNT_KEY = <paste your JSON key>
GDRIVE_INBOX_FOLDER_ID = 12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l
GDRIVE_PROCESSED_FOLDER_ID = 1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R
SYSCO_IMPORT_ENABLED = true
```

---

### Step 3: Google Drive Setup ⚡

1. Get service account email from JSON key (`client_email` field)
2. Share INBOX folder with service account (Editor access)
3. Share PROCESSED folder with service account (Editor access)

**Folder Links:**
- INBOX: https://drive.google.com/open?id=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l
- PROCESSED: https://drive.google.com/open?id=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R

---

## Verify Setup

```bash
# Test status
curl https://your-url/api/admin/sysco/status \
  -H "Authorization: Bearer TOKEN"

# Test import (dry run)
curl -X POST https://your-url/api/admin/sysco/import \
  -H "Authorization: Bearer TOKEN" \
  -d '{"dryRun": true}'
```

---

## Detailed Guides

- `RAILWAY_SETUP_STEP1.md` - Database migration details
- `RAILWAY_SETUP_STEP2.md` - Environment variables details
- `RAILWAY_SETUP_STEP3.md` - Google Drive setup details
- `RAILWAY_SETUP_STEP4.md` - Testing instructions

---

**Ready to go!** 🚀

