# Targeted Reset Tool - Documentation Index

**Quick navigation to all Targeted Reset Tool documentation and resources**

---

## 📚 Documentation Files

### Getting Started
1. **[Quick Start Guide](TARGETED_RESET_QUICK_START.md)** ⭐ **START HERE**
   - Fast reference for common use cases
   - Copy-paste ready commands
   - Browser console examples
   - **Best for:** First-time users

2. **[Complete Guide](TARGETED_RESET_GUIDE.md)**
   - Comprehensive documentation
   - Full API reference
   - CLI usage details
   - Error handling guide
   - **Best for:** Detailed reference

### Implementation Details
3. **[Implementation Status](TARGETED_RESET_IMPLEMENTATION_STATUS.md)**
   - Component status
   - Known issues
   - Testing checklist
   - **Best for:** Understanding current state

4. **[Final Summary](TARGETED_RESET_FINAL_SUMMARY.md)**
   - Complete implementation overview
   - Plan compliance
   - Metrics and deliverables
   - **Best for:** High-level overview

### Deployment
5. **[Deployment Checklist](TARGETED_RESET_DEPLOYMENT_CHECKLIST.md)**
   - Pre-deployment steps
   - Deployment process
   - Post-deployment verification
   - Rollback plan
   - **Best for:** Production deployment

---

## 🛠️ Implementation Files

### Core Code
- **API Endpoint:** `routes/admin-reset.js`
  - Endpoint: `POST /api/admin/reset/target`
  - Status: ✅ Production ready

- **CLI Script:** `scripts/reset-target.js`
  - Status: ⚠️ Has known bug (function name conflict)
  - Workaround: Use API for product deletion

### Testing
- **Test Script:** `scripts/test-reset-target.sh`
  - Automated testing suite
  - API and CLI verification
  - Usage: `./scripts/test-reset-target.sh`

### Route Registration
- **Server Config:** `server-v21_1.js` (line 1715)
  - Route: `/api/admin/reset`
  - Middleware: `authenticateToken`, `requireOwner`, `rateLimitMiddleware`, `auditLog`

---

## 🚀 Quick Links

### Common Tasks

**1. Run a Dry Run (Safe)**
```bash
# See TARGETED_RESET_QUICK_START.md for full command
curl -X POST "$BASE_URL/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET","deleteOrderPdfs":true,"clearInventoryProducts":true,"dryRun":true}'
```

**2. Run Tests**
```bash
cd inventory-enterprise/backend
./scripts/test-reset-target.sh
```

**3. Set Environment Variable**
- Railway Dashboard → Variables → Add `RESET_ENABLED=true`

**4. Get Help**
- Check `TARGETED_RESET_GUIDE.md` for detailed documentation
- Check `TARGETED_RESET_QUICK_START.md` for quick reference

---

## ⚠️ Important Notes

### Known Issues
1. **CLI Script Bug:** Function name conflict prevents product deletion via CLI
   - **Workaround:** Use API endpoint for product deletion
   - **Status:** Fix pending

2. **Debug Logs:** Debug instrumentation present in code
   - **Impact:** Minor - code clutter
   - **Action:** Remove after verification

3. **Owner Bypass:** Temporary feature allows reset without RESET_ENABLED
   - **Impact:** Allows reset for owners in production
   - **Action:** Remove after initial reset complete

### Safety Reminders
- ⚠️ **Destructive Operation:** Cannot be undone
- ✅ **Always Dry Run First:** Review counts before actual reset
- 💾 **Backup Required:** Create database backup before running
- 🔒 **Production Gate:** Requires `RESET_ENABLED=true` (or owner bypass)

---

## 📋 Implementation Checklist

- [x] API endpoint implemented
- [x] CLI script implemented (has bug)
- [x] Route registered
- [x] Documentation complete
- [x] Test script created
- [ ] Environment variable set (`RESET_ENABLED`)
- [ ] Initial dry-run tested
- [ ] CLI bug fixed (optional)
- [ ] Debug logs removed (optional)

---

## 🎯 Use Cases

### Use Case 1: Remove All PDFs
```bash
curl -X POST "$BASE_URL/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET","deleteOrderPdfs":true,"clearInventoryProducts":false,"dryRun":false}'
```

### Use Case 2: Remove All Products
```bash
curl -X POST "$BASE_URL/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET","deleteOrderPdfs":false,"clearInventoryProducts":true,"dryRun":false}'
```

### Use Case 3: Fresh Start (PDFs + Products)
```bash
curl -X POST "$BASE_URL/api/admin/reset/target" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET","deleteOrderPdfs":true,"clearInventoryProducts":true,"dryRun":false}'
```

---

## 📞 Support

### Documentation
- **Quick Reference:** `TARGETED_RESET_QUICK_START.md`
- **Full Guide:** `TARGETED_RESET_GUIDE.md`
- **Status:** `TARGETED_RESET_IMPLEMENTATION_STATUS.md`

### Troubleshooting
1. Check server logs for detailed error messages
2. Review warnings in API response
3. Verify database state with SQL queries
4. Ensure environment variables are set correctly
5. Run test script: `./scripts/test-reset-target.sh`

---

## 📊 File Structure

```
inventory-enterprise/backend/
├── routes/
│   └── admin-reset.js              # API endpoint
├── scripts/
│   ├── reset-target.js              # CLI script
│   └── test-reset-target.sh         # Test script
├── TARGETED_RESET_README.md          # This file (index)
├── TARGETED_RESET_QUICK_START.md    # Quick start guide
├── TARGETED_RESET_GUIDE.md          # Complete guide
├── TARGETED_RESET_IMPLEMENTATION_STATUS.md  # Status
├── TARGETED_RESET_FINAL_SUMMARY.md  # Summary
└── TARGETED_RESET_DEPLOYMENT_CHECKLIST.md   # Deployment
```

---

## 🏁 Getting Started

**New to the Targeted Reset Tool?**

1. Read **[Quick Start Guide](TARGETED_RESET_QUICK_START.md)** (5 minutes)
2. Review **[Deployment Checklist](TARGETED_RESET_DEPLOYMENT_CHECKLIST.md)** (10 minutes)
3. Set `RESET_ENABLED=true` in Railway
4. Run a dry-run test
5. Proceed with actual reset if needed

**Need Detailed Information?**

- See **[Complete Guide](TARGETED_RESET_GUIDE.md)** for full documentation
- See **[Implementation Status](TARGETED_RESET_IMPLEMENTATION_STATUS.md)** for current state
- See **[Final Summary](TARGETED_RESET_FINAL_SUMMARY.md)** for overview

---

**Last Updated:** 2025-01-20  
**Version:** 1.0.0  
**Status:** ✅ Production Ready (API endpoint)

