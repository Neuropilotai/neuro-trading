# P7 — Run trend memory (multi-runs)

**Statut** : P7 implémenté (suggestif) ; **P7.1** apply optionnel implémenté (voir §11).  
**Objectif** : mémoire **multi-runs** explicable, bornée, réversible, qui **suggère** des ajustements à P5 (mutation policy) et P6 (portfolio governor / admission) à partir de **tendances**, pas d’un seul cycle.

---

## 1. Principes (garde-fous)

| Principe | Exigence |
|----------|-----------|
| Explicable | Chaque score / flag a `reasons[]` et `inputsUsed{}` (comptages, pas de secrets). |
| Borné | Toute sortie numérique clampée ; pas de croissance sans limite d’un run à l’autre. |
| Réversible | `trendMemoryVersion` + historique append-only ; désactivation via env ou fichier `disabled: true`. |
| Versionné | `trendMemoryVersion` dans JSON ; migrations documentées. |
| Pas d’auto-amplification | Pas de boucle positive non plafonnée (ex. max ±X % sur les poids P5 par fenêtre). |

---

## 2. Module proposé

- **Fichier** : `engine/governance/runTrendMemory.js` (CLI `node engine/governance/runTrendMemory.js`)
- **Responsabilité** : lire N derniers cycles (fichiers + historiques), calculer signaux agrégés, écrire décision courante + append historique.

---

## 3. Entrées (décision figée)

| Source | Usage |
|--------|--------|
| **Historique `governance_mini_report`** | **Source officielle figée** : `discovery/reports/governance_mini_report_<experimentId>.json` (1 fichier par run). |
| **`discovery/portfolio_governor_history.json`** | Déjà append-only ; fenêtre glissante sur les K dernières entrées. |
| **`discovery/mutation_policy_history.json`** | Historique P5 (déjà produit par `adaptMutationPolicy.js`). |
| **`governance/experiment_registry.json`** | Métadonnées runs (optionnel : nombre d’artefacts, durées si enrichies plus tard). |

**Pointeur courant** : `discovery/governance_mini_report.json` reste le dernier rapport (compat rétro).

**Fenêtre glissante** : `TREND_MEMORY_WINDOW_SIZE` (défaut recommandé 30, plage usuelle 20–50).

**Ordre des archives** : `runTrendMemory.js` trie les fichiers `governance_mini_report_*.json` par **`generatedAt`** (ISO, croissant), puis `experimentId`, puis chemin ; si `generatedAt` est absent ou invalide, repli sur **`mtime`** du fichier. La fenêtre prend les **N derniers** dans cet ordre chronologique logique (plus de dépendance principale au seul mtime).

**Rétention** : `TREND_MEMORY_MAX_FILES` (défaut recommandé 200), purge FIFO des plus anciens archives.

---

## 4. Sorties (contrat minimal figé)

| Fichier | Rôle |
|---------|------|
| **`discovery/run_trend_memory.json`** | État courant : signaux, décisions **suggérées** (pas d’écriture directe dans P5/P6 sans consommation explicite), version, `generatedAt`. |
| **`discovery/run_trend_memory_history.json`** | Append : `{ at, snapshotRef | summary }` pour audit. |
| **`governance/p7_metrics_events.log`** | Une ligne **`[P7 metrics]`** par run (préfixe ISO) — qualité archive / apply / statut ; agrégation `governance/p7_metrics.json` via `engine/observability/p7Metrics.js`. |

Contrat JSON minimal attendu :

Champs additionnels : **`producingCycleId`** — cycle qui a produit ce snapshot (`NEUROPILOT_CYCLE_ID` / `EXPERIMENT_ID`), peut être `null` hors pipeline.

```json
{
  "trendMemoryVersion": "p7-v1",
  "generatedAt": "",
  "dataRoot": "",
  "producingCycleId": "",
  "windowSize": 30,
  "experimentsConsidered": [],
  "signals": {
    "degradedRate": 0,
    "blockedRate": 0,
    "avgInvalidRatio": 0,
    "fallbackRate": 0,
    "avgBudgetUtilization": 0,
    "zeroExpansionRate": 0,
    "avgHoldCashRate": 0
  },
  "familyStats": {},
  "mutationDrift": {},
  "suggestions": {
    "policyAdjustments": {
      "familiesToDeprioritize": [],
      "familiesToBoost": [],
      "mutationTypeWeightDeltas": {}
    },
    "portfolioAdjustments": {
      "exposureMultiplier": 1,
      "maxNewAllocationsDelta": 0,
      "admissionThresholdDelta": 0
    }
  },
  "safety": {
    "bounded": true,
    "notes": []
  }
}
```

