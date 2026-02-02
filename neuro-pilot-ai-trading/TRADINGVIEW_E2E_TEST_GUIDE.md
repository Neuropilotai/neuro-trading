# TradingView End-to-End Test Guide

## 🎯 Objectif

Tester la boucle complète: **TradingView → ngrok → webhook → ledger** et valider que le cooldown est "action-aware" (bloque BUY, jamais CLOSE).

---

## 📋 Prérequis

✅ Serveur local healthy (port 3001)  
✅ ngrok tunnel actif  
✅ Auth ON, riskEngine ON, ledger OK, paper broker OK

---

## 🔧 Phase A — Configuration TradingView

### A1) Webhook URL dans TradingView

Dans l'alerte TradingView, configure:

**Webhook URL:**
```
https://fd1400f2b7dc.ngrok-free.app/webhook/tradingview
```

⚠️ **Remplace par ton URL ngrok actuelle** (obtenir avec: `curl -s http://127.0.0.1:4040/api/tunnels | jq '.tunnels[0].public_url'`)

### A2) Payload TradingView (avec secret)

Dans le champ **"Message"** de l'alerte TradingView, colle ce JSON (adapte `symbol`, `price`, `quantity`):

```json
{
  "symbol": "XAUUSD",
  "action": "BUY",
  "quantity": 0.05,
  "price": {{close}},
  "stop_loss": {{close}} - 10,
  "take_profit": {{close}} + 20,
  "alert_id": "TV_XAU_BUY_{{timenow}}",
  "timestamp": {{timenow}},
  "timeframe": "5m",
  "confidence": 0.65,
  "secret": "YOUR_SECRET_HERE"
}
```

⚠️ **Le secret doit correspondre exactement à `TRADINGVIEW_WEBHOOK_SECRET` dans `env.production.paper`**

### A3) Envoyer 1 alerte BUY

Déclenche l'alerte depuis TradingView. Vérifie les logs serveur pour confirmer la réception.

---

## ✅ Phase B — Vérifications

### B1) Vérifier que l'ordre est FILLED

```bash
curl -s "http://127.0.0.1:3001/api/dashboard/trades?limit=5" | jq '.success, .count, .trades[0].status, .trades[0].action, .trades[0].symbol'
```

**Résultat attendu:**
- `success: true`
- `count: > 0`
- `status: "FILLED"`
- `action: "BUY"`
- `symbol: "XAUUSD"`

### B2) Vérifier ledger (optionnel)

```bash
sqlite3 /Users/davidmikulis/neuro-pilot-ai-data/ledger.sqlite "SELECT trade_id, action, status, symbol, created_at FROM trades ORDER BY created_at DESC LIMIT 5;"
```

---

## 🧪 Phase C — Test Cooldown Action-Aware

### C1) BUY → doit être FILLED

Déjà fait en Phase A.

### C2) CLOSE immédiat → doit être FILLED (pas "COOLDOWN")

**Option 1: Via TradingView (alerte CLOSE)**

Crée une 2e alerte TradingView avec:

```json
{
  "symbol": "XAUUSD",
  "action": "CLOSE",
  "quantity": 0.05,
  "price": {{close}},
  "alert_id": "TV_XAU_CLOSE_{{timenow}}",
  "timestamp": {{timenow}},
  "timeframe": "5m",
  "confidence": 0.65,
  "secret": "YOUR_SECRET_HERE"
}
```

**Option 2: Via curl (plus rapide)**

```bash
TS=$(python3 - <<'PY'
import time; print(int(time.time()*1000))
PY
)

curl -s -X POST http://127.0.0.1:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d "{
    \"symbol\":\"XAUUSD\",
    \"action\":\"CLOSE\",
    \"quantity\":0.05,
    \"price\":2050.5,
    \"alert_id\":\"TV_XAU_CLOSE_${TS}\",
    \"timestamp\":${TS},
    \"timeframe\":\"5m\",
    \"confidence\":0.65,
    \"secret\":\"UNqptOT1YjZno4HMrltyDOMyNeMPf2YPuTqp7Osi9VjeX5yDQHqOPssz2C74Cz-l\"
  }" | jq '.data.status, .data.rejection_reason, .message'
```

**✅ Résultat attendu:**
- `status: "FILLED"`
- `rejection_reason: null`
- `message: "Trade alert received and validated"`

Si `rejection_reason` contient "COOLDOWN", c'est un **BUG** — CLOSE ne doit jamais être bloqué par cooldown.

---

## 🚀 Script Automatique

Pour tester tout automatiquement:

```bash
cd neuro-pilot-ai-trading
./scripts/test-end-to-end-tradingview.sh
```

Ce script:
1. Détecte l'URL ngrok
2. Vérifie la santé du serveur
3. Envoie un BUY
4. Vérifie le dashboard
5. Envoie un CLOSE immédiat
6. Vérifie que CLOSE n'est pas bloqué par cooldown
7. Affiche un résumé

---

## 📊 Validation Finale

**Checklist "5 étoiles":**

- [ ] BUY order → FILLED
- [ ] Dashboard affiche le trade
- [ ] Ledger enregistre le trade
- [ ] CLOSE order → FILLED (immédiatement après BUY)
- [ ] CLOSE n'est **jamais** bloqué par cooldown

Si tous les points sont ✅, le système est prêt pour staging/prod.

---

## 🔍 Dépannage

### Problème: "Invalid secret"
- Vérifie que `TRADINGVIEW_WEBHOOK_SECRET` dans `env.production.paper` correspond au secret dans le payload TradingView

### Problème: "COOLDOWN" sur CLOSE
- **BUG CRITIQUE** — CLOSE ne doit jamais être bloqué
- Vérifie `webhookRoutes.js` ligne 423-431: cooldown doit vérifier `isBuy` avant de bloquer

### Problème: ngrok URL change
- ngrok URLs changent à chaque redémarrage
- Utilise `curl -s http://127.0.0.1:4040/api/tunnels | jq '.tunnels[0].public_url'` pour obtenir l'URL actuelle
- Mets à jour l'alerte TradingView avec la nouvelle URL

---

## 📝 Notes

- Le secret est actuellement en "body secret" (dans le JSON). Pour production, on migrera vers HMAC signature header.
- Le cooldown est configuré à 900 secondes (15 minutes) dans `env.production.paper`
- Le cooldown est "action-aware": bloque seulement BUY, jamais CLOSE/SELL

