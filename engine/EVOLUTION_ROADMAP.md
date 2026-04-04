# NeuroPilot Evolution — 3 modules

Roadmap pour la prochaine évolution : stratégies qui survivent plusieurs nuits → registry champion → exécution live via TradingView.

---

## Vue d’ensemble

```
  Nightly Lab (np_nightly_lab.sh)
       │
       ▼
  Discovery (SPY/QQQ/IWM 5m) → discovered_setups.json, strategy_batch_results.json
       │
       ▼
  Brain snapshot → brain_snapshots/discovered_setups_*.json
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ Strategy Mutation Engine                                                 │
  │ Lit discovered_setups → top N → 5–10 mutations chacun → generated_strategies/setup_mut_*.js │
  └─────────────────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 1️⃣ Strategy Evolution Engine                                            │
  │    Garde seulement les stratégies qui survivent plusieurs nuits.        │
  └─────────────────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 2️⃣ Champion Strategy Registry                                           │
  │    champion_setups/champion_registry.json = stratégies robustes.         │
  └─────────────────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 3️⃣ Live Trading Bridge + Execution Gate                                 │
  │    TradingView → webhook → check registry (champion only) → execution.   │
  └─────────────────────────────────────────────────────────────────────────┘
```

**Chaque nuit :** AI explore (Discovery + **Parameter Grid**) → AI teste (Batch) → AI sélectionne (Evolution) → AI améliore (Mutation).

---

## Two-Stage Pipeline (Feature Matrix + Fast Scan + Top-K)

Pour viser **1M combinaisons** sans 1M backtests complets :

- **engine/features/buildFeatureMatrix.js** — Pré-calcul des features une seule fois (body_pct, close_strength, volume_ratio, session_phase, regime) ; une matrice en RAM lue par tous les setups.
- **engine/discovery/fastVectorScan.js** — Scan vectorisé : applique les règles comme masques logiques sur la matrice, compte les signaux par setup (pas de backtest).
- **engine/discovery/pruneTopK.js** — Garde les top K par score (pruneTopK(list, K)).
- **engine/batch/runTopKBacktests.js** — Backtest complet **uniquement** sur les survivants du fast scan.

Voir **engine/TWO_STAGE_PIPELINE.md** (pipeline cible, Top-K pruning, sharding actif/timeframe, ordre Bitcoin).

---

## Strategy Parameter Space Engine (implémenté)

- **engine/discovery/parameterGridDiscovery.js** — Explore un espace de paramètres (body_pct_min, close_strength_min, volume_ratio, session_phase) au lieu de stratégies une par une. Produit cartésien → 108 combos/pattern ; 10 patterns = 1080 stratégies. Écrit `setup_grid_000.js` … dans `generated_strategies/` (le batch charge tous les `setup_*.js`).
- **Nightly** : définir `PARAMETER_GRID_PATTERNS=1` (ou 10) pour lancer la grille en [0/9] avant Discovery. Voir **engine/PARAMETER_GRID_AND_CRYPTO.md** (crypto, Binance, multi-asset, parallélisation, genetic evolution).

---

## 1️⃣ Strategy Evolution Engine

**Objectif :** Ne garder que les stratégies qui tiennent sur plusieurs runs nocturnes.

**Entrées :**
- `$DATA_ROOT/discovery/discovered_setups.json` (ranking actuel)
- `$DATA_ROOT/batch_results/strategy_batch_results.json`
- Historique des `brain_snapshots/` (discovered_setups_*.json, strategy_batch_results_*.json)

**Logique (à implémenter) :**
- Comparer le ranking de la nuit N avec les nuits N-1, N-2, …
- Une stratégie **survit** si elle reste dans le top (ex. top 10 ou au-dessus d’un seuil d’expectancy) sur au moins K nuits (ex. K = 2 ou 3).
- Sortie : liste de setup_ids « évolués » prêts pour la promotion champion.

