# Commit Review Guide

## Review Buckets

### ✅ Bucket A — Core Code (Review First)
**Goal:** Confirm no hacky shortcuts, no hardcoded keys, no risky trading behavior.

**Files:**
- `backend/db/tradeLedger.js` (M - modified)
- `backend/middleware/riskCheck.js` (M - modified)
- `backend/services/automatedScalpingTrader.js` (M - modified)
- `backend/services/deduplicationService.js` (M - modified)
- `backend/services/learningDaemon.js` (M - modified)
- `backend/services/paperTradingService.js` (M - modified)
- `backend/services/patternLearningEngine.js` (M - modified)
- `backend/services/providerFactory.js` (M - modified)
- `backend/services/universeLoader.js` (M - modified)
- `backend/services/bosAtFilter.js` (?? - new)
- `backend/services/providers/tradingViewOnlyProvider.js` (?? - new)
- `backend/services/symbolRouter.js` (?? - new)
- `simple_webhook_server.js` (M - modified)

**Quick Review Checklist:**
- [ ] Search for: `TODO`, `FIXME`, `API_KEY`, `SECRET`, `bypass`, `force`
- [ ] Verify all `process.env` usage has safe defaults
- [ ] Check `console.log` statements are appropriate (not exposing secrets)
- [ ] Review risk management logic in `riskCheck.js`
- [ ] Verify ledger operations are atomic and safe

### ✅ Bucket B — Pine Strategy (Separate Commit)
**File:**
- `bos_choch_strategy_v6.pine` (?? - new)

**Note:** This should ALWAYS be its own commit, never mixed with backend code.

### ✅ Bucket C — Documentation (Commit Separately)
**Files:**
- `DEDUPE_FIX.md` (?? - new)
- `DEDUPE_VERIFICATION.md` (?? - new)
- `DEV_DEDUPE_ENDPOINTS.md` (?? - new)
- `MACBOOK_TRADING_AUDIT.md` (?? - new)
- `PAPER_STATE_REBUILD_IMPLEMENTATION.md` (?? - new)
- `SYMBOL_ROUTING_IMPLEMENTATION.md` (?? - new)
- `TEST_COMMANDS.md` (?? - new)
- `ALERT_ONLY_LEDGER_FIX.md` (?? - new)
- `BOS_ATR_FILTER_IMPLEMENTATION.md` (?? - new)
- `BOS_CHOCH_STRATEGY_REFINEMENT.md` (?? - new)
- `CACHE_VALIDATION_SUMMARY.md` (?? - new)
- `TRADING_ENV.example` (?? - new)

**Decision:** Either commit as `docs(trading): ...` or move to `/docs/trading/` for cleanliness.

### ✅ Bucket D — Config
**File:**
- `config/tradingview_watchlist.txt` (?? - new)

**Note:** Commit only if meant to be shared (not user-specific).

---

## Commit Sequence (4-6 commits)

### Commit 1: Dedupe + Routing Backend
```bash
git add backend/services/deduplicationService.js \
        backend/services/symbolRouter.js \
        backend/services/providers/tradingViewOnlyProvider.js \
        backend/services/providerFactory.js

git commit -m "feat(trading): add dedupe + symbol routing + TradingView-only provider"
```

### Commit 2: Risk + Ledger Correctness
```bash
git add backend/middleware/riskCheck.js \
        backend/db/tradeLedger.js

git commit -m "fix(trading): risk checks + ledger attribution corrections"
```

### Commit 3: Trader Engine Changes
```bash
git add backend/services/automatedScalpingTrader.js \
        backend/services/paperTradingService.js \
        backend/services/patternLearningEngine.js \
        backend/services/learningDaemon.js \
        backend/services/universeLoader.js \
        backend/services/bosAtFilter.js

git commit -m "feat(trading): improve paper trader + learning engine + execution flow"
```

### Commit 4: Webhook Server
```bash
git add simple_webhook_server.js

git commit -m "feat(trading): webhook server with dedupe, routing, and ALERT_ONLY support"
```

### Commit 5: Pine Strategy
```bash
git add bos_choch_strategy_v6.pine

git commit -m "feat(pine): BOS/CHOCH v6 strategy with visualization and faster pivots"
```

### Commit 6: Documentation Bundle
```bash
git add DEDUPE_FIX.md \
        DEDUPE_VERIFICATION.md \
        DEV_DEDUPE_ENDPOINTS.md \
        MACBOOK_TRADING_AUDIT.md \
        PAPER_STATE_REBUILD_IMPLEMENTATION.md \
        SYMBOL_ROUTING_IMPLEMENTATION.md \
        TEST_COMMANDS.md \
        ALERT_ONLY_LEDGER_FIX.md \
        BOS_ATR_FILTER_IMPLEMENTATION.md \
        BOS_CHOCH_STRATEGY_REFINEMENT.md \
        CACHE_VALIDATION_SUMMARY.md \
        TRADING_ENV.example

git commit -m "docs(trading): dedupe, routing, paper-state rebuild notes"
```

### Commit 7: Config (Optional)
```bash
git add config/tradingview_watchlist.txt

git commit -m "chore(trading): add TradingView watchlist"
```

### Commit 8: Package Dependencies
```bash
git add package.json package-lock.json

git commit -m "chore(deps): add express, dotenv, express-rate-limit for webhook server"
```

---

## Cursor Review Workflow

### Step 1: Open Bucket A Files Only
Open these files in Cursor (one bucket at a time):
1. `backend/services/automatedScalpingTrader.js` (entry point)
2. Follow imports from there to other files

### Step 2: Quick Danger Scan
Use Cursor "Find in Files" (Cmd+Shift+F) for:
- `TODO` - unfinished work
- `FIXME` - known issues
- `console.log` - verify no secrets logged
- `process.env` - verify safe defaults
- `API_KEY` - should not exist
- `SECRET` - should not exist
- `bypass` - risky behavior
- `force` - risky behavior

### Step 3: Review Entry Point First
Start with `backend/services/automatedScalpingTrader.js` and follow the flow:
- How does it initialize?
- What services does it depend on?
- Are error paths handled?

### Step 4: Review Risk Management
Focus on `backend/middleware/riskCheck.js`:
- Are all risk checks enforced?
- Can anything bypass risk checks?
- Are TradingView-only symbols handled correctly?

### Step 5: Review Ledger Operations
Focus on `backend/db/tradeLedger.js`:
- Are operations atomic?
- Is state rebuild logic correct?
- Can data corruption occur?

---

## Current Status

**Modified Files (M):** 13
**New Files (??):** 15

**Total Files to Review:** 28

---

## Quick Safety Checks Performed

✅ **No hardcoded API keys found** (all use `process.env`)
✅ **No hardcoded secrets found** (all use `process.env`)
✅ **Console.log statements** are informational only (no secrets)
✅ **process.env usage** has safe defaults throughout

**Potential Concerns:**
- Multiple `console.log` statements (consider logging framework for production)
- Environment variable dependencies (ensure `.env` is documented)

---

## Next Steps

1. Review Bucket A files in Cursor
2. Run the commit sequence above (one commit at a time)
3. Test after each commit to ensure nothing breaks
4. Consider moving docs to `/docs/trading/` for better organization

