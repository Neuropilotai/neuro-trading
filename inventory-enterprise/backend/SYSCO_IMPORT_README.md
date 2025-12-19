# Sysco Invoice Import System

Complete automated Sysco invoice ingestion pipeline with Google Drive integration.

## Overview

This system automatically:
1. Monitors Google Drive INBOX folder for new Sysco invoice PDFs
2. Downloads and parses each invoice
3. Extracts invoice data (header, line items, totals)
4. Stores data in PostgreSQL database
5. Updates inventory (optional)
6. Moves processed files to PROCESSED folder

## Architecture

### Components

1. **Database Schema** (`migrations/postgres/042_sysco_invoices.sql`)
   - `sysco_invoices` - Main invoice records
   - `sysco_invoice_lines` - Line item details
   - `sysco_parsing_corrections` - Learning/correction data
   - `sysco_import_jobs` - Import job tracking

2. **Parser** (`src/finance/SyscoInvoiceParser.js`)
   - PDF text extraction
   - Header parsing (invoice number, date, totals)
   - Line item extraction
   - Confidence scoring

3. **Import Service** (`services/SyscoImportService.js`)
   - Google Drive integration
   - File processing orchestration
   - Database storage
   - Inventory updates (optional)

4. **API Routes** (`routes/sysco-import.js`)
   - Manual import trigger
   - Status monitoring
   - Invoice listing/details
   - System reset

5. **Cron Job** (in `server-v21_1.js`)
   - Automated periodic imports
   - Configurable schedule

## Setup

### 1. Run Database Migration

```bash
psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql
```

### 2. Configure Environment Variables

See `SYSCO_IMPORT_ENV.md` for complete environment variable documentation.

Required variables:
- `GOOGLE_SERVICE_ACCOUNT_KEY` - Google service account JSON key
- `GDRIVE_INBOX_FOLDER_ID` - Google Drive INBOX folder ID
- `GDRIVE_PROCESSED_FOLDER_ID` - Google Drive PROCESSED folder ID
- `SYSCO_IMPORT_ENABLED=true` - Enable cron job
- `SYSCO_IMPORT_SCHEDULE=*/15 * * * *` - Cron schedule (optional)

### 3. Google Drive Setup

1. Create a Google Cloud service account
2. Download the JSON key file
3. Grant the service account "Editor" access to both folders:
   - INBOX: `12iUl5BJlraL6kufV6VxLE7wLS6XvVd8l`
   - PROCESSED: `1XSVCuEer4mJK4OEFGjOwQXJDGlGlBg7R`
4. Base64 encode the key or paste raw JSON into `GOOGLE_SERVICE_ACCOUNT_KEY`

## Usage

### Manual Import

```bash
curl -X POST http://localhost:8080/api/admin/sysco/import \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

### Check Status

```bash
curl http://localhost:8080/api/admin/sysco/status \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

### List Invoices

```bash
curl "http://localhost:8080/api/admin/sysco/invoices?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

### Get Invoice Details

```bash
curl http://localhost:8080/api/admin/sysco/invoices/INVOICE_ID \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN"
```

### System Reset

```bash
curl -X POST http://localhost:8080/api/admin/reset-system \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "RESET", "resetReferenceData": false}'
```

Or via CLI:
```bash
node scripts/reset-system-sysco.js
```

## Features

### Idempotency
- Files are checked before processing
- Duplicate imports are automatically skipped
- Uses `source_drive_file_id` for uniqueness

### Error Handling
- Failed imports are stored in database with error details
- Files are NOT moved to PROCESSED on failure
- Retry capability via manual import

### Learning/Corrections
- Parsing corrections can be stored in `sysco_parsing_corrections`
- Corrections are automatically applied to future imports
- Supports item code mappings, description normalizations

### Inventory Integration
- Optional automatic inventory updates
- Creates `inventory_transactions` for each line item
- Uses default receiving location (or mapped location)

## Database Schema

### sysco_invoices
- Invoice header data
- Financial totals (stored as cents)
- Parsing metadata (confidence, version)
- Raw extracted text and parsed JSON
- Error tracking

### sysco_invoice_lines
- Line item details
- Quantities and pricing (cents)
- Inventory mapping (linked_item_id, mapped_location_id)
- Confidence scores per field

### sysco_parsing_corrections
- Learning corrections
- Applied count tracking
- Supports multiple correction types

### sysco_import_jobs
- Job tracking
- Statistics (files found, processed, skipped, failed)
- Error summaries

## API Endpoints

### POST /api/admin/sysco/import
Manually trigger import.

**Body:**
```json
{
  "dryRun": false
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "uuid",
  "filesFound": 5,
  "filesProcessed": 4,
  "filesSkipped": 1,
  "filesFailed": 0,
  "errors": []
}
```

### GET /api/admin/sysco/status
Get import status and statistics.

**Response:**
```json
{
  "success": true,
  "latestJob": { ... },
  "invoiceStats": {
    "total_invoices": 100,
    "completed": 95,
    "failed": 5,
    "pending": 0
  },
  "recentInvoices": [ ... ]
}
```

### GET /api/admin/sysco/invoices
List invoices with pagination.

**Query Params:**
- `page` (default: 1)
- `limit` (default: 20, max: 100)
- `status` (optional filter)

### GET /api/admin/sysco/invoices/:id
Get invoice details with line items.

### POST /api/admin/reset-system
Reset system (requires owner role + confirmation).

**Body:**
```json
{
  "confirmation": "RESET",
  "resetReferenceData": false
}
```

## Troubleshooting

### Import Not Running
1. Check `SYSCO_IMPORT_ENABLED=true` in environment
2. Verify Google Drive service account is configured
3. Check server logs for errors
4. Verify cron schedule is correct

### Files Not Moving to PROCESSED
- Files are only moved after successful database commit
- Check database connection
- Verify Google Drive permissions
- Check error logs for specific failures

### Parsing Errors
- Check `raw_extracted_text` in database for PDF content
- Review `error_message` and `error_details` fields
- PDFs may be scanned images (OCR not yet implemented)
- Adjust parser patterns in `SyscoInvoiceParser.js`

### Google Drive Access Issues
- Verify service account has "Editor" access to folders
- Check service account key is valid
- Ensure folders are shared with service account email

## Future Enhancements

- [ ] OCR support for scanned PDFs
- [ ] Multi-vendor support (beyond Sysco)
- [ ] Advanced learning/correction UI
- [ ] Real-time webhook notifications
- [ ] Batch processing optimization
- [ ] Invoice validation rules
- [ ] Automatic item code mapping

## Support

For issues or questions, check:
- Server logs: `[SyscoImport]` prefix
- Database: `sysco_import_jobs` table for job history
- API: `/api/admin/sysco/status` for current status

