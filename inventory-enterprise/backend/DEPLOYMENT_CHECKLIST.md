# PDF Pipeline Deployment Checklist

## Pre-Deployment

### 1. Code Review ✅
- [x] All files pass syntax check (`node --check`)
- [x] No linter errors
- [x] All tests pass (if applicable)

### 2. Database Migration
- [ ] Backup production database
- [ ] Review migration: `migrations/postgres/043_add_pdf_splitter_columns.sql`
- [ ] Test migration on staging/dev database first
- [ ] Apply migration to production:
  ```bash
  psql $DATABASE_URL -f migrations/postgres/043_add_pdf_splitter_columns.sql
  ```
- [ ] Verify columns exist:
  ```sql
  SELECT column_name FROM information_schema.columns 
  WHERE table_name = 'documents' 
  AND column_name IN ('parent_document_id', 'page_range_start', 'page_range_end', 'parse_confidence', 'raw_text');
  ```

### 3. Environment Variables
- [ ] Verify `DATABASE_URL` is set correctly
- [ ] Optional: Set debug flags for initial testing:
  ```bash
  PDF_UPLOAD_DEBUG=true
  PDF_SPLITTER_DEBUG=true
  SYSCO_IMPORT_DEBUG=true
  ```

## Deployment Steps

### 1. Deploy Code
```bash
# Commit changes
git add .
git commit -m "feat: Complete PDF pipeline with auto-split and vendor parsing"

# Push to production
git push origin main

# Or if using Railway/other platform, trigger deployment
```

### 2. Verify Deployment
```bash
# Check server is running
curl https://api.neuropilot.dev/health

# Check endpoints are accessible
curl -I https://api.neuropilot.dev/api/owner/pdfs/upload
```

### 3. Test Upload Endpoint
```bash
# Generate token
TOKEN="$(node ./generate_owner_token.js | grep -oE '([A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+' | head -n 1)"

# Test single invoice upload
curl -X POST https://api.neuropilot.dev/api/owner/pdfs/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@single-invoice.pdf"

# Expected: HTTP 201 with documentId, no split info

# Test multi-invoice upload
curl -X POST https://api.neuropilot.dev/api/owner/pdfs/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@multi-invoice.pdf"

# Expected: HTTP 201 with documentId AND split.children array
```

### 4. Test Manual Split
```bash
# Get a document ID
DOC_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.neuropilot.dev/api/owner/pdfs | \
  jq -r '.data[0].id')

# Test split endpoint
curl -X POST https://api.neuropilot.dev/api/owner/pdfs/$DOC_ID/split \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"

# Expected: HTTP 200 with split results
```

### 5. Test Sysco Import
```bash
# Enable debug
export SYSCO_IMPORT_DEBUG=true

# Run import
curl -i -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST https://api.neuropilot.dev/api/admin/sysco/import \
  -d '{"dryRun":false}'

# Expected: HTTP 200, filesProcessed > 0, sysco_invoices created
```

### 6. Verify Database
```sql
-- Check migration applied
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'documents' 
AND column_name IN ('parent_document_id', 'page_range_start', 'page_range_end');

-- Check for split documents
SELECT COUNT(*) FROM documents WHERE parent_document_id IS NOT NULL;

-- Check parse confidence
SELECT COUNT(*) FROM documents WHERE parse_confidence IS NOT NULL;
```

## Post-Deployment Monitoring

### 1. Monitor Logs
```bash
# Watch for errors
tail -f /var/log/app.log | grep -i "pdf\|split\|error"

# Or in Railway
railway logs --follow
```

### 2. Check Metrics
- Upload success rate
- Split detection rate
- Parse confidence scores
- Error rates

### 3. Test Edge Cases
- [ ] Single page PDF
- [ ] Very large PDF (>50MB)
- [ ] Scanned PDF (OCR_REQUIRED)
- [ ] PDF with no invoices
- [ ] PDF with mixed content (invoices + reports)

## Rollback Plan

If issues occur:

1. **Code Rollback:**
   ```bash
   git revert <commit-hash>
   git push origin main
   ```

2. **Database Rollback (if needed):**
   ```sql
   -- Remove new columns (only if absolutely necessary)
   ALTER TABLE documents DROP COLUMN IF EXISTS parent_document_id;
   ALTER TABLE documents DROP COLUMN IF EXISTS page_range_start;
   ALTER TABLE documents DROP COLUMN IF EXISTS page_range_end;
   ALTER TABLE documents DROP COLUMN IF EXISTS parse_confidence;
   ALTER TABLE documents DROP COLUMN IF EXISTS raw_text;
   ```

## Success Criteria

- [ ] Upload endpoint returns 200/201 for valid PDFs
- [ ] Multi-invoice PDFs are automatically split
- [ ] Child documents are created with proper parent linking
- [ ] Vendor parsers run on split invoices
- [ ] Manual split endpoint works for existing documents
- [ ] No increase in error rates
- [ ] Database queries perform well (check indexes)

## Support

If issues arise:
1. Check logs with debug flags enabled
2. Verify database migration applied correctly
3. Test with CLI script: `node scripts/test-pdf-pipeline.js <pdf-path>`
4. Review documentation: `PDF_PIPELINE_COMPLETE.md`
