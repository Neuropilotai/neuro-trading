# P7 Health Guard — contrat V1

**Statut** : V1 implémentée (première adaptation bornée sur la mutation policy).  
**Objectif** : quand la qualité P7 signalée dans les métriques est dégradée, **ne pas appliquer** ou **atténuer** l’application des deltas trend sur les poids de mutation (P5), sans toucher au reste du moteur.

---

## Flag

| Variable | Valeur |
|----------|--------|
| `NEUROPILOT_ENABLE_P7_HEALTH_GUARD` | `true` pour activer la garde ; **absent / autre valeur** → garde **désactivée** (comportement strictement inchangé vs avant V1). |

---

## Signal (unique)

| Source | Champ |
|--------|--------|
| `<dataRoot>/governance/p7_metrics.json` | `lastAlertReason` |

Produit par `engine/observability/p7Metrics.js` (`refreshP7Metrics`). Aligné sur le contrat `P7_METRICS_SCHEMA.md` (raisons d’alerte listées là).

---

## Mapping figé V1 (warning / critical)

Toute autre valeur de `lastAlertReason` (y compris absente / vide) est traitée comme **healthy / unknown** → action **normal**.

### Warning → atténuation

- `low_report_coverage`
- `empty_window`
- `no_p7_metrics_events`

### Critical → skip

- `apply_zero_unexpected`
- `parse_errors`

---

## Actions (levier unique : trend sur mutation policy)

Implémentation : `engine/evolution/adaptMutationPolicy.js` (au plus près de l’appel à `applyTrendMemoryToMutationWeights`).  
Détail technique : `engine/governance/trendMemoryApply.js` accepte `deltaMultiplier` sur les `mutationTypeWeightDeltas`.

| État (d’après mapping ci-dessus) | Comportement |
|----------------------------------|--------------|
| **healthy / unknown** | **normal** — même sortie qu’avec la garde désactivée (mêmes poids trend que sans guard). |
| **warning** | **attenuate** — multiplicateur déterministe **`0.5`** sur chaque delta trend mutation avant merge + normalize. |
| **critical** | **skip** — pas d’application trend sur les poids ; `trendMemoryApply.appliedFromTrendMemory=false` avec motif `p7_guard_skip:…`. |

**Hors périmètre V1** : le governor (P6) et les autres applis trend ne sont pas modifiés par cette garde.

---

## Observabilité

Une ligne **stable** et **grep-friendly** est émise sur **console** **uniquement** lorsque la garde est **activée** :

```
[P7 guard] enabled=true p7Alert=<reason|none> action=<normal|attenuate|skip> factor=<0.000|0.500|1.000>
```

- `factor` reflète le multiplicateur appliqué aux deltas trend mutation (`0` en skip critique, `0.5` en warning, `1` en normal).

**Persistance (observabilité dashboard)** : la même ligne est appendée sous `governance/p7_guard_events.log` (préfixe horodatage ISO), comme pour P5/P7 metrics. `engine/observability/p7GuardMetrics.js` agrège → `governance/p7_guard_metrics.json` ; le dashboard P8 affiche un bandeau **P7 guard** sous l’alert digest. Contrat : `engine/observability/P7_GUARD_METRICS_SCHEMA.md`. Smoke : `node engine/observability/smokeP7GuardMetrics.js`.

---

## Compatibilité / non-régression

- **`NEUROPILOT_ENABLE_P7_HEALTH_GUARD` absent ou ≠ `true`** : comportement **strictement inchangé** par rapport à l’implémentation pré-guard (aucune lecture P7 obligatoire pour la décision trend ; **pas** de log `[P7 guard]` ni d’append `p7_guard_events.log`).

---

## Preuve (smoke)

```bash
node engine/evolution/smokeP7HealthGuardMutationPolicy.js
```

Couvre : healthy/unknown + warning (atténuation mesurable) + critical (skip) + non-régression flag off.

**Agrégat guard (usage réel)** :

```bash
node engine/observability/smokeP7GuardMetrics.js
```

---

## Versioning

- **V1** : mapping et `deltaMultiplier=0.5` figés dans le code ; toute évolution (nouvelles raisons, autre facteur, périmètre P6) → documenter **V2** et smoke associé.
