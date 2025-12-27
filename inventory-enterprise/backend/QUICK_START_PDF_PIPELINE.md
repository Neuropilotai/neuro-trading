# PDF Pipeline - Quick Start Guide

## 🚀 Quick Deploy

### 1. Verify Setup
```bash
node scripts/verify-pdf-pipeline.js
```

### 2. Apply Migration
```bash
psql $DATABASE_URL -f migrations/postgres/043_add_pdf_splitter_columns.sql
```

### 3. Deploy Code
```bash
git add .
git commit -m "feat: PDF pipeline with auto-split"
git push origin main
```

## 📋 Key Endpoints

### Upload PDF (Auto-Split)
```bash
POST /api/owner/pdfs/upload
Content-Type: multipart/form-data
Authorization: Bearer <JWT>

# Response includes split.children if multiple invoices detected
```

### Manual Split
```bash
POST /api/owner/pdfs/:documentId/split
Authorization: Bearer <JWT>
Body: { "force": true }  # Optional: re-split existing children
```

### Sysco Import
```bash
POST /api/admin/sysco/import
Authorization: Bearer <JWT>
Body: { "dryRun": false }
```

## 🧪 Quick Tests

### Test Upload
```bash
TOKEN="<JWT>"
curl -X POST https://api.neuropilot.dev/api/owner/pdfs/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test.pdf"
```

### Test Split
```bash
DOC_ID="<document-id>"
curl -X POST https://api.neuropilot.dev/api/owner/pdfs/$DOC_ID/split \
  -H "Authorization: Bearer $TOKEN"
```

### Test Pipeline (CLI)
```bash
node scripts/test-pdf-pipeline.js /path/to/multi-invoice.pdf
```

## 🔍 Debug Mode

```bash
export PDF_UPLOAD_DEBUG=true
export PDF_SPLITTER_DEBUG=true
export SYSCO_IMPORT_DEBUG=true
```

## 📊 Database Queries

### Find Split Documents
```sql
SELECT d.id, d.filename, COUNT(c.id) as children
FROM documents d
LEFT JOIN documents c ON c.parent_document_id = d.id
WHERE d.parent_document_id IS NULL
GROUP BY d.id
HAVING COUNT(c.id) > 0;
```

### Get Children
```sql
SELECT * FROM documents 
WHERE parent_document_id = '<parent-id>'
ORDER BY page_range_start;
```

## 📚 Full Documentation

- **Complete Guide**: `PDF_PIPELINE_COMPLETE.md`
- **Deployment**: `DEPLOYMENT_CHECKLIST.md`
- **Enhancements**: `PDF_SPLITTER_ENHANCEMENTS.md`
- **Implementation**: `PDF_PIPELINE_IMPLEMENTATION.md`

## ⚡ Common Issues

### Migration Not Applied
```bash
# Check columns
psql $DATABASE_URL -c "
  SELECT column_name FROM information_schema.columns 
  WHERE table_name = 'documents' 
  AND column_name = 'parent_document_id';
"

# Apply if missing
psql $DATABASE_URL -f migrations/postgres/043_add_pdf_splitter_columns.sql
```

### Split Not Working
- Check logs: `PDF_SPLITTER_DEBUG=true`
- Verify PDF has multiple invoice numbers
- Check database for child documents

### Parser Errors
- Enable debug: `SYSCO_IMPORT_DEBUG=true`
- Check if PDF is scanned (needs OCR)
- Verify vendor is supported (Sysco currently)

## ✅ Success Indicators

- Upload returns 200/201
- Multi-invoice PDFs show `split.children` in response
- Child documents created with `parent_document_id`
- Vendor parsers extract invoice data
- No increase in error rates

