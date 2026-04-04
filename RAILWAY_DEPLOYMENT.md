# NeuroPilot Trading v2 — Railway Deployment

**Scope:** Separate Railway service for v2 only. Legacy Railway service is not modified.

---

## Configuration recommandée (quick setup)

1. **Garder l’ancien Railway en place** — Ne rien modifier sur le service actuel.

2. **Créer un nouveau service Railway** — Nom recommandé : **neuropilot-trading-v2**.

3. **Configurer le nouveau service :**

   | Réglage | Valeur |
   |--------|--------|
   | **Root Directory** | `neuropilot_trading_v2` |
   | **Start Command** | `node server.js` |
   | **Health Check Path** | `/health` |
   | **Persistent Volume** | Monter un volume sur **/data** |

4. **Variables d’environnement minimales :**

   | Variable | Valeur |
   |----------|--------|
   | **DATA_DIR** | `/data` |
   | **NODE_ENV** | `production` |
   | **TRADINGVIEW_WEBHOOK_SECRET** | *(ton secret solide)* |
   | **TRADING_ENABLED** | `false` *(éviter le live par accident au début)* |
   | **ENABLE_WEBHOOK_AUTH** | `true` |

   **À ne pas définir au début** (le code utilise `DATA_DIR` par défaut) :  
   `WEBHOOK_PORT`, `LEDGER_DB_PATH`, `EVALUATION_DB_PATH`, `DEDUPE_CACHE_FILE` — laisse-les vides.

---

## 1. Deployment Checklist

- [ ] **Create new Railway service** (do not reuse the legacy trading service).
- [ ] **Connect repo** and set **Root Directory** to `neuropilot_trading_v2` (so build/start run from v2 only).
- [ ] **Set start command** to `node server.js` (or leave empty to use package.json `start`).
- [ ] **Set health check path** to `/health` (GET).
- [ ] **Add persistent volume** and set mount path to `/data`; set env **DATA_DIR=/data**.
- [ ] **Set required env vars** (see §2); at minimum: `DATA_DIR`, `PORT` (Railway sets PORT), `TRADINGVIEW_WEBHOOK_SECRET` if auth enabled.
- [ ] **Do not set** any env that points at the legacy app (different webhook URL, different DB paths).
- [ ] **Deploy** and confirm service is healthy via `/health` and `/debug/routes`.
- [ ] **Update TradingView alert** to use the new v2 webhook URL (after deploy).
- [ ] **Smoke test** the live webhook (e.g. one test alert) and confirm ledger or logs under `/data`.

---

## 2. Environment Variables for Railway

### Required (or have safe defaults)

| Variable | Required | Default | Notes |
|----------|----------|---------|--------|
| **PORT** | Set by Railway | 3014 | Railway injects this; do not override unless needed. |
| **DATA_DIR** | **Yes (Railway)** | `./data` | Set to **/data** when using a mounted volume so all DBs and files persist. |
| **NODE_ENV** | No | (unset) | Set to `production` on Railway for production behavior. |

### Webhook auth (recommended in production)

| Variable | Required | Default | Notes |
|----------|----------|---------|--------|
| **TRADINGVIEW_WEBHOOK_SECRET** | **Yes if auth on** | (none) | HMAC secret; must match TradingView alert. If unset and ENABLE_WEBHOOK_AUTH=true, webhook returns 500. |
| **ENABLE_WEBHOOK_AUTH** | No | `true` | Set to `false` only for local/testing. |
| **ENABLE_WEBHOOK_VALIDATION** | No | `true` | Payload validation; keep `true` in production. |

### Ledger and risk

| Variable | Required | Default | Notes |
|----------|----------|---------|--------|
| **ENABLE_TRADE_LEDGER** | No | `true` | Set `false` to disable SQLite ledger. |
| **ENABLE_RISK_ENGINE** | No | `true` | Set `false` to disable risk checks. |
| **ENABLE_WEBHOOK_DEDUPE** | No | `true` | Deduplication; keep `true` in production. |
| **ACCOUNT_BALANCE** | No | 500 / 100000 | Used for risk and paper balance; set for paper/live. |

### Paper vs live execution

| Variable | Required | Default | Notes |
|----------|----------|---------|--------|
| **BROKER** | No | `paper` | `paper` | `oanda` | `ibkr`. v2 minimal is usually `paper`. |
| **TRADING_ENABLED** | No | `false` | Must be `true` for paper/live execution; `false` = ledger-only (alert logging). |
| **ENABLE_PAPER_TRADING** | No | `true` | Paper execution on/off. |
| **TRADING_MODE** | No | `paper` | `paper` | `dry_run` | `live`. |

### Optional (overrides / tuning)

| Variable | Default | Notes |
|----------|---------|--------|
| **BRAIN_DIR** | (none) | If set, ledger uses BRAIN_DIR/ledger.sqlite instead of DATA_DIR/trade_ledger.db. |
| **LEDGER_DB_PATH** | DATA_DIR/trade_ledger.db | Explicit ledger path. |
| **EVALUATION_DB_PATH** | DATA_DIR/evaluation.db | Explicit evaluation DB path. |
| **RESEARCH_DB_PATH** | (derived) | Research DB path. |
| **DEDUPE_CACHE_FILE** | DATA_DIR/alert_cache.json | Dedupe cache path (defaults under DATA_DIR). |
| **WEBHOOK_RATE_LIMIT** | 10 | Max requests per minute per IP. |
| **WEBHOOK_PORT** | (same as PORT) | Legacy alias; Railway uses PORT. |
| **MAX_DAILY_LOSS_PERCENT** | 2.0 | Risk engine. |
| **MAX_POSITION_SIZE_PERCENT** | 25.0 | Risk engine. |
| **MAX_OPEN_POSITIONS** | 5 | Risk engine. |
| **ENABLE_BOS_ATR_FILTER** | true | BOS/ATR filter. |
| **ENABLE_TRADINGVIEW_ONLY_SYMBOLS** | true | Symbol router. |

