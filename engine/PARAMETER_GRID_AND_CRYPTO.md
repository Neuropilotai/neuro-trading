# Parameter Space Engine & Crypto Multi-Asset

## 1. Problème du pipeline actuel

- Discovery teste typiquement **100–500 stratégies / nuit**.
- Limitation : peu de combinaisons, une stratégie = un fichier JS, génération lente.

## 2. Solution : Strategy Parameter Space Engine

Au lieu de créer des stratégies une par une, on explore un **espace de paramètres**.

**Grille par défaut** (`engine/discovery/parameterGridDiscovery.js`) :

| Paramètre           | Valeurs                    |
|---------------------|----------------------------|
| body_pct_min        | [0.4, 0.5, 0.6, 0.7]       |
| close_strength_min  | [0.6, 0.7, 0.8]            |
| volume_ratio        | [1.0, 1.2, 1.5]            |
| session_phase       | [open, mid, close]         |

**Combinaisons** : 4 × 3 × 3 × 3 = **108 stratégies** par pattern.  
Avec **10 patterns** : 10 × 108 = **1080 stratégies**.  
Avec **Mutation Engine** (5 mutations chacune) : 1080 × 5 = **5400 stratégies / nuit**.

## 3. Module : parameterGridDiscovery.js

- **buildParameterGrid(opts)** — produit la liste `[{ name, rules }, ...]` (produit cartésien de la grille).
- **writeGridToStrategies(setups, outDir)** — écrit `setup_grid_000.js` … dans `generated_strategies/`. Le batch charge tous les `setup_*.js` donc inclut la grille.
- **runParameterGridDiscovery(opts)** — build + write en une fois.

**CLI :**

```bash
node engine/discovery/parameterGridDiscovery.js [patternCount] [writeToDisk]
# 1 pattern  → 108 setups
# 10 patterns → 1080 setups
# 3e arg = no-write pour ne pas écrire sur disque
```

**Nightly (optionnel) :** définir `PARAMETER_GRID_PATTERNS=1` (ou 10) avant de lancer le lab pour exécuter la grille en étape [0/9] ; les runs Discovery suivants (SPY, QQQ, …) voient à la fois les setups cluster et les setups grille.

## 4. Parallélisation (prochaine étape)

- Lancer le batch en **workers parallèles** (ex. CPU cores = 10 sur M3 Pro).
- 5400 stratégies / nuit avec un seul dataset ; avec **stocks + crypto** : 20k–100k stratégies / nuit possibles.

## 5. Crypto : datasets et actifs

**Avantage crypto** : 24h / jour vs actions ~6,5h → environ **4× plus de données** pour l’apprentissage.

**Structure recommandée :**

```
datasets/
  spy/
  qqq/
  iwm/
  btcusdt/
    btcusdt_1m.csv
    btcusdt_5m.csv
    btcusdt_1h.csv
  ethusdt/
    ethusdt_5m.csv
    ethusdt_1h.csv
  solusdt/
    solusdt_5m.csv
```

**Données historiques Binance :** [Binance Data Vision](https://data.binance.vision) — ex. **BTCUSDT-1m**, klines par mois. Télécharger, convertir en CSV au format attendu par le loader (symbole, timeframe, colonnes OHLCV).

## 6. Discovery multi-asset

Le nightly lab peut enchaîner :

```bash
# Actions
node engine/discovery/runStrategyDiscovery.js SPY 5m
node engine/discovery/runStrategyDiscovery.js QQQ 5m
node engine/discovery/runStrategyDiscovery.js IWM 5m
# Crypto
node engine/discovery/runStrategyDiscovery.js BTCUSDT 5m
node engine/discovery/runStrategyDiscovery.js BTCUSDT 1h
node engine/discovery/runStrategyDiscovery.js ETHUSDT 5m
node engine/discovery/runStrategyDiscovery.js SOLUSDT 5m
```

À ajouter dans `np_nightly_lab.sh` quand les datasets crypto sont prêts (dossiers `datasets/btcusdt/` etc. et CSV au bon format).

## 7. Architecture finale NeuroPilot

```
Parameter Discovery (grid + cluster)
        ↓
Massive Strategy Grid (setup_grid_*.js + setup_*.js)
        ↓
Mutation Engine (setup_mut_*.js)
        ↓
Parallel Backtesting (runStrategyBatch — à paralléliser)
        ↓
Evolution Engine
        ↓
Champion Registry
        ↓
Execution Gate
        ↓
Trading (TradingView webhook)
```

## 8. Prochaine évolution : Genetic Strategy Evolution

Au-delà de *discover* et *mutate* : **crossbreed** et **evolve** (sélection, croisement de règles, évolution sur plusieurs générations). Méthode utilisée dans certains labs quant / hedge funds.

---

**Résumé** : le Parameter Space Engine est en place ; la grille peut être lancée via `PARAMETER_GRID_PATTERNS` la nuit. Crypto et multi-asset sont documentés ; il reste à brancher les CSV Binance et les lignes Discovery crypto dans le script nocturne quand les données sont prêtes.
