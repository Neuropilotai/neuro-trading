# Targeted Reset Guide

**NeuroPilot Inventory System v23.6.13**

## Overview

The Targeted Reset tool allows you to safely remove PDFs and inventory products to start fresh, while preserving:
- User accounts and authentication
- Storage locations
- Vendors/suppliers
- Item bank (master_items, supplier_items)
- System configuration

## What Gets Deleted

### PDFs (if `deleteOrderPdfs: true`)
- All records from `documents` table
- All local PDF files referenced in `documents.file_path`
- All records from `vendor_orders` table with PDFs (`pdf_file_id IS NOT NULL`)
- All Google Drive PDF files (if API configured)
- All `vendor_order_lines` (CASCADE deleted with vendor_orders)

### Products (if `clearInventoryProducts: true`)
- All active inventory items (`inventory_items` where `is_active = 1`)
- All `inventory_balances` for those items
- All `inventory_ledger` entries for those items
- All `fifo_cost_layers` for those items
- All `item_location_assignments` for those items
- `vendor_order_lines.item_code` set to NULL (preserves order history)

## What Gets Preserved

- User accounts and authentication
- Storage locations (`item_locations`)
- Vendors/suppliers (`vendors`)
- Item bank (`master_items`, `supplier_items`)
- System configuration
- Audit logs

## Safety Features

1. **Environment Gate**: In production, requires `RESET_ENABLED=true`
2. **Confirmation Required**: Must provide `confirm: "RESET"` to proceed
3. **Transaction Safety**: All deletions wrapped in database transaction (rollback on error)
4. **Dry Run Mode**: Test what would be deleted without making changes
5. **Verification**: Automatic verification after reset
6. **Idempotent**: Can be run multiple times safely

## API Endpoint

### POST /api/admin/reset/target

**Authentication**: Requires OWNER role (JWT token with `role: "owner"`)

**Request Body**:
```json
{
  "confirm": "RESET",
  "deleteOrderPdfs": true,
  "clearInventoryProducts": true,
  "dryRun": false
}
```

**Response**:
```json
{
  "dryRun": false,
  "deleted": {
    "orderPdfRecords": 3,
    "pdfFiles": 3,
    "googleDriveFiles": 2,
    "vendorOrders": 2,
    "vendorOrderLines": "CASCADE deleted with vendor_orders",
    "products": 65,
    "inventoryBalances": 65,
    "inventoryLedger": 120,
    "fifoCostLayers": 45,
    "itemLocationAssignments": 30,
    "vendorOrderLinesUpdated": 15
  },
  "errors": [],
  "warnings": [],
  "verification": {
    "passed": true,
    "checks": [
      {
        "check": "documents table",
        "expected": 0,
        "actual": 0,
        "passed": true
      },
      {
        "check": "vendor_orders with PDFs",
        "expected": 0,
        "actual": 0,
        "passed": true
      },
      {
        "check": "active inventory_items",
        "expected": 0,
        "actual": 0,
        "passed": true
      }
    ]
  },
  "duration": "234ms",
  "message": "Reset completed successfully. This operation cannot be undone."
}
```

**Example (Dry Run)**:
```bash
curl -X POST https://your-url/api/admin/reset/target \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": true
  }'
```

**Example (Actual Reset)**:
```bash
curl -X POST https://your-url/api/admin/reset/target \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": "RESET",
    "deleteOrderPdfs": true,
    "clearInventoryProducts": true,
    "dryRun": false
  }'
```

## CLI Script

### Usage

```bash
# Dry run (recommended first)
node scripts/reset-target.js --confirm=RESET --dry-run

# Actual reset
node scripts/reset-target.js --confirm=RESET

# Reset only PDFs
node scripts/reset-target.js --confirm=RESET --pdfs=true --products=false

# Reset only products
node scripts/reset-target.js --confirm=RESET --pdfs=false --products=true
```

### Options

- `--confirm=RESET` - Required confirmation string
- `--dry-run` - Show what would be deleted without executing
- `--pdfs=true|false` - Delete PDFs (default: true)
- `--products=true|false` - Delete products (default: true)