---

## 5. Signaux à calculer (v1)

Sur une fenêtre **W** runs (env `TREND_MEMORY_WINDOW`, défaut ex. 10) :

1. **Gouvernance** : fréquence `DEGRADED` / `BLOCKED` (mini report ou équivalent dérivé).
2. **Budget** : `files_written << mutationBudget` (sous-utilisation récurrente) depuis mini + expansion si présent dans l’historique.
3. **Familles stériles** : familles souvent dans `familiesToExpand` mais peu / pas de `files_written` (agrégation par clé famille si traçable).
4. **Fallback** : taux `fallbackApplied` (supervisor / expansion) sur la fenêtre.
5. **Cash / admission** : fréquence `holdCash`, `promotionMode === 'blocked'` ou `conservative` (governor history).
6. **Promotions** : `promoted === 0` ou forte baisse vs moyenne mobile (depuis `promoted_children` si archivé ; sinon proxy via governor `maxNewAllocations` / modes).
7. **Mutation types** : stabilité ou dérive des poids (mutation_policy_history).

Chaque signal : `value`, `threshold`, `triggered: boolean`, `explanation` (string courte).

---

## 6. Décisions **suggérées** (v1) + activation contrôlée

Structure type dans `run_trend_memory.json` :

```json
{
  "trendMemoryVersion": "p7-v1",
  "windowRuns": 10,
  "suggestions": {
    "p5": {
      "mutationWeightAdjustments": { },
      "explorationScale": 1.0,
      "familiesToPenalize": []
    },
    "p6": {
      "admissionBias": "neutral",
      "targetExposureScale": 1.0
    }
  },
  "decisionReasons": [],
  "coverageWarning": null
}
```

Exemples de règles (à coder avec clamps) :

- Plusieurs cycles **BLOCKED** d’affilée → `explorationScale` vers le bas (borné).
- **Fallback** très fréquent → assouplir légèrement un filtre **suggéré** (documenté), ou relever plafond d’exploration **borné**.
- **holdCash** / **blocked** promotions fréquents → `admissionBias: "conservative"` pour le **run suivant** (P6 lit en entrée optionnelle).
- Familles répétitivement stériles → liste `familiesToPenalize` (P5 ignore ou down-weight si clé présente).

Par défaut :
- **Suggestif uniquement** (aucune modification automatique P5/P6).

Activation explicite :
- `TREND_MEMORY_APPLY=true`
- Option : `TREND_MEMORY_APPLY_MODE=conservative`

Garde-fous obligatoires si apply:
- Clamp des deltas (ex. `[-0.2, +0.2]` ou équivalent en points absolus selon champ).
- Pas de cumul infini inter-runs (deltas calculés depuis baseline, pas depuis baseline déjà modifiée sans borne).
- Rollback trivial : remettre `TREND_MEMORY_APPLY=false`.
- Logs / traces : `appliedFromTrendMemory` + `appliedDeltas`.

---

## 7. Intégration pipeline (figée)

| Phase | Action |
|-------|--------|
| **Fin de run** (après `generateGovernanceMiniReport.js` ou en 8.6) | 1) archiver mini report en `discovery/reports/governance_mini_report_<experimentId>.json` + maintenir le pointeur `discovery/governance_mini_report.json`; 2) `node engine/governance/runTrendMemory.js`; 3) append artefact `run_trend_memory`. |
| **Début de run suivant (P7.1)** | Si `TREND_MEMORY_APPLY=true` : P5 (`adaptMutationPolicy.js`) et P6 (`portfolioGovernor.js`) lisent `run_trend_memory.json` et appliquent des ajustements **bornés** (voir §11). |
| **Registry** | `appendArtifact(experimentId, 'run_trend_memory', path)` |

---

## 8. Smoke plan

