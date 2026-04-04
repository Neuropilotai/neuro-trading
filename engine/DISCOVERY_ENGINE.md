# AI Strategy Discovery Engine — Concept & Roadmap

## Concept

**Moteur actuel :**
```
dataset → rules (trend_breakout etc.) → backtest → bootstrap validation
```

**Discovery Engine (couche ajoutée) :**
```
dataset
  → feature extraction
  → pattern discovery
  → generate candidate setups
  → backtest
  → bootstrap validation
  → ranking
```
→ La machine cherche elle-même des idées.

---

## Pipeline en 6 étapes

| # | Étape | Fichier / module | Sortie |
|---|--------|-------------------|--------|
| 1 | Feature extraction | `features/buildFeatureDataset.js` | `$DATA_ROOT/features/features_<symbol>_<tf>.json` |
| 2 | Pattern discovery | `discovery/clusterPatterns.js` | Clusters / règles (body > 60%, close_strength > 0.7, session mid, etc.) |
| 3 | Génération de stratégies | `discovery/generateCandidateStrategies.js` | `$DATA_ROOT/generated_strategies/setup_XXX.js` |
| 4 | Backtest batch | `batch/runStrategyBatch.js` | expectancy, trades, par setup |
| 5 | Bootstrap batch | `validation/bootstrapBatch.js` | bootstrap risk % par setup |
| 6 | Ranking | (déjà partiel dans `strategyRanking.js`) | `research/discovered_setups.json` |

**Walk-forward (optionnel) :** `validation/walkForwardTest.js` — train 2019–2022, test 2023 ; train 2020–2023, test 2024. Si un setup survit → signal fort.

---

## Étape 1 — Feature extraction

Chaque candle → vecteur de caractéristiques.

**Exemple de feature vector :**
```json
{
  "body_pct": 0.72,
  "range_pct": 0.45,
  "close_strength": 0.81,
  "trend_slope": 0.6,
  "distance_from_ma20": 0.3,
  "volatility_state": "narrow",
  "session_phase": "mid",
  "regime": "BREAKOUT"
}
```

Le moteur peut générer ça pour chaque barre.  
**Fichier :** `engine/features/buildFeatureDataset.js`  
**Sortie :** `research/features_SPY_5m.json`

---

## Étape 2 — Pattern discovery

Question : *quels patterns précèdent les trades gagnants ?*

Exemples : high body, strong close, mid session, trend slope > 0.

**Méthodes possibles :**
- Clustering (k-means, DBSCAN)
- Règles simples : body > 60%, close_strength > 0.7, session mid, trend slope > 0

C’est l’équivalent de ce qui a été trouvé manuellement (confirmed + strength + BREAKOUT). L’AI peut proposer des dizaines de patterns.

**Fichier :** `engine/discovery/clusterPatterns.js`

---

## Étape 3 — Génération automatique de stratégies

Les patterns deviennent des règles testables.

**Exemple généré :** `setup_023`  
- body > 65%  
- close_strength > 0.75  
- session mid  

→ Fichier créé : `engine/generatedStrategies/setup_023.js` (compatible avec le backtest actuel).

**Fichier :** `engine/discovery/generateCandidateStrategies.js`

---

## Étape 4 — Backtest automatique

Le moteur actuel suffit. On lance N setups (ex. 500) en batch.

Chaque setup produit : expectancy, trades, (puis bootstrap, max drawdown).

**Fichier :** `engine/batch/runStrategyBatch.js`

---

## Étape 5 — Bootstrap & ranking

- **Bootstrap batch :** pour chaque setup, % samples avec expectancy < 0.  
- **Filtre :** garder seulement expectancy > 0, trades ≥ 30, bootstrap risk < 20%.  
- **Ranking :** tri par expectancy puis bootstrap risk.

**Exemple de résultat :**

| Rank | Setup | Expectancy | Trades | Bootstrap risk |
|------|--------|------------|--------|----------------|
| 1 | setup_117 | 0.31R | 54 | 8% |
| 2 | setup_083 | 0.27R | 63 | 11% |
| 3 | setup_021 | 0.24R | 48 | 14% |

**Fichiers :** `engine/validation/bootstrapBatch.js`, intégration dans le pipeline de ranking.

---

## Étape 6 — Walk-forward (optionnel)

- Train : 2019–2022, Test : 2023  
- Train : 2020–2023, Test : 2024  

Si un setup survit sur la fenêtre de test → crédibilité forte.

**Fichier :** `engine/validation/walkForwardTest.js`

---

## Architecture dans le projet

```
engine/
  features/
    buildFeatureDataset.js    # 1. feature extraction
  discovery/
    clusterPatterns.js        # 2. pattern discovery
    generateCandidateStrategies.js  # 3. strategy generation
    runStrategyDiscovery.js   # orchestration : une commande fait tout
  batch/
    runStrategyBatch.js       # 4. backtest N setups
  validation/
    bootstrapBatch.js         # 5. bootstrap sur N setups
    walkForwardTest.js       # 6. walk-forward
  generatedStrategies/       # setups générés (setup_001.js …)
```

---

## Commande cible

```bash
node engine/discovery/runStrategyDiscovery.js SPY 5m
```

Le moteur enchaîne :

1. Feature extraction  
2. Pattern clustering  
3. Génération de stratégies  
4. Backtest  
5. Bootstrap  
6. Ranking  

**Sortie :** `$DATA_ROOT/discovery/discovered_setups.json`

*(Data root = `NEUROPILOT_DATA_ROOT` si défini et monté, sinon `./data_workspace`. Voir `engine/DATA_ARCHITECTURE.md`.)*

---

## Exemple de sortie (objectif)

**Top discovered setups**

| # | Setup | Expectancy | Trades | Bootstrap risk |
|---|--------|------------|--------|----------------|
| 1 | momentum_body_break | 0.34R | 72 | 9% |
| 2 | narrow_range_break | 0.29R | 61 | 12% |
| 3 | late_session_break | 0.26R | 54 | 15% |

---

## Pourquoi c’est puissant pour Neuro.Pilot.AI

Le moteur devient une **AI strategy factory**.  
On peut lancer la découverte sur : SPY, QQQ, IWM, NQ, ES, BTC, ETH et faire émerger de nouveaux setups en continu.

**Avantage :** la plupart des traders testent 1 idée ; ce moteur peut en tester des milliers (backtest + bootstrap) en une nuit.

---

## État actuel vs manquant

**Déjà en place (~70 %) :**
- Data pipeline  
- Strategy rules (trend_breakout, etc.)  
- Backtest engine  
- Bootstrap validation  

**À ajouter :**
- Feature extraction (buildFeatureDataset)  
- Pattern discovery (clusterPatterns)  
- Strategy generation (generateCandidateStrategies)  
- Batch testing (runStrategyBatch)  
- Bootstrap batch + walk-forward  

Ce document et les stubs dans `engine/features/`, `engine/discovery/`, `engine/batch/`, `engine/validation/` définissent les interfaces et le flux pour implémenter ces briques.
