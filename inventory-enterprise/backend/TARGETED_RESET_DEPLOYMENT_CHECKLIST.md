# Targeted Reset Tool - Deployment Checklist

**Use this checklist before deploying the reset tool to production**

---

## Pre-Deployment

### 1. Code Review
- [x] API endpoint implemented (`routes/admin-reset.js`)
- [x] CLI script implemented (`scripts/reset-target.js`)
- [x] Route registered in `server-v21_1.js`
- [x] Documentation complete
- [ ] Code reviewed for security issues
- [ ] Test script created and reviewed

### 2. Environment Configuration
- [ ] Set `RESET_ENABLED=true` in Railway environment variables
- [ ] Verify `GOOGLE_SERVICE_ACCOUNT_KEY` is set (if using Google Drive)
- [ ] Verify `DATABASE_URL` is correct
- [ ] Verify `NODE_ENV=production` is set

### 3. Database Preparation
- [ ] Create database backup:
  ```bash
  pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
  ```
- [ ] Verify backup file size > 0
- [ ] Store backup in safe location
- [ ] Document backup location

### 4. Testing (Staging/Development)
- [ ] Run test script: `./scripts/test-reset-target.sh`
- [ ] Test dry-run mode via API
- [ ] Verify dry-run returns correct counts
- [ ] Test invalid confirmation (should fail)
- [ ] Test missing parameters (should fail)
- [ ] Verify authentication required (should fail without token)

---

## Deployment Steps

### Step 1: Deploy Code
- [ ] Code pushed to main branch
- [ ] Railway auto-deploys (or manual deploy triggered)
- [ ] Wait for deployment to complete (~2-5 minutes)
- [ ] Verify deployment logs show no errors

### Step 2: Verify Deployment
- [ ] Check endpoint is accessible:
  ```bash
  curl -X POST "$BASE_URL/api/admin/reset/target" \
    -H "Content-Type: application/json" \
    -d '{"confirm":"RESET"}'
  # Should return 401 (unauthorized) or 400 (bad request), not 404
  ```
- [ ] Verify route is registered (check server logs)
- [ ] Verify middleware is applied (check for requireOwner)

### Step 3: Initial Dry Run
- [ ] Get owner JWT token
- [ ] Run dry-run via API:
  ```bash
  curl -X POST "$BASE_URL/api/admin/reset/target" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "confirm": "RESET",
      "deleteOrderPdfs": true,
      "clearInventoryProducts": true,
      "dryRun": true
    }' | jq .
  ```
- [ ] Review dry-run results
- [ ] Verify counts match expectations
- [ ] Document counts for reference

---

## Post-Deployment Verification

### 1. After Dry Run
- [ ] Verify no data was deleted (check database)
- [ ] Verify response format is correct
- [ ] Verify verification checks are present in response

### 2. After Actual Reset (if performed)
- [ ] Verify PDFs deleted:
  ```bash
  curl "$BASE_URL/api/owner/pdfs" \
    -H "Authorization: Bearer $TOKEN" | jq 'length'
  # Should return 0
  ```
- [ ] Verify products deleted:
  ```bash
  curl "$BASE_URL/api/inventory/items" \
    -H "Authorization: Bearer $TOKEN" | jq 'length'
  # Should return 0
  ```
- [ ] Verify preserved data intact:
  ```sql
  SELECT COUNT(*) FROM users;  -- Should be unchanged
  SELECT COUNT(*) FROM item_locations;  -- Should be unchanged
  SELECT COUNT(*) FROM vendors;  -- Should be unchanged
  ```
- [ ] Verify no orphan files in filesystem
- [ ] Verify no orphan database rows

### 3. System Health
- [ ] Login/auth still works
- [ ] Owner console loads correctly
- [ ] Other endpoints function normally
- [ ] No errors in server logs

---

## Known Issues & Workarounds

### Issue 1: CLI Script Bug
**Status:** Known bug - function name conflict  
**Impact:** Product deletion fails via CLI  
**Workaround:** Use API endpoint for product deletion  
**Action:** Fix pending

### Issue 2: Debug Logs
**Status:** Debug instrumentation present  
**Impact:** Minor - code clutter  
**Action:** Remove after successful verification

### Issue 3: Owner Bypass
**Status:** Temporary feature  
**Impact:** Allows reset without RESET_ENABLED (for owners)  
**Action:** Remove after initial reset complete

---

## Rollback Plan

If something goes wrong:

### 1. Immediate Rollback
- [ ] Stop any in-progress reset (if possible)
- [ ] Check database transaction status
- [ ] Review server logs for errors

### 2. Data Recovery
- [ ] Restore from backup:
  ```bash
  psql $DATABASE_URL < backup-YYYYMMDD-HHMMSS.sql
  ```
- [ ] Verify data restored correctly
- [ ] Test system functionality

### 3. Code Rollback (if needed)
- [ ] Revert code changes in git
- [ ] Redeploy previous version
- [ ] Verify system stability

---

## Post-Deployment Tasks

### Immediate (Within 24 hours)
- [ ] Monitor server logs for errors
- [ ] Verify reset tool is accessible
- [ ] Document any issues encountered
- [ ] Update status in implementation docs

### Short Term (Within 1 week)
- [ ] Fix CLI script bug
- [ ] Remove debug logs
- [ ] Remove owner bypass (if initial reset complete)
- [ ] Run full test suite

### Long Term (Optional)
- [ ] Add monitoring/metrics
- [ ] Add email notifications
- [ ] Add audit trail
- [ ] Consider scheduled reset capability

---

## Success Criteria

✅ **Deployment Successful If:**
- Endpoint is accessible and returns expected responses
- Dry-run works correctly
- Actual reset (if performed) deletes expected data
- Preserved data remains intact
- System continues to function normally
- No errors in server logs

---

## Emergency Contacts

- **Database Issues:** Check Railway logs and database connection
- **API Issues:** Check server logs and endpoint accessibility
- **Data Loss:** Restore from backup immediately

---

## Documentation References

- **Complete Guide:** `TARGETED_RESET_GUIDE.md`
- **Quick Start:** `TARGETED_RESET_QUICK_START.md`
- **Implementation Status:** `TARGETED_RESET_IMPLEMENTATION_STATUS.md`
- **Final Summary:** `TARGETED_RESET_FINAL_SUMMARY.md`
- **Test Script:** `scripts/test-reset-target.sh`

---

**Last Updated:** 2025-01-20  
**Version:** 1.0.0