1. **Fixtures** : petit jeu de `portfolio_governor_history` + `mutation_policy_history` + mini-reports synthétiques (3–5 entrées).
2. **Scénario A** : tendance saine → suggestions neutres, pas de pénalité.
3. **Scénario B** : enchaînement DEGRADED/BLOCKED → `admissionBias` ou `explorationScale` bougent dans les bornes.
4. **Scénario C** : fallback répété → suggestion documentée (assouplissement borné).
5. **Reproductibilité** : même entrées → même sortie (pas d’horodatage dans les clés de hash des signaux).

---

## 9. Dépendances avec l’existant

- **P5** : `mutation_policy_history.json`, `mutation_policy.json`
- **P6** : `portfolio_governor_history.json`, `portfolio_governor.json`
- **P4 / reporting** : `governance_mini_report.json` (+ stratégie d’archive pour vraie multi-run)
- **experiment_registry** : traçabilité artefact `run_trend_memory`

---

## 10. Checklist implémentation (P7)

- [x] `runTrendMemory.js` + fenêtre W
- [x] Archivage mini-reports (`discovery/reports/`) + rétention FIFO
- [x] `run_trend_memory.json` + `run_trend_memory_history.json`
- [x] Fin de pipeline + `appendArtifact`
- [x] Smoke `engine/scripts/smokeRunTrendMemory.js`
- [x] P7.1 `TREND_MEMORY_APPLY` : fusion bornée P5 / P6 (`trendMemoryApply.js`, smoke `smokeTrendMemoryApply.js`)

---

## 11. P7.1 — Apply mode (implémenté)

**Module** : `engine/governance/trendMemoryApply.js`

| Variable | Rôle |
|----------|------|
| `TREND_MEMORY_APPLY=true` | Active l’application sur le run courant (lit `discovery/run_trend_memory.json` du run **précédent** ou dernier fichier présent). |
| `TREND_MEMORY_APPLY_MODE=conservative` | **Sous-ensemble** : ajustements **portfolio uniquement** (`exposureMultiplier`, `maxNewAllocationsDelta`, `admissionThresholdDelta`). **Pas** de mutation weights sauf flag ci-dessous. |
| `TREND_MEMORY_APPLY_MODE=full` | Portfolio + `mutationTypeWeightDeltas` (tous clampés). |
| `TREND_MEMORY_APPLY_MUTATIONS=true` | En mode `conservative`, autorise quand même l’application des deltas de mutation (utile pour tests ciblés). |

**P6** : après la décision scénario (healthy/degraded/blocked), si `promotionMode !== 'blocked'`, applique les `portfolioAdjustments` avec clamps (`exposureMult` ∈ [0.8, 1.05], `maxNewAlloc` delta ∈ [-5,5], `admission` delta ∈ [-0.2, 0.2], mult final ∈ [1, 2]). Trace : `portfolio_governor.json` → `trendMemoryApply` + `strategy_portfolio.json` → `portfolioGovernor.trendMemoryApply`.

**P5** : après `buildPolicy`, si apply mutations autorisé, merge additif + `boundedWeights` / normalize. Trace : `mutation_policy.json` → `trendMemoryApply` + `adaptationInputs.trendMemoryReasons`.

**Rollback** : `TREND_MEMORY_APPLY=false` (ou unset).

**Ops** : avec apply désactivé, `policy:fallback_frequent` / `policyHealth.source=fallback` peuvent être **cohérents** avec la config — ce n’est pas par défaut une panne moteur. Voir `POLICY_FALLBACK_WHEN_TREND_APPLY_DISABLED.md`.

**Smoke** : `node engine/scripts/smokeTrendMemoryApply.js`

### 11.1 P7 Health Guard V1 (mutation policy uniquement)

Garde **optionnelle** : si `NEUROPILOT_ENABLE_P7_HEALTH_GUARD=true`, la lecture de `governance/p7_metrics.json` → `lastAlertReason` peut **skip** ou **atténuer** (×0.5) l’application des `mutationTypeWeightDeltas` trend dans `adaptMutationPolicy.js`, avec log stable `[P7 guard]`.

**Contrat complet** : `P7_HEALTH_GUARD_V1.md` · **Smoke** : `node engine/evolution/smokeP7HealthGuardMutationPolicy.js`

---

*Document aligné sur le cadrage produit P7 — mémoire stratégique multi-runs.*
