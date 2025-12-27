# PDF Splitter Enhancements

## Overview
Added database schema support, manual split endpoint, and improved splitter integration.

## Changes Made

### 1. Database Migration ✅
**File:** `migrations/postgres/028_add_pdf_splitter_columns.sql`

Added columns to `documents` table:
- `parent_document_id` - Links child documents to parent
- `page_range_start` - Starting page number for split documents
- `page_range_end` - Ending page number for split documents
- `parse_confidence` - Confidence score (0.0-1.0) for parsing
- `raw_text` - Extracted text from PDF (limited to 10KB)

**Indexes added:**
- `idx_documents_parent_id` - Fast child lookups
- `idx_documents_parse_confidence` - Filter low-confidence documents
- `idx_documents_parent_page_range` - Composite index for parent + page range queries

**To apply migration:**
```bash
# In Railway or local PostgreSQL
psql $DATABASE_URL -f migrations/postgres/028_add_pdf_splitter_columns.sql

# Or via init-postgres.js (will auto-apply)
node scripts/init-postgres.js
```

### 2. Manual Split Endpoint ✅
**File:** `routes/owner-pdfs.js` (Lines ~1573-1650)

**Endpoint:** `POST /api/owner/pdfs/:documentId/split`

**Features:**
- Manually trigger splitting on existing documents
- Re-process documents that weren't auto-split on upload
- Force re-split (deletes existing children first)
- Validates document exists and isn't already a child

**Usage:**
```bash
# Split an existing document
curl -X POST https://api.neuropilot.dev/api/owner/pdfs/{documentId}/split \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json"

# Force re-split (deletes existing children)
curl -X POST https://api.neuropilot.dev/api/owner/pdfs/{documentId}/split \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"force": true}'
```

**Response:**
```json
{
  "success": true,
  "message": "PDF split into 3 document(s)",
  "data": {
    "parentDocumentId": "parent-uuid",
    "childDocuments": 3,
    "children": [
      {
        "id": "child-1-uuid",
        "invoiceNumber": "9027091040",
        "vendor": "SYSCO",
        "documentType": "INVOICE",
        "pageRange": { "start": 1, "end": 2 }
      }
    ]
  }
}
```

### 3. Improved Splitter Service ✅
**File:** `services/PdfSplitterService.js`

**Enhancements:**
- Uses new schema columns when available (migration applied)
- Graceful fallback to `notes` field if migration hasn't run
- Stores `raw_text` directly in database (up to 10KB)
- Better error handling for schema mismatches

**Schema Detection:**
- Tries to insert with new columns first
- Falls back to `notes` JSON if columns don't exist
- No breaking changes - works with or without migration

### 4. Vendor Parser Integration ✅
**File:** `services/PdfSplitterService.js` (Lines ~380-450)

**Features:**
- Automatically runs Sysco parser on split child invoices
- Updates child documents with parsed data:
  - Invoice number
  - Invoice date
  - Invoice amount
  - Line items count
- Marks documents needing OCR if parsing fails
- Extensible for other vendors (GFS, US Foods, etc.)

## Complete Workflow

### Automatic Splitting (on Upload)
1. User uploads PDF → `/api/owner/pdfs/upload`
2. System extracts text and detects multiple invoice numbers
3. If 2+ invoices detected → automatically splits
4. Creates child documents with proper schema columns
5. Runs vendor parser on each child invoice
6. Returns response with parent + children info

### Manual Splitting (existing documents)
1. User calls → `POST /api/owner/pdfs/:documentId/split`
2. System reads PDF from disk
3. Splits into child documents
4. Runs vendor parser on each child
5. Returns split results

## Database Queries

### Find all children of a parent document
```sql
SELECT id, filename, invoice_number, vendor, page_range_start, page_range_end, parse_confidence
FROM documents
WHERE parent_document_id = 'parent-uuid'
ORDER BY page_range_start;
```

### Find low-confidence documents needing review
```sql
SELECT id, filename, parse_confidence, document_type
FROM documents
WHERE parse_confidence < 0.5
  AND parse_confidence IS NOT NULL
ORDER BY parse_confidence ASC;
```

### Find all split documents (parents with children)
```sql
SELECT d.id, d.filename, COUNT(c.id) as child_count
FROM documents d
LEFT JOIN documents c ON c.parent_document_id = d.id
WHERE d.parent_document_id IS NULL
GROUP BY d.id, d.filename
HAVING COUNT(c.id) > 0;
```

## Testing

### Test Manual Split Endpoint
```bash
# 1. Get a document ID
TOKEN="<JWT>"
curl -H "Authorization: Bearer $TOKEN" \
  https://api.neuropilot.dev/api/owner/pdfs | jq '.data[0].id'

# 2. Split it
DOC_ID="<document-id>"
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  https://api.neuropilot.dev/api/owner/pdfs/$DOC_ID/split

# 3. Verify children
psql $DATABASE_URL -c "
  SELECT id, filename, invoice_number, vendor, page_range_start, page_range_end
  FROM documents
  WHERE parent_document_id = '$DOC_ID';
"
```

### Test Auto-Split on Upload
```bash
# Upload a multi-invoice PDF
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@multi-invoice.pdf" \
  https://api.neuropilot.dev/api/owner/pdfs/upload

# Response will include split.children array if split occurred
```

## Next Steps

1. **Apply Migration:**
   ```bash
   psql $DATABASE_URL -f migrations/postgres/028_add_pdf_splitter_columns.sql
   ```

2. **Test Manual Split:**
   - Use endpoint on existing multi-invoice PDFs
   - Verify children are created correctly

3. **Monitor Auto-Split:**
   - Upload test PDFs with multiple invoices
   - Verify automatic detection and splitting works

4. **Future Enhancements:**
   - Add pdf-lib for actual PDF file splitting (currently creates records only)
   - Add OCR queue integration for `OCR_REQUIRED` pages
   - Add GFS/US Foods parser integration
   - Add batch split endpoint for multiple documents

## Files Modified

1. `migrations/postgres/028_add_pdf_splitter_columns.sql` - **NEW** - Schema migration
2. `routes/owner-pdfs.js` - Added manual split endpoint
3. `services/PdfSplitterService.js` - Improved schema support, vendor parser integration