**Intégration :** ✅ Implémenté.
- `engine/evolution/strategyEvolution.js` — orchestrateur (charge l’historique, score, écrit le registry).
- `engine/evolution/loadNightlyHistory.js` — lit `brain_snapshots/discovered_setups_*.json`, agrège par setupId.
- `engine/evolution/scoreSetupSurvival.js` — règles validated/champion (expectancy, trades, bootstrap, nuits consécutives).
- Appelé chaque nuit après le brain snapshot (étape [5/7] dans `np_nightly_lab.sh`).
- Sortie : `$DATA_ROOT/champion_setups/champion_registry.json` (generatedAt, champions[], status, survivalScore, nightsSurvived, avgExpectancy, avgBootstrapRisk).

**Référence existante :**  
`NIGHTLY_LAB.md` § « Règle de promotion » (expectancy > 0, trades ≥ 20, bootstrap ≤ 20 %, pas un seul micro-segment).

---

## 2️⃣ Champion Strategy Registry

**Objectif :** `champion_setups/` contient **uniquement** les stratégies robustes (validées par l’évolution).

**Contenu typique :**
- Fichiers ou métadonnées par setup champion : id, symbol/timeframe, paramètres, lien vers Pine/source.
- Option : un `champion_setups/manifest.json` qui liste les setup_ids champions et leur métadonnées (PF, expectancy, dernière nuit validée).

**Règles :**
- Promotion : un setup n’entre dans `champion_setups/` que s’il sort du **Strategy Evolution Engine** (survie multi-nuits).
- Démotion : si une stratégie disparaît du top pendant X nuits, la retirer du registry (ou marquer deprecated).
- Une seule source de vérité pour « quelles stratégies sont autorisées en live » ; le **Live Trading Bridge** ne prend que les setups présents dans ce registry.

**Référence existante :**
- Dossier déjà prévu : `$DATA_ROOT/champion_setups/` (créé par `np_nightly_lab.sh`, décrit dans `DATA_ARCHITECTURE.md`, `NIGHTLY_LAB.md`).
- `config/championPath.js` (côté `trading/`) : `ALLOWED_SETUP_IDS`, `CHAMPION_EXCLUDED_SETUP_IDS` — à terme, on peut alimenter ou synchroniser cette config à partir de `champion_setups/manifest.json` pour garder un seul endroit « champion ».

---

## 3️⃣ Live Trading Bridge

**Objectif :** Les stratégies gagnantes sont exécutées automatiquement : **TradingView → webhook → trading engine**.

**Flux :**
1. L’utilisateur (ou un script) crée des alertes TradingView pour les setups champions (Pine script déployé, conditions de signal).
2. TradingView envoie une alerte vers l’URL webhook (ex. `POST /webhook/tradingview`).
3. Le serveur webhook reçoit le payload (symbol, action, setup_id, etc.), valide que le `setup_id` est bien dans le **Champion Strategy Registry**.
4. Le trading engine exécute l’ordre (paper ou live selon config).

**Existant :**
- `neuropilot_trading_v2`: `server.js`, `npm run webhook` — endpoint webhook.
- `trading/simple_webhook_server.js` : réception TradingView, validation, ledger.
- `trading/config/championPath.js` : `ALLOWED_SETUP_IDS`, `isSetupIdAllowedForImport`, `allowShortsForSetup` — à brancher sur le registry champion (fichier ou API qui lit `champion_setups/`).

**À faire :**
- Brancher le webhook sur le registry : accepter uniquement les `setup_id` retournés par `champions/getChampionsOnly(registry)` (voir `engine/champions/README.md`).
- Documentation utilisateur : quelles alertes créer dans TradingView pour chaque champion, quelle URL webhook, format du body.

---

## Champion Registry Filter (implémenté)

- **engine/champions/loadChampionRegistry.js** — Charge `champion_registry.json`.
- **engine/champions/filterChampionSetups.js** — Filtre par statut : `getByStatus(registry, 'candidate'|'validated'|'champion')`, `getChampionsOnly(registry)` pour le Live Bridge.

---

## SetupId canonique stable (implémenté)

