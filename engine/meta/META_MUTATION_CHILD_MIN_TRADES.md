# Meta — filtre min-trades **enfants** (`filterChildrenByMinTrades`)

**Gouvernance** : en exploitation, utiliser **`NEUROPILOT_META_CHILD_MIN_TRADES_*`** comme source de vérité (doc, ops). Les variables **`META_*`** ci-dessous sont des **alias** de compatibilité uniquement.

Runbook pas à pas : **`META_CHILD_MIN_TRADES_RELAX_VALIDATION_RUNBOOK.md`**.

## Comportement par défaut (**inchangé** vs historique)

Sans opt-in, **tout** enfant avec `parentSetupId` doit satisfaire :

`childTrades >= max(minTradesAbsolute, floor(parentTrades × minTradesRatio))`

(défauts : **30** et **0.3**, surchargeables via `opts` / logique appelant.)

## Opt-in — assouplissement **mutation** uniquement

| Variable (canonique) | Alias acceptés | Rôle |
|------------------------|----------------|------|
| **`NEUROPILOT_META_CHILD_MIN_TRADES_RELAX=1`** | `META_RELAX_CHILD_MIN_TRADES=1` | Active le relax **uniquement** mutation (`champion_mutation` ou `mut_*`). |
| `NEUROPILOT_META_CHILD_MIN_TRADES_ABS` | `META_MUTATION_CHILD_MIN_TRADES`, `META_MUTATION_CHILD_MIN_TRADES_ABSOLUTE` | Plancher absolu relax (défaut **12**). |
| `NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO=1` | `META_USE_PARENT_RATIO_FOR_MUTATION_CHILD=1`, `META_MUTATION_CHILD_USE_PARENT_RATIO=1` | Ajoute `max(abs, floor(parent × ratio))`. |
| `NEUROPILOT_META_CHILD_MIN_TRADES_RATIO` | `META_MUTATION_CHILD_MIN_TRADES_RATIO` | Ratio si use-parent actif (défaut **0.15**). |

Les alias évitent les erreurs de copier-coller ; **ne pas** les utiliser comme interface principale en doc ops.

**Sans** `NEUROPILOT_META_CHILD_MIN_TRADES_RELAX`, les `mut_*` passent par le **même** seuil strict que les autres enfants.

## Audit

Chaque run `runMetaPipeline` écrit :

- **`$NEUROPILOT_DATA_ROOT/discovery/meta_child_min_trades_filter.json`** — compteurs, histogramme trades des rejets, échantillon `setupId` (plafonné).
- **stdout** : une ligne `META_CHILD_MIN_TRADES_FILTER` (compteurs uniquement).

Ne pas logger les secrets ; la présence des vars d’env suffit pour le debug ops.

## Validation rapide

1. Sans flag : `relaxEnabled: false` dans le JSON ; mêmes stratégies qu’avant pour un même batch.
2. Avec `RELAX=1` : `mutationChildrenKeptRelax` > 0 si des `mut_*` ont `trades >= NEUROPILOT_META_CHILD_MIN_TRADES_ABS` (12 par défaut).
3. Vérifier `meta_ranking.json` : le tableau `.strategies[]` est le **top N exporté** (voir `topN` dans le JSON), pas les `totalStrategiesRanked` entrées. Chercher des `setupId` `mut_` auparavant absents **dans ce slice** (ou comparer rangs si besoin d’aller au-delà du fichier exporté).

Voir aussi : `META_CHILD_MIN_TRADES_VERDICT.md`, `auditChildMinTradesRejects.js`.
