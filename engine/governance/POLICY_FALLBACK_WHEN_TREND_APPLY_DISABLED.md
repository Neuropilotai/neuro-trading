# Policy fallback quand trend memory apply est désactivé

**Purpose** : éviter de classer à tort un **warning policy** comme défaut moteur quand la configuration **n’applique pas** trend memory.

---

## Comportement attendu (non anomalie par défaut)

Si **`TREND_MEMORY_APPLY`** n’est pas activé (`false` / absent) :

- le mini rapport expose typiquement `trendMemoryApply.envEnabled: false` (et souvent mutations / apply côté governor & policy à `false` ou non appliqués) — voir `generateGovernanceMiniReport.js` → bloc `trendMemoryApply` ;
- `run_trend_memory.json` peut rester **suggestif** (`appliedFromTrendMemory: false`, notes du type `trend_memory_apply=false`) ;
- les **Policy metrics** (`policy_metrics.json` / `policyHealth.source`) dérivent des lignes **`[Policy metrics]`** : avec apply désactivé, une part élevée ou totale de lignes en **`source=fallback`** est **cohérente** ;
- l’alerte consolidée **`policy:fallback_frequent`** peut donc apparaître **sans** indiquer à elle seule un moteur policy « cassé » — elle reflète souvent **le mode configuré**.

**Traduction opérateur** : le système calcule / archive de la mémoire de tendance mais est **configuré pour ne pas l’appliquer** aux poids / governor → rester en fallback n’est pas équivalent à « échec d’application ».

---

## Ce que ça ne prouve pas

- Aucun lien automatique avec **`childrenGenerated`** / **`exploration: off`** dans `evolutionSummary` — à vérifier via pipeline, `next_generation_report.json`, logs.
- **`mutation_policy.json`** peut ne pas exposer `source` / `trendMemoryApply` comme le dashboard : **`policyHealth.source`** est aligné sur l’agrégat **observabilité** (`policy_metrics` / events), pas nécessairement sur la forme brute du fichier policy.

---

## Quand s’inquiéter vraiment

- **`envEnabled: true`** (apply attendu) **et** persistance de `fallback_frequent` / pas d’apply sur governor & policy → investigation (logs, guard P7, erreurs pipeline).
- Régression après changement d’env sans changement de doc.

---

## Références

- `engine/scripts/generateGovernanceMiniReport.js` — `trendMemoryApply`
- `engine/governance/P7_RUN_TREND_MEMORY.md` — §11 P7.1 apply
- `engine/observability/policyMetrics.js` — `source`, `fallback_frequent`
- `engine/governance/OPS_DASHBOARD_TRIPLE_READ_CHECKLIST.md` — lecture multi-snapshots
