# Sysco Invoice Import - Environment Variables

Add these environment variables to your `.env` file or Railway dashboard:

## Google Drive Configuration

```bash
# Google Drive Service Account Key (base64-encoded JSON or raw JSON)
# Get this from Google Cloud Console -> IAM & Admin -> Service Accounts
# Create a service account, download the JSON key, then either:
# 1. Base64 encode it: cat key.json | base64
# 2. Or paste the raw JSON (will be auto-detected)
GOOGLE_SERVICE_ACCOUNT_KEY=<your-service-account-key>

# Google Drive Folder IDs (extracted from Drive links)
# INBOX: https://drive.google.com/open?id=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l
GDRIVE_INBOX_FOLDER_ID=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l

# PROCESSED: https://drive.google.com/open?id=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R
GDRIVE_PROCESSED_FOLDER_ID=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R
```

## Sysco Import Configuration

```bash
# Enable Sysco import cron job
SYSCO_IMPORT_ENABLED=true

# Cron schedule (default: every 15 minutes)
# Format: minute hour day month day-of-week
# Examples:
#   */15 * * * *  - Every 15 minutes
#   0 */1 * * *   - Every hour
#   0 2 * * *     - Daily at 2 AM
SYSCO_IMPORT_SCHEDULE=*/15 * * * *

# Automatically update inventory when invoices are imported
# Set to 'true' to create inventory_transactions for each invoice line
SYSCO_AUTO_UPDATE_INVENTORY=true
```

## Setup Instructions

1. **Create Google Service Account:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Navigate to IAM & Admin -> Service Accounts
   - Create a new service account
   - Download the JSON key file
   - Grant the service account "Editor" access to the INBOX and PROCESSED folders in Google Drive

2. **Set Environment Variables:**
   - Add the variables above to your `.env` file (local) or Railway dashboard (production)
   - For Railway: Go to your project -> Variables tab -> Add each variable

3. **Verify Setup:**
   - Run the migration: `psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql`
   - Test the import manually: `POST /api/admin/sysco/import` (with owner token)
   - Check status: `GET /api/admin/sysco/status`

## Notes

- The service account email must have "Editor" access to both Google Drive folders
- Files are only moved to PROCESSED after successful database commit
- Failed imports are stored in the database with error details
- The system is idempotent - duplicate files are automatically skipped

