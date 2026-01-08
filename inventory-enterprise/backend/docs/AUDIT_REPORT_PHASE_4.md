# Phase 4 System Audit Report
## NeuroPilot Inventory Enterprise - January 2026

### Executive Summary

This comprehensive audit covered:
1. **Datetime PostgreSQL Compatibility** - Fixed SQLite syntax across 15 files
2. **Security Hardening** - Implemented fail-safe JWT secret handling
3. **FIFO Cost Layers** - Deep audit with 23 issues identified
4. **Price Bank System** - Deep audit with 11 issues identified

**Branch:** `claude/audit-inventory-system-DgMED`

---

## 1. Datetime PostgreSQL Compatibility Fixes

### Changes Made (15 files)

| File | Instances Fixed |
|------|-----------------|
| security/sso_google.js | 1 |
| security/sso_microsoft.js | 1 |
| ai/forecast/ForecastingEngine.js | 9 |
| ai/forecast/ForecastService.js | 2 |
| ai/forecast/FeedbackTrainer.js | 5 |
| ai/forecast/BreakfastPredictor.js | 2 |
| ai/forecast/MenuPredictor.js | 2 |
| ai/security/SecurityScannerService.js | 6 |
| ai/learning/LearningSignals.js | 6 |
| ai/learning/AITunerService.js | 2 |
| ai/learning/HealthPredictionService.js | 2 |
| ai/agent/OwnerAIAgent.js | 3 |
| ai/local_training/LocalTrainer.js | 1 |
| ai/feedback/ingest.js | 3 |
| ai/rl/RLAgent.js | 1 |

### Conversions Applied

```
datetime('now')           → CURRENT_TIMESTAMP
DATE('now')               → CURRENT_DATE
datetime('now', '-N days') → CURRENT_TIMESTAMP - INTERVAL 'N days'
DATE('now', '-N days')    → CURRENT_DATE - INTERVAL 'N days'
```

---

## 2. Security Hardening

### JWT Secret Fail-Safe Implementation

**Files Modified:**
- `config/security.js` - Added `getJwtSecret()` and `getRefreshSecret()` functions
- `config/env.js` - Added production check for JWT_SECRET
- `routes/auth-db.js` - Added `getSecret()` helper with production validation
- `src/middleware/auth-enhancement.js` - Added secure `getJwtSecret()` function

### Behavior

| Environment | JWT_SECRET Missing | Action |
|-------------|-------------------|--------|
| Production (NODE_ENV=production) | Yes | **Application fails to start with error** |
| Development | Yes | Uses dev fallback with console warning |
| Any | Yes (configured) | Uses configured secret normally |

**Security Improvement:** Prevents accidental deployment with insecure default secrets.

---

## 3. FIFO Cost Layers Audit

### Summary: 23 Issues Found

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 Critical | 5 | Identified |
| 🟠 High | 7 | Identified |
| 🟡 Medium | 11 | Identified |

### Critical Issues

#### 3.1 Schema Inconsistency (CRITICAL)
**Location:** `services/FifoLayerService.js`, migrations
**Issue:** Duplicate column names (`remaining_qty` vs `quantity_remaining`)
- Migration 014 creates `quantity_remaining`
- Some code references non-existent `remaining_qty`
- Defensive COALESCE patterns mask the issue

#### 3.2 Race Condition in consumeFromFifo() (CRITICAL)
**Location:** `services/FifoLayerService.js:437-472`
**Issue:** No transaction isolation level specified
- Default READ COMMITTED allows dirty reads
- Multiple consumers can over-consume same layer
**Fix:** Use `SERIALIZABLE` isolation or `SELECT...FOR UPDATE`

#### 3.3 Org_id Type Mismatch (CRITICAL)
**Location:** Multiple files
**Issue:** `org_id` treated as both INTEGER and VARCHAR
- `sysco_invoice_lines.org_id` is INTEGER
- `inventory_items.org_id` is UUID
- String 'default-org' used throughout

#### 3.4 Negative Inventory Possible (CRITICAL)
**Issue:** No CHECK constraint preventing `quantity_remaining < 0`
**Fix:** Add `CHECK (quantity_remaining >= 0)`

