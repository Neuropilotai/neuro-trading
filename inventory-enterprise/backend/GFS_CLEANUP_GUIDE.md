# GFS Data Cleanup Guide - Fresh Start for Sysco

## Overview

This guide helps you remove GFS operational data while preserving learning data, allowing the system to start fresh with Sysco invoices while maintaining the ability to learn from past parsing experiences.

## What Gets Removed (Operational Data)

- ✅ GFS vendor orders (`vendor_orders`)
- ✅ GFS vendor order lines (`vendor_order_lines`)
- ✅ GFS vendor order cases (`vendor_order_cases`)
- ✅ GFS invoices (`invoices`)
- ✅ GFS invoice line items (`invoice_line_items`)
- ✅ GFS FIFO cost layers (`fifo_cost_layers`)
- ✅ GFS invoice reconciliation links (`invoice_reconciliation`)
- ✅ GFS processed invoices (`processed_invoices`)

## What Gets Preserved (Learning Data)

- 📚 **Parse jobs** (`vendor_invoice_parse_jobs`) - Learning from past parsing
- 📚 **Line matches** (`vendor_invoice_line_matches`) - Pattern recognition data
- 📚 **Parsing corrections** - User corrections and mappings
- 🔒 **All table structures** - Database schema intact
- 🔒 **Users, roles, tenants** - Authentication and access control
- 🔒 **Sysco data** - Any existing Sysco invoices/orders
- 🔒 **Configuration** - System settings and preferences

## Methods

### Method 1: CLI Script (Recommended)

```bash
cd /Users/davidmikulis/neuro-inventory-enterprise/inventory-enterprise/backend
node scripts/remove-gfs-data.js
```

**Features:**
- Pre-removal analytics report
- Optional backup export
- Interactive confirmation
- Detailed removal statistics

**Process:**
1. Script generates analytics report showing what will be removed
2. Optionally creates backup export (JSON format)
3. Prompts for confirmation: Type `REMOVE_GFS`
4. Removes operational data in transaction
5. Shows detailed removal statistics

### Method 2: API Endpoint

**Get Analytics (Before Removal):**
```bash
curl https://your-railway-url/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

**Remove GFS Data:**
```bash
curl -X POST https://your-railway-url/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation": "REMOVE_GFS",
    "createBackup": true
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "GFS operational data removed successfully...",
  "analytics": {
    "operational": {
      "vendorOrders": 150,
      "invoices": 200,
      "vendorOrderLines": 5000,
      "invoiceLines": 6000
    },
    "learning": {
      "parseJobs": 50,
      "lineMatches": 5000
    },
    "summary": {
      "totalOperationalRecords": 11350,
      "totalLearningRecords": 5050
    }
  },
  "stats": {
    "orders": 150,
    "orderLines": 5000,
    "invoices": 200,
    "invoiceLines": 6000
  },
  "backupPath": "gfs-backup-2025-01-18T10-30-00-000Z.json"
}
```

## Pre-Removal Checklist

- [ ] Review analytics report
- [ ] Create backup export (recommended)
- [ ] Verify Sysco import system is ready
- [ ] Ensure learning data is preserved
- [ ] Confirm no critical GFS data needed

## Post-Removal Verification

### 1. Check Database

```sql
-- Should return 0
SELECT COUNT(*) FROM vendor_orders 
WHERE vendor_name ILIKE '%GFS%' OR vendor_name ILIKE '%gordon%';

-- Should return 0
SELECT COUNT(*) FROM invoices 
WHERE vendor_name ILIKE '%GFS%' OR vendor_name ILIKE '%gordon%';

-- Should return > 0 (learning data preserved)
SELECT COUNT(*) FROM vendor_invoice_parse_jobs 
WHERE detected_vendor_name ILIKE '%GFS%';
```

### 2. Verify Learning Data

```sql
-- Parse jobs should still exist
SELECT COUNT(*) as parse_jobs,
       COUNT(*) FILTER (WHERE status = 'completed') as completed
FROM vendor_invoice_parse_jobs
WHERE detected_vendor_name ILIKE '%GFS%';

-- Line matches should still exist
SELECT COUNT(*) as line_matches
FROM vendor_invoice_line_matches vilm
JOIN vendor_invoice_parse_jobs vpj ON vilm.parse_job_id = vpj.id
WHERE vpj.detected_vendor_name ILIKE '%GFS%';
```

### 3. Test Sysco Import

```bash
# Test import endpoint
curl -X POST https://your-railway-url/api/admin/sysco/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"dryRun": true}'
```

## Backup Export

Backup files are saved to `backups/gfs-backup-{timestamp}.json` and include:

- Sample vendor orders (first 1000)
- Sample invoices (first 1000)
- Summary statistics
- Export timestamp

**Note:** Backup is a sample export. Full data removal will delete all records, not just samples.

## Safety Features

✅ **Transaction-based** - All removals in single transaction (rollback on error)
✅ **Explicit confirmation** - Requires `REMOVE_GFS` confirmation
✅ **Analytics first** - See what will be removed before removal
✅ **Learning preserved** - Parse jobs and matches kept for training
✅ **Detailed logging** - All actions logged to `sysco_import_jobs`
✅ **Backup option** - Optional JSON export before removal

## Troubleshooting

### Error: "Table does not exist"
- Some tables may not exist in your database
- Script handles missing tables gracefully (catches errors)
- This is normal if you haven't used certain features

### Error: "Foreign key constraint"
- All removals happen in correct order (children before parents)
- Transaction ensures consistency
- If error occurs, transaction rolls back automatically

### Learning Data Missing
- Check `vendor_invoice_parse_jobs` table exists
- Verify parse jobs weren't manually deleted
- Learning data is preserved by design

## Next Steps After Cleanup

1. ✅ Verify GFS data removed
2. ✅ Confirm learning data preserved
3. ✅ Test Sysco import system
4. ✅ Start importing Sysco invoices
5. ✅ System will learn from new Sysco invoices
6. ✅ Apply learning from preserved parse jobs

## Support

- **Script:** `scripts/remove-gfs-data.js`
- **API:** `/api/admin/sysco/remove-gfs-data`
- **Analytics:** `/api/admin/sysco/gfs-analytics`
- **Logs:** Check `sysco_import_jobs` table for cleanup history

---

**Ready for fresh start!** 🚀

