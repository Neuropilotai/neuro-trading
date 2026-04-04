# Genetic Strategy Evolution Engine

## Idée

1. Le moteur découvre beaucoup de setups (grid + discovery).
2. Il garde les meilleurs (Evolution + Champion Registry).
3. Il mute légèrement les gagnants (strategyMutation).
4. Il croise des gagnants entre eux (strategyCrossover).
5. Il reteste tout (batch la nuit suivante).
6. Il élimine les faibles (Evolution / ranking).
7. Il recommence nuit après nuit.

Flux : **discover → mutate → crossbreed → test → select → evolve**.

## Pourquoi c’est plus puissant qu’un grid fixe

- **Grid** : teste toutes les combinaisons prévues, n’invente rien au-delà.
- **Génétique** : part des meilleurs, crée des variantes (mutation) et combine des règles qui marchent (crossover), concentre la puissance sur les zones prometteuses.

## Modules

| Fichier | Rôle |
|--------|------|
| **strategyMutation.js** | Mutations légères (body_pct_min ±0.05, etc.). Déjà utilisé en [5/9]. |
| **strategyCrossover.js** | `crossover(rulesA, rulesB)` → un offspring (chaque clé prise de A ou B, ou moyenne pour nombres). |
| **rankPopulation.js** | Fusionne discovered_setups + champion_registry, tri par fitness (expectancy, bootstrap_risk, trades). |
| **geneticPopulation.js** | `selectTopWithRules(ranked, strategyMap, topK)` ; `produceOffspring(parents, opts)` → mutations + crossovers. |
| **runGeneticEvolution.js** | Orchestre : rank → select top → mutate + crossover → écrit `setup_gen_*.js` dans generated_strategies. |

Les `setup_gen_*.js` sont chargés au prochain run de runStrategyBatch (tous les `setup_*.js` sont pris en compte).

## Flux nightly cible

```
[0]   Parameter grid (optionnel)
[1/9] Discovery SPY 5m
[2/9] Discovery QQQ 5m
[3/9] Discovery IWM 5m (si données)
[4/9] Brain snapshot
[5/9] Strategy Mutation
[6/9] Strategy Evolution
[7/9] Genetic Mutation + Crossover   ← runGeneticEvolution.js 10 3 5
[8/9] Backup GDrive
[9/9] Finalizing logs
```

## CLI

```bash
node engine/evolution/runGeneticEvolution.js [topK] [mutationsPerParent] [crossoverPairs]
# Défaut : 10 3 5  → 10 parents, 3 mutations chacun, 5 paires de crossover
```

## Dossiers 5TB

- `evolution_runs/` — prévu pour sauvegarder l’historique des générations (optionnel).
- `generated_strategies/` — contient `setup_*.js`, `setup_grid_*.js`, `setup_mut_*.js`, `setup_gen_*.js`.

## Suite : Meta-Ranking AI

Prochaine couche possible : ne pas juger les setups seulement sur l’expectancy, mais sur :

- stabilité multi-nuits  
- robustesse bootstrap  
- cohérence cross-asset / cross-timeframe  
- drawdown profile  
- survivabilité live  

→ “Ce setup gagne, survit, se répète, et mérite du capital.”

## Evolution budget allocation (Family Expansion)

La répartition des types de mutation (parameter_jitter, forced_family_shift, session_flip, regime_flip, hybrid_family_shift) peut être pilotée par un **budget cible** (%), au lieu du seul poids adaptatif basé sur `mutation_perf.json`.

- **Fichier** : `discovery/evolution_budget.json` (sous le data root). Exemple : `engine/evolution/evolution_budget.example.json`.
- **Format** : un objet avec une part (0–1) par type. Ex. `{ "parameter_jitter": 0.70, "forced_family_shift": 0.20, "session_flip": 0.07, "regime_flip": 0.03, "hybrid_family_shift": 0 }`. Les parts sont normalisées à somme 1 ; 0 = type jamais choisi.
- **Priorité** : `opts.evolutionBudget` > `discovery/evolution_budget.json` > variable d’env `EVOLUTION_BUDGET` (JSON) > défaut en dur (70/20/7/3/0).
- **Désactiver le budget** : passer `opts.useAdaptiveMutationOnly: true` pour ne plus utiliser le budget et garder uniquement la sélection adaptative (`pickMutation`).

## Crypto (BTCUSDT, etc.)

Recommandation : ajouter les datasets crypto sur le 5TB, brancher BTCUSDT (5m, 1h) dans le nightly, lancer le grid sur BTC 5m, vérifier discovery + batch + evolution en multi-actifs, puis le Genetic Engine exploitera aussi les meilleurs setups crypto.
