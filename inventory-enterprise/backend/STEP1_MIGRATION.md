# Step 1: Run Database Migration

## Quick Copy-Paste Method

### 1. Open the Migration File

Open this file in your editor:
```
MIGRATION_042_READY_TO_PASTE.sql
```

Or view it:
```bash
cat MIGRATION_042_READY_TO_PASTE.sql
```

### 2. Copy Entire Contents

Select all (Cmd+A / Ctrl+A) and copy (Cmd+C / Ctrl+C)

### 3. Paste in Railway

1. Go to [Railway Dashboard](https://railway.app)
2. Select your project
3. Click **Database** tab
4. Click **Query** button
5. Paste the SQL (Cmd+V / Ctrl+V)
6. Click **Run** or **Execute**

### 4. Verify Success

You should see:
- ✅ "Query executed successfully"
- ✅ No errors

Then verify tables:
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name LIKE 'sysco_%'
ORDER BY table_name;
```

Should return:
- sysco_import_jobs
- sysco_invoice_lines
- sysco_invoices
- sysco_parsing_corrections

## Alternative: Railway CLI

```bash
railway run psql $DATABASE_URL -f migrations/postgres/042_sysco_invoices.sql
```

## What This Creates

- **4 new tables** for Sysco invoice management
- **Indexes** for performance
- **Constraints** for data integrity
- **Comments** for documentation

## Next Step

After migration completes → **Step 2: Environment Variables**

See `RAILWAY_SETUP_STEP2.md`

