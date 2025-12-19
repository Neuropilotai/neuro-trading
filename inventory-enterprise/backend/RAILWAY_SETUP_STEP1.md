# Railway Setup - Step 1: Database Migration

## Run the Sysco Invoice Migration

### Option A: Railway Dashboard (Recommended)

1. Go to Railway Dashboard
2. Select your project
3. Click on **Database** tab
4. Click **Query** button
5. Copy the entire contents of `migrations/postgres/042_sysco_invoices.sql`
6. Paste into the query editor
7. Click **Run** or **Execute**

### Option B: Railway CLI

```bash
railway run psql $DATABASE_URL -f migrations/postgres/042_sysco_import.sql
```

### Option C: Direct psql

```bash
psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql
```

## Verify Migration

After running, verify tables were created:

```sql
-- Check tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name LIKE 'sysco_%'
ORDER BY table_name;
```

Expected tables:
- `sysco_invoices`
- `sysco_invoice_lines`
- `sysco_parsing_corrections`
- `sysco_import_jobs`

## Migration File Location

`migrations/postgres/042_sysco_invoices.sql`

## Next Step

After migration completes, proceed to Step 2: Environment Variables

See `RAILWAY_SETUP_STEP2.md` for environment variable setup.