### OANDA / IBKR (only if BROKER=oanda or ibkr)

- **OANDA:** OANDA_API_KEY or OANDA_API_TOKEN, OANDA_ACCOUNT_ID, OANDA_ENVIRONMENT (e.g. practice).
- **IBKR:** IBKR_HOST, IBKR_PORT, IBKR_CLIENT_ID, IBKR_ACCOUNT_ID.

### Do not use for v2 (legacy / other)

- **WORKER_INTERNAL_URL**, **WORKER_PORT**, **DEBUG_KEY** – worker/proxy; not needed for v2 minimal.
- **ENABLE_GOOGLE_DRIVE_SYNC**, **GOOGLE_DRIVE_*** – optional; not required for minimal v2.
- **TRADINGVIEW_PUBLIC_WEBHOOK_URL** – optional display only.

---

## 3. DB / Data Path Behavior on Railway

- **Ledger:** `brainPaths.getLedgerPath()` → **BRAIN_DIR**/ledger.sqlite if set, else **LEDGER_DB_PATH** if set, else **DATA_DIR**/trade_ledger.db. With **DATA_DIR=/data** and no BRAIN_DIR/LEDGER_DB_PATH: `/data/trade_ledger.db`.
- **Evaluation DB:** **EVALUATION_DB_PATH** if set, else **DATA_DIR**/evaluation.db → with **DATA_DIR=/data**: `/data/evaluation.db`.
- **Dedupe cache:** **DEDUPE_CACHE_FILE** if set, else **DATA_DIR**/alert_cache.json → `/data/alert_cache.json`.
- **Telemetry:** **DATA_DIR**/telemetry/last_tradingview_webhook.json → `/data/telemetry/...`.
- **Alert manager:** **DATA_DIR**/alerts → `/data/alerts`.
- **Webhook file backup:** **DATA_DIR**/webhook_logs/trades.json → `/data/webhook_logs/trades.json`.

All writable paths respect **DATA_DIR**. Set **DATA_DIR=/data** and mount a Railway volume at **/data** so that SQLite DBs and all file writes persist across deploys.

---

## 4. SQLite Storage: Use /data (Mounted Volume)

- **Recommendation:** Use a **single persistent volume** mounted at **/data** and set **DATA_DIR=/data**.
- **Why:** Ledger, evaluation DB, dedupe cache, telemetry, alerts, and webhook backup all default under DATA_DIR. One volume keeps persistence simple and avoids split storage.
- **Alternative:** Set **LEDGER_DB_PATH** and **EVALUATION_DB_PATH** and **DEDUPE_CACHE_FILE** explicitly to paths on a mounted volume; **DATA_DIR=/data** is simpler.

---

## 5. Recommended Railway Service Settings

| Setting | Value |
|---------|--------|
| **Root Directory** | `neuropilot_trading_v2` |
| **Start Command** | `node server.js` (or leave blank to use `npm start`) |
| **Health Check Path** | `/health` |
| **Health Check Type** | HTTP GET (Railway default) |
| **Persistent Volume Mount Path** | `/data` |
| **Env: DATA_DIR** | `/data` |
| **Env: NODE_ENV** | `production` |
| **Env: TRADINGVIEW_WEBHOOK_SECRET** | (set in Railway dashboard; do not commit) |

---

## 6. Exact Commands / Settings (Copy-Paste)

**Start command (if overriding):**
```bash
node server.js
```

**Health check:**
- Path: `/health`
- Expected: HTTP 200, JSON with `"status":"healthy"` (or similar).

**Required env (minimal for deploy):**
```bash
DATA_DIR=/data
NODE_ENV=production
TRADINGVIEW_WEBHOOK_SECRET=<your-secret>
```

**Optional (ledger-only, no execution):**
```bash
TRADING_ENABLED=false
ENABLE_PAPER_TRADING=false
```

**Optional (paper execution):**
```bash
TRADING_ENABLED=true
BROKER=paper
ACCOUNT_BALANCE=10000
```

---

## 7. Risks

| Risk | Mitigation |
|------|------------|
| **No volume / wrong DATA_DIR** | Ledger and files live on ephemeral disk; redeploy loses data. Set **DATA_DIR=/data** and mount volume at **/data**. |
| **Webhook secret missing** | With auth on, TradingView alerts get 500. Set **TRADINGVIEW_WEBHOOK_SECRET** in Railway. |
| **Legacy URL still in TradingView** | Alerts hit old service. After v2 deploy, update alert webhook URL to the new v2 service URL. |
| **PORT not used** | App listens on 3014 instead of Railway’s PORT; deployment may fail or not receive traffic. Do not set PORT in env; let Railway set it. |
| **Two services sharing one DB** | Do not point v2 at the same volume or DB as the legacy service; use a separate Railway service and volume. |
| **Secrets in logs** | Never log TRADINGVIEW_WEBHOOK_SECRET or API keys; app should already avoid this. |

---

## 8. Post-Deploy Verification

```bash
# Replace with your v2 Railway URL
BASE=https://your-v2-service.up.railway.app

curl -s $BASE/health | jq .
curl -s $BASE/debug/routes | jq .
# Webhook (use your secret in header or body)
curl -s -X POST $BASE/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: sha256=<hmac-of-body>" \
  -d '{"symbol":"XAUUSD","action":"BUY","price":2650,"quantity":0.01,"alert_id":"verify-'$(date +%s)'","timestamp":'$(date +%s)'}' | jq .
```