### Exit Codes

- `0` - Success
- `1` - Error
- `2` - Dry run (no changes)

### Example Output

```json
{
  "dryRun": false,
  "deleted": {
    "orderPdfRecords": 3,
    "pdfFiles": 3,
    "vendorOrders": 2,
    "products": 65,
    "inventoryBalances": 65,
    "inventoryLedger": 120,
    "fifoCostLayers": 45,
    "itemLocationAssignments": 30
  },
  "errors": [],
  "warnings": [],
  "verification": {
    "passed": true,
    "checks": [...]
  }
}
```

## Verification

After running the reset, verify the results:

### 1. Check PDFs

```bash
# API check
curl https://your-url/api/owner/pdfs \
  -H "Authorization: Bearer YOUR_TOKEN"

# Should return empty array or 0 count
```

```sql
-- Database check
SELECT COUNT(*) FROM documents; -- Should be 0
SELECT COUNT(*) FROM vendor_orders WHERE pdf_file_id IS NOT NULL AND deleted_at IS NULL; -- Should be 0
```

### 2. Check Products

```bash
# API check
curl https://your-url/api/inventory/items \
  -H "Authorization: Bearer YOUR_TOKEN"

# Should return empty array or 0 count
```

```sql
-- Database check
SELECT COUNT(*) FROM inventory_items WHERE is_active = 1; -- Should be 0
```

### 3. Check Filesystem

```bash
# Check upload directories (adjust path as needed)
ls -la uploads/invoices/  # Should be empty or contain no PDFs
```

## Environment Variables

### Required for Production

```bash
RESET_ENABLED=true  # Must be set to enable reset in production
```

### Optional for Google Drive

```bash
GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'  # For Google Drive file deletion
```

## Error Handling

### Common Errors

1. **"Invalid confirmation"**
   - Solution: Provide `confirm: "RESET"` in request body

2. **"Reset disabled in production"**
   - Solution: Set `RESET_ENABLED=true` environment variable

3. **"Nothing to delete"**
   - Solution: Set at least one of `deleteOrderPdfs` or `clearInventoryProducts` to `true`

4. **Database errors**
   - Solution: Check database connection and permissions
   - All changes are rolled back automatically

5. **File deletion errors**
   - Non-fatal: Logged as warnings, operation continues
   - Check file permissions and paths

## Rollback Strategy

**No automatic rollback** - This is a destructive operation.

### Before Running Reset

1. **Create database backup**:
   ```bash
   pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
   ```

2. **Test with dry run**:
   ```bash
   node scripts/reset-target.js --confirm=RESET --dry-run
   ```

3. **Review the counts** to ensure they match expectations

### If You Need to Rollback

1. Restore from database backup:
   ```bash
   psql $DATABASE_URL < backup-YYYYMMDD-HHMMSS.sql
   ```

2. Note: Google Drive files cannot be automatically restored (must be re-uploaded)

## Best Practices

1. **Always run dry-run first** to verify what will be deleted
2. **Create database backup** before actual reset
3. **Verify results** after reset using the verification checks
4. **Use in staging first** to test the process
5. **Document any warnings** that appear during reset

## Troubleshooting

### PDFs Not Deleted from Google Drive

- Check if `GOOGLE_SERVICE_ACCOUNT_KEY` is set correctly
- Verify service account has Drive API access
- Check warnings in response for specific errors

### Files Not Deleted from Filesystem

- Check file paths in `documents.file_path` column
- Verify file permissions
- Check warnings in response for specific errors

### Products Still Visible

- Verify `is_active = 1` filter is correct
- Check if products were soft-deleted (`is_active = 0`) instead of hard-deleted
- Run verification queries to confirm deletion

## Support

For issues or questions:
- Check server logs for detailed error messages
- Review warnings in API response
- Verify database state with SQL queries
- Ensure all environment variables are set correctly

---

**Last Updated**: 2025-01-20  
**Version**: 1.0.0

