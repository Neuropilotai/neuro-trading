# MacBook Trading Platform Audit Report

**Date:** 2026-01-28  
**Auditor:** Senior macOS Systems Engineer  
**Scope:** Trading platforms, bots, servers, databases, background services

---

## 🔍 Discovered Trading Platforms

### 1. **NeuroPilot AI Trading System** (PRIMARY - ACTIVE PROJECT)
- **Location:** `/Users/davidmikulis/neuro-pilot-ai`
- **Type:** Node.js webhook server + pattern recognition + backtest engine
- **Status:** ✅ **DORMANT** (not currently running)
- **Entry Point:** `simple_webhook_server.js` (port 3014)
- **Description:**
  - TradingView webhook receiver
  - Pattern recognition and filtering
  - Backtest engine
  - Risk management
  - Paper trading execution
  - Immutable trade ledger
- **Key Files:**
  - `simple_webhook_server.js` - Main webhook server
  - `cli/backtest.js` - Backtest CLI
  - `cli/smoke_pattern_pipeline.js` - Smoke test
  - `backend/services/patternRecognitionService.js`
  - `backend/services/backtestEngine.js`
  - `backend/services/riskEngine.js`
- **Databases:**
  - `data/evaluation.db` (84KB) - Pattern performance, backtests
  - `data/trade_ledger.db` (36KB) - Immutable trade records
- **Data Status:**
  - 2 patterns in `pattern_performance` table
  - 1 trade attribution in `trade_pattern_attribution` table
  - 10 trades logged in `trade_ledger` (0 filled)
- **Git Status:** Active branch `orb-qqq-db649` (trading-only, inventory removed)

### 2. **Python Trading Agents** (LEGACY/ARCHIVE)
- **Location:** `/Users/davidmikulis/neuro-pilot-ai/backend/agents/trading/`
- **Type:** Python trading bots (TradingView Pro integration)
- **Status:** ⚠️ **DORMANT** (Python virtual environment exists)
- **Files Found:**
  - `live_trading_agent.js` (Node.js wrapper)
  - `tradingview_pro_wrapper.js`
  - `learning_database.db` (SQLite)
  - `backend/trading_env/` (Python virtual environment)
- **Note:** Appears to be legacy code, possibly superseded by Node.js implementation

### 3. **Inventory Enterprise** (NOT TRADING - EXCLUDED)
- **Location:** `/Users/davidmikulis/neuro-pilot-ai/inventory-enterprise/`
- **Status:** ⚠️ **EXCLUDED** (inventory system, not trading)
- **Note:** Contains multiple inventory databases, but not trading-related

---

## ⚙️ Running Services

### Active Network Services
| Port | Process | Purpose | Status |
|------|---------|---------|--------|
| **3014** | ❌ None | TradingView webhook (expected) | **NOT RUNNING** |
| 27017 | `mongod` | MongoDB (inventory system) | ✅ Running (localhost only) |
| 5000 | ControlCenter | macOS Control Center | ✅ System service |
| 7000 | ControlCenter | macOS Control Center | ✅ System service |
| 15292 | Adobe | Adobe Creative Cloud | ✅ System service |

### Background Services Check
- **PM2:** ❌ Not installed / No processes
- **Cron Jobs:** ❌ No crontab entries
- **LaunchAgents:** ❌ No trading-related LaunchAgents found
- **Node.js Trading Processes:** ❌ None running
- **Python Trading Bots:** ❌ None running

### Port 3014 Status
- **Expected:** TradingView webhook server
- **Actual:** ❌ **NOT LISTENING**
- **Action Required:** Start server with `npm start` or `node simple_webhook_server.js`

---

## 🗄️ Databases

### Trading Databases (Active)

#### 1. **evaluation.db** (84KB)
- **Location:** `~/neuro-pilot-ai/data/evaluation.db`
- **Schema:** 
  - `pattern_performance` - Pattern statistics
  - `trade_pattern_attribution` - Trade-to-pattern links
  - `backtest_runs` - Backtest results
  - `walkforward_runs` - Walk-forward validation
  - `daily_risk_stats` - Daily risk metrics
- **Data:**
  - 2 patterns tracked
  - 1 trade attribution
- **Status:** ✅ **ACTIVE** (used by pattern recognition system)

#### 2. **trade_ledger.db** (36KB)
- **Location:** `~/neuro-pilot-ai/data/trade_ledger.db`
- **Schema:**
  - `trades` - Immutable trade records (append-only)
- **Data:**
  - 10 trades logged
  - 0 trades filled (all PENDING or REJECTED)
- **Status:** ✅ **ACTIVE** (used by webhook server)

#### 3. **learning_database.db** (Legacy)
- **Location:** `~/neuro-pilot-ai/backend/agents/trading/learning_database.db`
- **Status:** ⚠️ **LEGACY** (Python trading agent, may be unused)

