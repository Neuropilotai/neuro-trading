# Verdict verrouillé — `filterChildrenByMinTrades` (meta funnel)

Document de **clôture d’audit** pour un cas observé sur pipeline réel + scripts d’audit associés.  
Ne remplace pas `runMetaPipeline.js` ; décrit **pourquoi** un setup peut être absent de `meta_ranking.json` **sans** être « mauvais » au sens ranking.

### Ligne de gouvernance (figée)

**`filterChildrenByMinTrades` n’est pas un garde-fou anecdotique : c’est un mécanisme structurant du funnel meta** qui écarte un **volume significatif** d’enfants (ex. nombreux `champion_mutation`), avec un **spectre de `tradesGapToPass`** allant du quasi-seuil (discutable en politique) au rejet largement sous-maturité (souvent légitime) ; **cela ne dit pas si la règle est « bonne » ou « mauvaise »**, seulement qu’elle est **active, matérielle**, et que toute modification de `minTradesAbsolute` / `minTradesRatio` est une **décision de gouvernance** après segmentation des rejets (buckets), pas un correctif d’exploration.

**Formulation courte (mandat seuils)** : `filterChildrenByMinTrades` agit comme un **entonnoir meta significatif** sur les enfants, y compris sur **`champion_mutation`**, avec une **distribution mixte** (quasi-seuils vs rejets structurellement lointains) ; **aucun changement de seuil n’est justifié sans mandat** tant que cette répartition n’est pas interprétée au regard de la **robustesse** recherchée.

### Annexe chiffrée prod — commande propre + artefact à coller

Le scrollback terminal **ne conserve souvent pas** le haut du JSON. **Ne pas** archiver la liste `rejectedChildrenNearestFirst` : le bon artefact est le **résumé seul** (`AUDIT_SUMMARY_ONLY=1`).

**Commandes (prod type)** :

```bash
cd ~/neuro-pilot-ai/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"

# Vue champion_mutation (sous-ensemble source + buckets dédiés)
AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation \
  node engine/meta/auditChildMinTradesRejects.js

# Vue globale (toutes sources) — mêmes `counts` / `rejectsGapByBucketAll` / `mutationType` total
AUDIT_SUMMARY_ONLY=1 node engine/meta/auditChildMinTradesRejects.js
```

**À coller dans le registre d’audit** (extrait du JSON émis ; `generatedAt` recommandé pour traçabilité) :

```json
{
  "generatedAt": "<ISO>",
  "counts": {},
  "rejectsGapByBucketAll": {},
  "mutationTypeCountsAmongRejectionsTotal": {},
  "rejectsGapByBucketMatchingSourceFilter": {},
  "mutationTypeCountsAmongRejectionsMatchingSourceFilter": {}
}
```

Lecture rapide : **`champion_mutation` surtout near-threshold ?** comparer `rejectsGapByBucketMatchingSourceFilter.buckets` ; **dominance par `mutationType`** : blocs `mutationTypeCounts*` ; **marginal vs structurant** : `counts.childrenRejectedByMinTradesTotal` vs taille du funnel (`strategiesTotal` / `withParentSetupId`).

---

### Snapshot verrouillé (prod — `NEUROPILOT_DATA_ROOT` externe, 2026-03-22)

Reproductible avec la commande `AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation` ci-dessus. **Hypothèse** : même définition de buckets (`GAP_NEAR_MAX=100`, `GAP_MID_MAX=1000`) et mêmes seuils meta (`MIN_TRADES_CHILD` / `MIN_TRADES_RATIO_CHILD` par défaut).

```json
{
  "generatedAt": "2026-03-22T10:44:49.189Z",
  "counts": {
    "strategiesTotal": 6322,
    "withParentSetupId": 5234,
    "childrenPassedFilter": 3078,
    "childrenRejectedByMinTradesTotal": 2156,
    "childrenRejectedMatchingSourceFilter": 199
  },
  "rejectsGapByBucketAll": {
    "scope": "allRejectedByMinTrades",
    "thresholds": {
      "gapNearMaxInclusive": 100,
      "gapMidMaxInclusive": 1000
    },
    "definition": {
      "nearThreshold": "tradesGapToPass <= 100",
      "intermediate": "100 < tradesGapToPass <= 1000",
      "far": "tradesGapToPass > 1000"
    },
    "buckets": {
      "nearThreshold": 34,
      "intermediate": 993,
      "far": 1129
    }
  },
  "mutationTypeCountsAmongRejectionsTotal": {
    "forced_family_shift": 411,
    "hybrid_family_shift": 180,
    "regime_flip": 244,
    "parameter_jitter": 1206,
    "session_flip": 111,
    "aggressive_profile": 2,
    "conservative_profile": 2
  },
  "rejectsGapByBucketMatchingSourceFilter": {
    "scope": "ONLY_SOURCE_SUBSTRING match",
    "thresholds": {
      "gapNearMaxInclusive": 100,
      "gapMidMaxInclusive": 1000
    },
    "definition": {
      "nearThreshold": "tradesGapToPass <= 100",
      "intermediate": "100 < tradesGapToPass <= 1000",
      "far": "tradesGapToPass > 1000"
    },
    "buckets": {
      "nearThreshold": 21,
      "intermediate": 79,
      "far": 99
    }
  },
  "mutationTypeCountsAmongRejectionsMatchingSourceFilter": {
    "parameter_jitter": 47,
    "forced_family_shift": 82,
    "session_flip": 52,
    "regime_flip": 18
  }
}
```