- **engine/evolution/canonicalSetupId.js** — `computeCanonicalSetupId({ name, rules })` produit un id court stable : préfixe lisible (name + session_phase ou regime) + `_` + 6 caractères SHA1 du slug complet (ex. `pattern_001_mid_9fa34c`). `shortHash(str)` exporté.
- **engine/batch/runStrategyBatch.js** — Utilise le canonical setupId quand le module généré expose `name` et `rules` ; sinon fallback sur le nom de fichier.
- Le même id apparaît ainsi dans `strategy_batch_results.json`, `discovered_setups.json`, `brain_snapshots/*.json`, et `champion_registry.json`.

---

## Ordre d’implémentation suggéré

1. **Strategy Evolution Engine** — critères de survie multi-nuits + écriture des candidats.
2. **Champion Registry** — promotion/démotion depuis les candidats, écriture de `champion_setups/manifest.json` (ou équivalent).
3. **Live Bridge** — brancher le webhook sur le registry (refuser les setup_id non champions), doc TradingView.

---

## Champion Execution Gate (implémenté)

- **engine/champions/executionGate.js** — `isChampionAllowed(setupId)` : true seulement si le setup est dans le registry avec status `champion`. Cache 1 min. Si registry absent ou vide → allow all (rétrocompat).
- **server.js** — Middleware webhook après dédupe : lit `setup_id` / `setup_name` / `setupName`, rejette en 403 si non champion. Feature flag : `ENABLE_CHAMPION_GATE=false` pour désactiver.

## Genetic Strategy Evolution Engine (implémenté)

- **strategyCrossover.js** — `crossover(rulesA, rulesB)` : combine deux parents (chaque règle de A ou B, ou moyenne pour nombres).
- **rankPopulation.js** — Fusionne discovered_setups + champion_registry, tri par fitness (expectancy, bootstrap_risk, trades).
- **geneticPopulation.js** — `selectTopWithRules(ranked, strategyMap, topK)` ; `produceOffspring(parents, opts)` → mutations + crossovers.
- **runGeneticEvolution.js** — Rank → select top K → mutate + crossover → écrit `setup_gen_*.js` dans generated_strategies (batch les prend la nuit suivante).
- **Nightly [7/9]** : Genetic Mutation + Crossover (`runGeneticEvolution.js 10 3 5`). Voir **engine/evolution/GENETIC_EVOLUTION.md**.

---

## Strategy Mutation Engine (implémenté)

- **engine/evolution/strategyMutation.js** — Lit `discovered_setups.json`, sélectionne les meilleurs (top N par expectancy), génère 5–10 mutations chacun (règles proches du parent : `body_pct_min` ±0.05, `close_strength_min` ±0.05, `volume_ratio` ±0.2), écrit dans `generated_strategies/` (`setup_mut_<parent>_<i>.js`). Le batch backtest (étape 4 du discovery) charge tous les `setup_*.js` donc inclut les mutations au prochain run.
- **Pipeline nuit** : Discovery → Brain snapshot → **Mutation** → Evolution → Backup. Appel dans `np_nightly_lab.sh` : `node engine/evolution/strategyMutation.js 5 8` (top 5 parents, 8 mutations chacun).
- **Contrôle** : mutations restent proches du parent (deltas configurables dans `MUTATION_DELTAS`), valeurs clampées (ratios 0–1, volume_ratio 0–2).

---

## Fichiers clés existants

| Rôle | Fichier / dossier |
|------|--------------------|
| Pipeline discovery | `engine/discovery/runStrategyDiscovery.js` |
| Ranking sortie | `$DATA_ROOT/discovery/discovered_setups.json` |
| Batch backtest | `$DATA_ROOT/batch_results/strategy_batch_results.json` |
| Snapshots historiques | `$DATA_ROOT/brain_snapshots/discovered_setups_*.json` |
| Dossier champion | `$DATA_ROOT/champion_setups/` |
| Config champion (trading) | `trading/config/championPath.js` |
| Webhook TradingView | `trading/simple_webhook_server.js`, `neuropilot_trading_v2/server.js` |
| Doc nightly | `engine/NIGHTLY_LAB.md` |
| Doc data | `engine/DATA_ARCHITECTURE.md` |
