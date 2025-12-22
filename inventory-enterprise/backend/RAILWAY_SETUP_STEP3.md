# Railway Setup - Step 3: Google Drive Configuration

## Share Folders with Service Account

The service account needs "Editor" access to both INBOX and PROCESSED folders.

### Step 1: Get Service Account Email

From your service account JSON key, find the `client_email` field:

```json
{
  "type": "service_account",
  "project_id": "your-project",
  "private_key_id": "...",
  "private_key": "...",
  "client_email": "sysco-import@your-project.iam.gserviceaccount.com",  ← This one
  ...
}
```

**Example:** `sysco-import-123@my-project.iam.gserviceaccount.com`

### Step 2: Share INBOX Folder

1. Open Google Drive
2. Navigate to the INBOX folder (or use this link):
   - https://drive.google.com/open?id=12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l
3. Right-click the folder → **Share**
4. In the "Add people and groups" field, paste the service account email
5. Set permission to **Editor**
6. Uncheck "Notify people" (service accounts don't need notifications)
7. Click **Share**

### Step 3: Share PROCESSED Folder

1. Navigate to the PROCESSED folder (or use this link):
   - https://drive.google.com/open?id=1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R
2. Right-click the folder → **Share**
3. Add the same service account email
4. Set permission to **Editor**
5. Uncheck "Notify people"
6. Click **Share**

### Step 4: Verify Access

Test the connection:

```bash
# Via API
curl https://your-url/api/admin/sysco/status \
  -H "Authorization: Bearer TOKEN"

# Or check Railway logs for:
# [GoogleDriveService] Connected as: <service-account-email>
```

## Troubleshooting

### "403 Forbidden" Error
- **Fix:** Verify service account has "Editor" access (not "Viewer")
- **Fix:** Check folder IDs are correct
- **Fix:** Ensure service account email matches JSON key

### "404 Not Found" Error
- **Fix:** Verify folder IDs are correct
- **Fix:** Check folders exist and are accessible
- **Fix:** Ensure folders are shared (not just in "My Drive")

### Service Account Not Appearing
- **Fix:** Use the exact email from JSON key (`client_email` field)
- **Fix:** Service accounts don't appear in "My Drive" - they access shared folders directly

## Next Step

After Google Drive is configured, proceed to Step 4: Test the System

See `RAILWAY_SETUP_STEP4.md` for testing instructions.