### Inventory Databases (Excluded)
- Multiple inventory databases found in `inventory-enterprise/` directory
- **Not trading-related** - excluded from this audit

---

## 🧹 Cleanup Recommendations

### ✅ KEEP (Active Development)

1. **NeuroPilot AI Trading System** (`~/neuro-pilot-ai`)
   - **Reason:** Primary trading platform, actively developed
   - **Action:** Continue development, ensure it's the single source of truth
   - **Status:** ✅ **KEEP**

### ⚠️ ARCHIVE (Legacy/Unused)

1. **Python Trading Agents** (`~/neuro-pilot-ai/backend/agents/trading/`)
   - **Reason:** Legacy code, superseded by Node.js implementation
   - **Action:** 
     - Review if any unique functionality exists
     - If not needed, move to `archive/` directory
     - Keep `learning_database.db` if it contains valuable historical data
   - **Status:** ⚠️ **REVIEW & ARCHIVE**

### 🗑️ DELETE (Safe to Remove)

1. **Duplicate/Backup Databases**
   - `~/neuro-pilot-ai/.backup/backend/agents/trading/learning_database.db`
   - `~/neuro-pilot-ai/.backup/backend/db/users.db`
   - **Action:** Delete if backups are no longer needed
   - **Status:** 🗑️ **SAFE TO DELETE** (if backups exist elsewhere)

2. **Old Log Files**
   - `~/neuro-pilot-ai/cleanup_migration_20251208_112927.log`
   - `~/neuro-pilot-ai/ngrok_3020.log`
   - **Action:** Archive or delete old logs (>30 days)
   - **Status:** 🗑️ **SAFE TO DELETE** (if not needed for debugging)

### 📦 CONSOLIDATE

1. **Multiple .env Files**
   - Found: `.env.deployment`, `.env.v19.1.proposed`, `GROUP7_ENV_TEMPLATE.env`
   - **Action:** Consolidate into single `.env.example` for trading system
   - **Status:** 📦 **CONSOLIDATE**

---

## ▶️ Next Best Action

### Immediate Actions (Today)

1. **Start Trading Server** (if needed)
   ```bash
   cd ~/neuro-pilot-ai
   npm start
   # Verify: curl http://localhost:3014/health
   ```

2. **Review Python Trading Agents**
   ```bash
   cd ~/neuro-pilot-ai/backend/agents/trading
   # Review live_trading_agent.js and tradingview_pro_wrapper.js
   # Determine if still needed or can be archived
   ```

3. **Create .env.example**
   ```bash
   cd ~/neuro-pilot-ai
   # Create .env.example with all required trading system variables
   # (See TRADING_SYSTEM_AUDIT_REPORT.md section C.2)
   ```

### Short-Term Actions (This Week)

4. **Archive Legacy Python Agents**
   ```bash
   cd ~/neuro-pilot-ai
   mkdir -p archive/python-trading-agents
   mv backend/agents/trading/* archive/python-trading-agents/
   # Keep learning_database.db if it has valuable data
   ```

5. **Clean Up Old Logs**
   ```bash
   cd ~/neuro-pilot-ai
   # Move logs >30 days to archive/ or delete
   ```

6. **Consolidate .env Files**
   ```bash
   cd ~/neuro-pilot-ai
   # Create single .env.example from existing templates
   # Archive old .env.* files
   ```

### Long-Term Actions (Optional)

7. **Set Up Auto-Start** (if desired)
   - Create LaunchAgent for webhook server (only if you want it always running)
   - Or use PM2 for process management
   - **Recommendation:** Don't auto-start until system is production-ready

8. **Database Backup Strategy**
   - Set up automated backups for `evaluation.db` and `trade_ledger.db`
   - Store backups in `~/neuro-pilot-ai/backups/` or cloud storage

---

## 📊 Summary

### Current State
- **Active Trading Platforms:** 1 (NeuroPilot AI - dormant)
- **Running Services:** 0 (webhook server not running)
- **Active Databases:** 2 (evaluation.db, trade_ledger.db)
- **Legacy Code:** 1 (Python trading agents)

### Health Status
- ✅ **Clean:** No duplicate services, no conflicting ports
- ✅ **Organized:** Single primary trading project
- ⚠️ **Dormant:** Server not running (expected for development)
- ⚠️ **Legacy:** Python agents need review/archival

### Risk Assessment
- **Low Risk:** System is clean, no conflicts
- **No Data Loss Risk:** All databases intact
- **No Security Risk:** No exposed services, no unauthorized processes

---

## 🔒 Security Notes

- ✅ No unauthorized trading services running
- ✅ No exposed webhook endpoints (server not running)
- ✅ MongoDB only listening on localhost (inventory system)
- ✅ No cron jobs or auto-start services
- ⚠️ **Recommendation:** When deploying, use HTTPS and webhook authentication (already implemented in code)

---

**END OF AUDIT REPORT**