**Lecture synthétique (ce snapshot)** :

- **Funnel** : 5234 enfants avec `parentSetupId` ; **2156** rejetés min-trades (**~41 %** des enfants) → **politique structurante**, pas bruit anecdotique.
- **`champion_mutation`** : **199** rejets sur ces 2156 ; buckets **21 / 79 / 99** (near / intermediate / far) → **pas** « surtout quasi-seuil » : **~50 % far**, **~40 % intermediate**, **~11 % near** sur ce sous-ensemble.
- **Tous rejets** : **34 / 993 / 1129** → masse concentrée en **intermediate + far** (majorité du volume global).
- **`mutationType` (tous rejets)** : **`parameter_jitter` domine** (1206) ; puis `forced_family_shift`, `regime_flip`, `hybrid_family_shift`, `session_flip`.
- **`champion_mutation` seul** : mix **`forced_family_shift` (82)**, **`session_flip` (52)**, **`parameter_jitter` (47)**, **`regime_flip` (18)** — aligné avec l’hypothèse « mutations qui diluent les trades vs parents très denses ».

**Conclusion sur ce snapshot** : le débat de politique **ne se limite pas** aux cas **−15 trades** ; une part **matérielle** des rejets `champion_mutation` est **loin du seuil** (`far`), ce qui milite pour **ne pas** assouplir les seuils **sans mandat** et **sans** critère de robustesse explicite.

**Ce que ce snapshot affaiblit** :

- Baisser **`minTradesAbsolute` / `minTradesRatio`** « maintenant » sans mandat explicite.
- L’idée que le problème serait surtout **« manque de chance à quelques trades près »** (la masse est **intermediate + far** ; sur `champion_mutation`, **~50 % far**).
- Traiter **`filterChildrenByMinTrades`** comme un **micro-frottement** : sur ce run, **~41 %** des enfants avec parent sont coupés **avant** ranking meta (**2156 / 5234**).

**Diagnostic amont clôturé (lien chaîne)** : `existingSetupIds` / salt, ingestion batch/meta prouvée, cas **B2b** tracé (`mut_6c8e2f_mid_df182a`), agrégé montrant que **B2b est large**, pas isolé.

---

## Règle (code)

Dans `engine/meta/runMetaPipeline.js`, **`filterChildrenByMinTrades`** :

- Ne s’applique qu’aux stratégies avec **`parentSetupId`**.
- Seuil effectif :  
  **`minTradesRequired = max(minTradesAbsolute, floor(parentTrades * minTradesRatio))`**  
  si le parent est connu dans le même univers `strategies` ; sinon **`minTradesAbsolute`** seul.
- Défauts alignés pipeline : `minTradesAbsolute = 30`, `minTradesRatio = 0.3` (surchargeables via opts / env selon appelant).

**Conséquence** : un enfant peut être **agrégé et valide** dans `buildStrategiesForMeta` mais **retiré avant `computeMetaRanking`** — il n’apparaît ni dans le classement interne, ni dans le **top N** écrit dans `discovery/meta_ranking.json`.

---

## Cas verrouillé (exemple)

### `mut_6c8e2f_mid_df182a` — **B2b**

| Étape | Statut |
|--------|--------|
| `groupResultsBySetup` | ✅ présent (ex. 34 lignes / plusieurs `strategy_batch_results_*`) |
| `buildStrategiesForMeta` | ✅ construit, `validationPassed` peut être true |
| `filterChildrenByMinTrades` | ❌ **rejet** |
| Données types | `parentTrades = 1931`, `childTrades = 564`, `minTradesRequired = max(30, floor(1931×0.3)) = 579` → **564 < 579** |

**Interprétation** : ce n’est **pas** une coupure par top-N meta ni un oubli d’ingestion batch ; c’est la **politique enfant/parent** sur le **nombre de trades** agrégés.

### `mut_1438d3_mid_5d17b6` — **B0**

- `inGroupResultsBySetup = false` → absent de l’agrégat batch (scan / top-K / pas de lignes valides pour cet ID dans les fichiers lus). **Pas de funnel meta** pour cet ID sur ce snapshot.

---

## Ce que ce verdict invalide (pour `mut_6c8e2f_mid_df182a`)

- « Le meta ignore les nouveaux JSON » — **non**, il construit la stratégie puis la filtre avant ranking.
- « Le top 30 seul est en cause » — **non**, le setup **n’atteint pas** `computeMetaRanking`.
- « Wildcard / tie-break » — **hors sujet** à ce stade.

---

## Outils d’audit (read-only)

