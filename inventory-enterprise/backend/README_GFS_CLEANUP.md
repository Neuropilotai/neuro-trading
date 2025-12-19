# 🧹 GFS Cleanup - Quick Start

## What This Does

Removes GFS operational data (orders, invoices) while **preserving learning data** (parse jobs, matches) so the system can learn from new Sysco invoices.

## Quick Commands

### Get Analytics (See What Will Be Removed)
```bash
curl https://your-url/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Remove GFS Data (With Backup)
```bash
curl -X POST https://your-url/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "REMOVE_GFS", "createBackup": true}'
```

### Or Use CLI Script
```bash
node scripts/remove-gfs-data.js
```

## What Happens

1. **Analytics Report** - Shows what will be removed
2. **Optional Backup** - Exports sample data to JSON
3. **Removal** - Deletes GFS operational data
4. **Preservation** - Keeps learning data intact
5. **Statistics** - Shows what was removed

## Files

- `scripts/remove-gfs-data.js` - Main cleanup script
- `routes/sysco-import.js` - API endpoints (updated)
- `GFS_CLEANUP_GUIDE.md` - Detailed guide
- `FRESH_START_CHECKLIST.md` - Step-by-step checklist

## Safety

✅ Transaction-based (rollback on error)
✅ Requires explicit confirmation
✅ Preserves learning data
✅ Optional backup export
✅ Detailed logging

---

**Ready to clean up!** 🚀

