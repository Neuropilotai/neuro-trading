# Datasets — SPY, QQQ, BTCUSDT 5m

## Option 0 — Téléchargement automatique (recommandé)

Si tu ne veux pas placer les CSV à la main :

```bash
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
node engine/scripts/autoDownloadDatasets.js
```

Puis lancer la conversion + discovery : `./engine/scripts/runDiscoverySpyQqqBtc.sh`

**Pipeline complet en une commande :**

```bash
node engine/scripts/autoDownloadDatasets.js && ./engine/scripts/runDiscoverySpyQqqBtc.sh
```

Ou : `./engine/scripts/runFullPipeline.sh`

---

## Étape 1 — Placer les vrais CSV (manuel)

Mettre un fichier CSV OHLCV **réel** (pas fictif) à chaque emplacement suivant. Format attendu : **une ligne d’en-tête** puis une ligne par barre.

**En-tête :** `time,open,high,low,close,volume`  
**Exemple de ligne :** `2023-01-01T14:30:00Z,382.5,383.2,382.3,383.0,150000`

| Fichier | Chemin complet |
|--------|----------------|
| SPY 5m | `/Volumes/TradingDrive/NeuroPilotAI/datasets/spy/spy_5m.csv` |
| QQQ 5m | `/Volumes/TradingDrive/NeuroPilotAI/datasets/qqq/qqq_5m.csv` |
| BTCUSDT 5m | `/Volumes/TradingDrive/NeuroPilotAI/datasets/btcusdt/btcusdt_5m.csv` |
| XAUUSD 5m  | `/Volumes/TradingDrive/NeuroPilotAI/datasets/xauusd/xauusd_5m.csv` |
| XAUUSD 1h  | `/Volumes/TradingDrive/NeuroPilotAI/datasets/xauusd/xauusd_1h.csv` |

Créer les dossiers si besoin :
```bash
mkdir -p /Volumes/TradingDrive/NeuroPilotAI/datasets/spy
mkdir -p /Volumes/TradingDrive/NeuroPilotAI/datasets/qqq
mkdir -p /Volumes/TradingDrive/NeuroPilotAI/datasets/btcusdt
```

Puis copier ou télécharger vos CSV (broker, Yahoo, Binance, etc.) vers ces chemins.

## Étapes 2–5 — Conversion binaire + two-stage

Une fois les CSV en place, lancer le script (depuis la racine du projet `neuropilot_trading_v2`) :

```bash
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
./engine/scripts/runDiscoverySpyQqqBtc.sh
```

Ou manuellement :

**Étape 2 — SPY en .bin**
```bash
NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI node engine/scripts/csvToBinary.js /Volumes/TradingDrive/NeuroPilotAI/datasets/spy/spy_5m.csv SPY 5m
```

**Étape 3 — Two-stage SPY**
```bash
NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI node engine/discovery/runTwoStageDiscovery.js SPY 5m spy_5m
```

**Étape 4 — QQQ (convertir + two-stage)**
```bash
node engine/scripts/csvToBinary.js /Volumes/TradingDrive/NeuroPilotAI/datasets/qqq/qqq_5m.csv QQQ 5m
NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI node engine/discovery/runTwoStageDiscovery.js QQQ 5m qqq_5m
```

**Étape 5 — BTCUSDT 5m**
```bash
node engine/scripts/csvToBinary.js /Volumes/TradingDrive/NeuroPilotAI/datasets/btcusdt/btcusdt_5m.csv BTCUSDT 5m
NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI node engine/discovery/runTwoStageDiscovery.js BTCUSDT 5m btcusdt_5m
```

Résultats : `$NEUROPILOT_DATA_ROOT/batch_results/strategy_batch_results.json` (écrasé à chaque run ; pour garder plusieurs actifs, sauvegarder ou lancer des runs séparés avec des noms de dataGroup différents).
