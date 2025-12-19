# Fresh Start Checklist - GFS to Sysco Migration

Complete checklist for transitioning from GFS to Sysco invoice processing.

## Pre-Cleanup

- [ ] Review current GFS data volume
- [ ] Check analytics: `GET /api/admin/sysco/gfs-analytics`
- [ ] Verify Sysco import system is deployed
- [ ] Ensure Sysco migration is run: `042_sysco_invoices.sql`
- [ ] Test Sysco import endpoint (dry run)

## Cleanup Process

### Step 1: Get Analytics Report

**Via API:**
```bash
curl https://your-url/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN" | jq
```

**Via CLI:**
```bash
node scripts/remove-gfs-data.js
# Review the analytics report shown
```

### Step 2: Create Backup (Recommended)

**Via API:**
```bash
curl -X POST https://your-url/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "REMOVE_GFS", "createBackup": true}'
```

**Via CLI:**
```bash
node scripts/remove-gfs-data.js
# Answer 'y' when asked about backup
```

### Step 3: Remove GFS Data

**Via API:**
```bash
curl -X POST https://your-url/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "REMOVE_GFS"}'
```

**Via CLI:**
```bash
node scripts/remove-gfs-data.js
# Type "REMOVE_GFS" when prompted
```

## Post-Cleanup Verification

### Database Checks

```sql
-- Should be 0
SELECT COUNT(*) FROM vendor_orders WHERE vendor_name ILIKE '%GFS%';
SELECT COUNT(*) FROM invoices WHERE vendor_name ILIKE '%GFS%';

-- Should be > 0 (learning data preserved)
SELECT COUNT(*) FROM vendor_invoice_parse_jobs WHERE detected_vendor_name ILIKE '%GFS%';
SELECT COUNT(*) FROM vendor_invoice_line_matches vilm
JOIN vendor_invoice_parse_jobs vpj ON vilm.parse_job_id = vpj.id
WHERE vpj.detected_vendor_name ILIKE '%GFS%';
```

### System Checks

- [ ] Verify no GFS orders in system
- [ ] Verify no GFS invoices in system
- [ ] Confirm learning data exists
- [ ] Test Sysco import endpoint
- [ ] Check system logs for errors

## Sysco Setup

- [ ] Google Drive folders configured
- [ ] Service account has access
- [ ] Environment variables set
- [ ] Cron job enabled (if desired)
- [ ] Test import with sample PDF

## First Sysco Import

1. Place test Sysco invoice PDF in INBOX folder
2. Trigger manual import (or wait for cron)
3. Verify invoice appears in database
4. Check line items extracted correctly
5. Confirm file moved to PROCESSED folder
6. Review parsing confidence scores

## Success Criteria

✅ All GFS operational data removed
✅ Learning data preserved
✅ Sysco import system functional
✅ First Sysco invoice processed successfully
✅ System learning from new invoices
✅ No errors in logs

---

**Status:** ☐ Not Started  ☐ In Progress  ☐ Complete

