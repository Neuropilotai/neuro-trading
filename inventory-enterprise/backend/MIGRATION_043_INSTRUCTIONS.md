# Migration 043 - Application Instructions

## Quick Apply (Railway)

Since your database is on Railway, run the migration there:

```bash
# From the backend directory
railway run node scripts/apply-migration-043.js
```

This will:
- ✅ Connect to Railway's DATABASE_URL automatically
- ✅ Apply the migration
- ✅ Verify columns were created
- ✅ Show success/failure

## Alternative: Via init-postgres.js

The migration is already included in `init-postgres.js`, so you can also run:

```bash
railway run node scripts/init-postgres.js
```

This will apply ALL migrations including 043.

## Verify Migration Applied

After running, verify with:

```bash
railway run node scripts/verify-pdf-pipeline.js
```

Or check directly in Railway:

```bash
railway run psql -c "
  SELECT column_name 
  FROM information_schema.columns 
  WHERE table_name = 'documents' 
  AND column_name IN ('parent_document_id', 'page_range_start', 'page_range_end', 'parse_confidence', 'raw_text');
"
```

## If Railway CLI Not Available

If you don't have Railway CLI, you can:

1. **SSH into Railway container:**
   - Go to Railway dashboard
   - Open your service
   - Click "Connect" or "Shell"
   - Run: `node scripts/apply-migration-043.js`

2. **Or get DATABASE_URL from Railway:**
   - Railway dashboard → Your service → Variables
   - Copy DATABASE_URL
   - Set locally: `export DATABASE_URL="postgresql://..."`
   - Run: `node scripts/apply-migration-043.js`

## Troubleshooting

**Error: "DATABASE_URL not set"**
- Make sure you're running in Railway environment
- Or set DATABASE_URL manually before running

**Error: "Migration already applied"**
- This is safe to ignore
- Columns already exist, migration is idempotent

**Error: "Connection failed"**
- Check Railway service is running
- Verify DATABASE_URL is correct
- Check network connectivity

