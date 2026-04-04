# NeuroPilot Trading v2

Minimal runnable trading core: webhook entry, ledger, risk, config. Isolated from the legacy `trading/` tree.

---

## Exact startup (local)

From this directory (`neuropilot_trading_v2/`):

```bash
npm install
mkdir -p data
cp .env.example .env
npm start
```

Server listens on **port 3014** (or `PORT` from `.env`). No archive or moves of `trading/` are performed.

---

## Test commands

**Smoke test (startup + /health + /debug/routes + webhook request):**

```bash
npm run test:smoke
```

**Manual checks (server running):**

```bash
curl -s http://localhost:3014/health | jq .
curl -s http://localhost:3014/debug/routes | jq .
```

**Webhook (auth disabled for testing):**

```bash
curl -s -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{"symbol":"XAUUSD","action":"BUY","price":2650,"quantity":0.01,"alert_id":"test1","timestamp":'$(date +%s)'}' | jq .
```

With auth enabled, set `TRADINGVIEW_WEBHOOK_SECRET` in `.env` and send `X-TradingView-Signature: sha256=<hmac_hex>` or include `secret` in the JSON body.

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info and links to main endpoints. |
| `GET /health` | Health, features, broker, risk, dedupe, account. |
| `GET /debug/routes` | List of registered routes (path + methods). |
| `POST /webhook/tradingview` | TradingView alert webhook (auth, validation, dedupe, risk, ledger, optional execution). |

---

## Stubs (required for startup)

All of these are required at load time by `server.js`. Do not remove until you refactor to lazy-load or drop the routes that use them:

- **tradingLearningService** – also used on webhook path (learnFromTrade no-op).
- **indicatorGenerator** – also used on webhook path (enabled: false).
- **patternRecognitionService**, **patternLearningAgents**, **patternLearningEngine**, **learningDaemon**, **dailyPatternTracker**, **automatedScalpingTrader**, **tradingViewSync**, **universeLoader**, **whaleDetectionAgent**.

See **V2_VALIDATION_REPORT.md** for the full dependency map, minimum execution path, and which stubs are required for the webhook path vs only for startup/other routes.

---

## Railway deployment

Deploy v2 as a **separate** Railway service (do not reuse the legacy service). Set **Root Directory** to `neuropilot_trading_v2`, mount a volume at **/data**, set **DATA_DIR=/data** and **TRADINGVIEW_WEBHOOK_SECRET**. See **RAILWAY_DEPLOYMENT.md** for checklist, env vars, health path, and risks.

---

## Docs

- **V2_MIGRATION_REPORT.md** – What was copied into v2, pending review, non-trading list, next steps.
- **V2_VALIDATION_REPORT.md** – Validation, dependency map, stub list, smoke test, exact commands.
- **RAILWAY_DEPLOYMENT.md** – Railway checklist, env list, DB paths, volume, risks.

---

## Notes

- **sqlite3:** If `npm install` fails building `sqlite3`, fix your build environment (e.g. Python `distutils`, Xcode CLI tools) or use a prebuilt sqlite3; see Node/sqlite3 docs.
- **Data:** Ledger and evaluation DB are under `data/` (or `DATA_DIR`). Create `data` before first run.
- No archive or deletes of the old codebase are performed from v2.