| Script | Rôle |
|--------|------|
| `engine/meta/auditMetaSetupFunnel.js` | Une ou plusieurs `setupId` : position dans le funnel jusqu’au **top N** écrit dans le meta. |
| `engine/meta/auditChildMinTradesRejects.js` | **Vue d’ensemble** : rejets min-trades, tri **`tradesGapToPass`** croissant. En tête de JSON : **`counts`**, **`rejectsGapByBucketAll`** (segmentation), et si `ONLY_SOURCE_SUBSTRING` : **`rejectsGapByBucketMatchingSourceFilter`**. Compteurs `mutationType` : `mutationTypeCountsAmongRejectionsTotal` (+ filtre optionnel). |
| `engine/meta/auditChildMinTradesByParent.js` | **Parents / familles** : parmi les enfants rejetés par `filterChildrenByMinTrades`, agrégation par **`parentSetupId`** (`topParentsByPenalty` : `gapBuckets` + `mutationTypeCounts`). Rollup optionnel **`topFamilyPrefixesByFar`** (préfixe sur N segments `_`, défaut `FAMILY_PREFIX_N=2`). |

**Buckets (défaut)** — `tradesGapToPass = minTradesRequired − childTrades` :

| Clé JSON | Condition |
|----------|-----------|
| `nearThreshold` | `gap ≤ 100` (`GAP_NEAR_MAX`) |
| `intermediate` | `100 < gap ≤ 1000` (`GAP_MID_MAX`) |
| `far` | `gap > 1000` |

Lecture : **near** = zone où un ajustement de politique pourrait être discuté ; **far** = rejet typiquement cohérent avec « enfant pas assez représenté» vs parent très trade-dense (seuil mécanique `0.3 × parentTrades`).

Exemples :

```bash
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
node engine/meta/auditMetaSetupFunnel.js mut_6c8e2f_mid_df182a
node engine/meta/auditChildMinTradesRejects.js
ONLY_SOURCE_SUBSTRING=champion_mutation node engine/meta/auditChildMinTradesRejects.js
AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation node engine/meta/auditChildMinTradesRejects.js
# Seuils de buckets (optionnel) :
# GAP_NEAR_MAX=100 GAP_MID_MAX=1000 node engine/meta/auditChildMinTradesRejects.js
```

---

## Pistes de décision (hors scope code ici)

1. **Discipline** : ne pas changer les seuils ; laisser les cycles suivants faire monter `childTrades`.
2. **Chantier politique** : lire **`rejectsGapByBucketAll`** (et le bloc *matching* si filtre source) pour séparer quasi-seuils vs rejets structurellement lointains ; décider ensuite si l’on touche à `minTradesAbsolute` / `minTradesRatio` (hors scope implémentation sans mandat).

---

## Prochain chantier — parents « thinly traded » (amont meta)

**Objectif** : identifier **quels parents** (et grossièrement **quelles familles** par préfixe d’id) concentrent les rejets **loin du seuil** (`far`), et **quel `mutationType`** sous quel parent **dilue** le volume — pour décider si l’exploration doit changer **en amont** (pas wildcard / tie-break).

**Commandes (même `NEUROPILOT_DATA_ROOT` que l’audit gouvernance)** :

```bash
cd ~/neuro-pilot-ai/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"

# Top 50 parents par défaut : tri prioritaire = plus de rejets "far", puis volume total
AUDIT_SUMMARY_ONLY=1 node engine/meta/auditChildMinTradesByParent.js

# Même chose, uniquement enfants dont la source matche champion_mutation
AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation \
  node engine/meta/auditChildMinTradesByParent.js

# Trier d’abord par nombre total de rejets (puis far)
SORT_BY=rejects_first AUDIT_SUMMARY_ONLY=1 node engine/meta/auditChildMinTradesByParent.js

# Désactiver le rollup par préfixe (si bruité)
FAMILY_PREFIX_N=0 AUDIT_SUMMARY_ONLY=1 node engine/meta/auditChildMinTradesByParent.js

# Plus de lignes (ex. top 100 parents / familles)
TOP_PARENTS=100 AUDIT_SUMMARY_ONLY=1 node engine/meta/auditChildMinTradesByParent.js
```

**Champs utiles dans la sortie** : `topParentsByPenalty[]` → `parentTrades`, `rejectedChildren`, `gapBuckets`, `mutationTypeCounts` ; `topFamilyPrefixesByFar[]` → `distinctParentCount`, mêmes buckets.

**Implémentation amont (patch minimal sous flag)** : après lecture des tops parents, activer une politique JSON parent-aware — voir [`../evolution/MUTATION_HOTSPOT_POLICY.md`](../evolution/MUTATION_HOTSPOT_POLICY.md) et `config/mutation_hotspot_policy.example.json` (`NEUROPILOT_MUTATION_HOTSPOT_POLICY=1`).

---

## Référence code

- `filterChildrenByMinTrades` — `engine/meta/runMetaPipeline.js`
- Chaîne complète — `runMetaPipeline()` (même fichier)
- Agrégation parent — `engine/meta/auditChildMinTradesByParent.js`

---

*À lier avec : `EXPLORATION_REDUNDANCY_PLAN.md` (amont exploration) ; ce document couvre l’**entonnoir meta enfant/parent**.*
