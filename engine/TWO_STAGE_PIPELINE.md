# Two-Stage Pipeline (Feature Matrix + Fast Scan + Top-K)

## Changement fondamental

Au lieu de :
- générer 1 000 000 fichiers JS
- lancer 1 000 000 backtests complets

on fait :

**Étape 1 — Fast scan vectorisé**  
On évalue les règles comme des masques logiques sur les **mêmes données OHLC déjà en RAM** (feature matrix). Aucune relecture des données, aucun rechargement du moteur. On élimine ~99,5 % des setups très vite.

**Étape 2 — True backtest seulement sur les survivants**  
Ex. 1 000 000 combinaisons → fast scan garde 5 000 → vrai backtest sur 5 000 → bootstrap sur 100 meilleurs → evolution sur 20.

---

## Pipeline cible

```
Feature Matrix Builder (buildFeatureMatrix.js)
        ↓
Massive Parameter Grid (parameterGridDiscovery.js)
        ↓
Fast Vector Scan (fastVectorScan.js)
        ↓
Top-K Filter (pruneTopK.js)
        ↓
Parallel Full Backtest (runTopKBacktests.js)
        ↓
Bootstrap
        ↓
Evolution
        ↓
Champion Registry
```

---

## 1. Pré-calcul des features une seule fois

**engine/features/buildFeatureMatrix.js**

- Entrée : tableau de chandelles OHLCV.
- Sortie : **matrice en mémoire** (une ligne par bar) avec :
  - body_pct, close_strength, volume_ratio, session_phase, regime
  - + close, open, high, low pour win proxy optionnel.
- Toutes les stratégies lisent cette même matrice (plus de recalcul par setup).

---

## 2. Grid scan vectorisé

**engine/discovery/fastVectorScan.js**

- Entrée : feature matrix + liste de setups `{ name, rules }`.
- Pour chaque setup : application de **filtres logiques** sur chaque ligne (body_pct >= rules.body_pct_min, etc.), comptage des barres qui passent (= signal count).
- Option `winProxy` : parmi les barres qui passent, combien ont next-bar return > 0.
- Sortie : liste scorée (signalCount / score), triée. Pas encore un vrai backtest.

---

## 3. Two-stage screening

**Stage A (ultra-rapide)**  
- fastVectorScan + pruneTopK → on garde les setups avec au moins X signaux et un score intéressant.

**Stage B (backtest réel)**  
- **engine/batch/runTopKBacktests.js** : backtest complet (expectancy, drawdown, bootstrap, evolution) **uniquement** sur ces top-K.

---

## 4. Fichiers créés

| Fichier | Rôle |
|--------|------|
| **engine/features/buildFeatureMatrix.js** | Construit la matrice (body_pct, close_strength, volume_ratio, session_phase, regime, OHLC) une seule fois. |
| **engine/discovery/fastVectorScan.js** | Applique les règles comme masques sur la matrice, retourne signalCount / score par setup. |
| **engine/discovery/pruneTopK.js** | Garde les top K par score (pruneTopK(list, K)). |
| **engine/batch/runTopKBacktests.js** | Lance le backtest complet uniquement sur la liste top-K (même format de sortie que runStrategyBatch). |

---

## 5. Top-K pruning à chaque étape

Exemple de coupes successives :

- 1 000 000 setups générés
- top 50 000 après fast scan
- top 5 000 après quick backtest
- top 500 après full backtest
- top 100 après bootstrap
- top 20 après evolution

On ne traite jamais 1 million de setups en “full fidelity”.

---

## 6. Sharding par actif / timeframe

Découper par job :

- SPY 5m
- QQQ 5m
- BTCUSDT 5m
- BTCUSDT 1h

Chaque job : une feature matrix, un fast scan, un top-K backtest. Le M3 Pro fait plusieurs jobs ciblés au lieu d’un seul gros processus.

---

## 7. Bitcoin (ordre recommandé)

Pour aller plus vite, ajouter la crypto :

1. **BTCUSDT 5m**
2. **BTCUSDT 1h**
3. **ETHUSDT 5m**
4. **SOLUSDT 5m**

Marché 24/7, plus de données, plus de signaux, plus de régimes → apprentissage plus rapide.

---

## 8. Où les résultats vont

Avec `NEUROPILOT_DATA_ROOT` pointant vers ton volume (ex. `/Volumes/TradingDrive/NeuroPilotAI`) :

| Sortie | Chemin |
|--------|--------|
| Résultats batch (top-K backtests) | `$NEUROPILOT_DATA_ROOT/batch_results/strategy_batch_results.json` |
| Setups découverts (après bootstrap) | `$NEUROPILOT_DATA_ROOT/discovery/discovered_setups.json` |

Le two-stage écrit uniquement `strategy_batch_results.json`. Le fichier `discovered_setups.json` est produit par la chaîne bootstrap / evolution (nightly ou manuel).

---

## 8b. Binary OHLC Store (optionnel, 5×–20× plus rapide)

Pour charger les datasets encore plus vite : convertir chaque CSV en store binaire (`.bin`). Le loader utilise alors automatiquement le `.bin` s’il existe à côté du CSV.

- **Conversion** : `node engine/scripts/csvToBinary.js <path-to.csv> [symbol] [timeframe]`
- **Détail** : **engine/BINARY_OHLC_STORE.md**

Cela permet au M3 Pro d’analyser **5M à 10M stratégies par nuit** sans cloud.

---

## 9. Test rapide et datasets recommandés

**Test avec barres fictives (200 barres)**  
- CSV : `time,open,high,low,close,volume` (ex. `2023-01-01T14:30:00Z,382.5,383.2,382.3,383.0,150000`).  
- Placer le fichier : `$NEUROPILOT_DATA_ROOT/datasets/spy/spy_5m.csv` (au moins ~100 lignes de données).

Commande :

```bash
NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI \
  node engine/discovery/runTwoStageDiscovery.js SPY 5m spy_5m
```

Tu devrais voir : feature matrix built (Rows: XXX), parameter grid setups (ex. 1080), fast vector scan complete, top-K survivors, parallel backtests (workers: N), results written.

**Datasets réels pour un moteur puissant**

| Actifs | Timeframes |
|--------|------------|
| Actions : SPY, QQQ, IWM | 5m, 1h |
| Crypto : BTCUSDT, ETHUSDT, SOLUSDT | 5m, 1h |

Structure : `$NEUROPILOT_DATA_ROOT/datasets/<symbol>/<symbol>_<tf>.csv` (ex. `datasets/btcusdt/btcusdt_5m.csv`). Même format CSV : `time,open,high,low,close,volume`. Cela permet au moteur (Feature Matrix → Fast Vector Scan → Top-K → Parallel Backtests → Genetic Evolution) de découvrir des stratégies robustes sur plusieurs actifs et timeframes.

---

## Usage typique (programmatique)

```js
const { buildFeatureMatrix } = require('./engine/features/buildFeatureMatrix');
const { buildParameterGrid } = require('./engine/discovery/parameterGridDiscovery');
const { fastVectorScan } = require('./engine/discovery/fastVectorScan');
const { pruneTopK } = require('./engine/discovery/pruneTopK');
const { runTopKBacktests } = require('./engine/batch/runTopKBacktests');

const candles = await loadCandles(dataGroup);
const matrix = buildFeatureMatrix(candles, { symbol, timeframe });
const setups = buildParameterGrid({ patternNames: ['pattern_breakout'] });
const scored = fastVectorScan(matrix, setups, { minSignals: 20 });
const top = pruneTopK(scored, 5000);
await runTopKBacktests(dataGroup, top);
```