#### 3.5 N+1 Query Problem (HIGH)
**Location:** `services/FifoLayerService.js:173-229`
**Issue:** Item Bank lookup called per line in loop
**Fix:** Batch load all references before loop

### Performance Issues

| Issue | Location | Impact |
|-------|----------|--------|
| No pagination | getLayersForItem() | Memory exhaustion |
| OR in WHERE | Lines 404, 735 | Full table scan |
| Multiple JOINs | getLayersWithInvoiceInfo() | Slow queries |
| N+1 queries | populateFromVendorOrder() | 100x slower |

---

## 4. Price Bank System Audit

### Summary: 11 Issues Found

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 Critical | 3 | Identified |
| 🟠 High | 3 | Identified |
| 🟡 Medium | 5 | Identified |

### Critical Issues

#### 4.1 SQL Syntax Error (CRITICAL)
**Location:** `services/PriceAnomalyService.js:196-213`
**Issue:** `ON CONFLICT DO NOTHING` missing constraint specification
```sql
-- Current (BROKEN):
ON CONFLICT DO NOTHING

-- Should be:
ON CONFLICT (org_id, item_code, invoice_line_id) DO NOTHING
```

#### 4.2 Division by Zero (CRITICAL)
**Location:** `services/PriceAnomalyService.js:72`
**Issue:** No validation before dividing by `stats.average`
```javascript
const variance = (newPrice - stats.average) / stats.average;
// Produces Infinity if average is 0
```

#### 4.3 Org_id Type Inconsistency (CRITICAL)
**Issue:** Different types across tables
- `price_bank` uses TEXT
- `price_anomalies` uses VARCHAR(255)
- `sysco_invoice_lines` uses INTEGER

### High Priority Issues

| Issue | Location | Impact |
|-------|----------|--------|
| Type conversion precision loss | detect-price-anomalies.js:134-167 | Inaccurate calculations |
| Missing zero-check | PriceAnomalyService.js:67-74 | NaN results |
| Inconsistent history threshold | Service=3, Script=2 | Inconsistent detection |

---

## 5. Recommendations

### Immediate Actions (Before Next Deploy)

1. **Fix ON CONFLICT syntax** in PriceAnomalyService.js
2. **Add division-by-zero checks** before variance calculations
3. **Standardize org_id type** across all tables

### Short-Term (This Sprint)

4. Add race condition protection with `SELECT...FOR UPDATE`
5. Add `CHECK (quantity_remaining >= 0)` constraint
6. Fix N+1 query in FIFO layer population
7. Add pagination to FIFO layer queries

### Medium-Term (Next Sprint)

8. Create definitive schema migration for FIFO tables
9. Add comprehensive validation for price bank inputs
10. Implement proper error handling with metrics
11. Add unit tests for edge cases

---

## 6. Commits Made

### Commit 1: Datetime Fixes
```
Fix SQLite datetime() syntax for PostgreSQL compatibility across 15 files

V23.6.15: Convert SQLite datetime functions to PostgreSQL:
- datetime('now') → CURRENT_TIMESTAMP
- DATE('now') → CURRENT_DATE
- datetime('now', '-N days') → CURRENT_TIMESTAMP - INTERVAL 'N days'
```

### Commit 2: Security Hardening
```
Security hardening: Fail-safe JWT secret handling in production

V23.6.15: Critical security improvement:
- In production: App fails to start if secrets missing
- In development: Uses clearly-marked dev fallback with warnings
```

---

## 7. Files Modified Summary

| Category | Files Changed | Lines Changed |
|----------|---------------|---------------|
| Datetime fixes | 15 | ~51 |
| Security hardening | 4 | ~70 |
| **Total** | **19** | **~121** |

---

## 8. Next Steps

1. Review and merge PR on branch `claude/audit-inventory-system-DgMED`
2. Prioritize critical FIFO and Price Bank fixes
3. Install test dependencies and verify fixes
4. Consider creating separate PRs for FIFO/Price Bank fixes

---

*Report generated: January 2026*
*Auditor: Claude (Opus 4.5)*
*Version: V23.6.15*
