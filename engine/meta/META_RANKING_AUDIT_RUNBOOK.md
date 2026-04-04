# Runbook — audit `meta_ranking.json` (signaux & ordre)

**Objectif** : comprendre pourquoi certaines stratégies (souvent `champion_mutation`) occupent le haut du **slice exporté**, et quels champs du JSON portent l’information — **sans supposer** des métriques absentes du schéma.

**Prérequis** :

```bash
export RANKING_FILE="${NEUROPILOT_DATA_ROOT:-.}/discovery/meta_ranking.json"
```

---

## ⚠️ Piège n°1 — `to_entries[].key + 1` n’est **pas** `.rank`

Dans le fichier écrit par `runMetaPipeline` :

- L’ordre de **`.strategies[]`** = ordre après **`sortRankedStrategies`** (greedy + pénalités famille), puis **`capRankedStrategiesByDiversity`** (caps par parent / clé diversité).  
  → **`export_slot = .key + 1`** = position dans **l’export** (ce que tu vois dans le fichier).

- Le champ **`.rank`** sur chaque objet vient de **`computeMetaRanking`** (`metaRankingEngine.js`) : tri initial par **`meta_score`** uniquement, **avant** le greedy rerank.  
  → **`pre_greedy_meta_rank`** serait un meilleur nom mental ; **il ne coïncide pas** avec l’index dans `.strategies[]`.

**Exemple réel** (workspace) : slot exporté **1** peut avoir `rank: 24` ; le meilleur `meta_score` global (`rank: 1`) peut n’apparaître qu’au **slot 4** — car le **composite greedy** (bonus promo, validation gate, profondeur, pénalités famille) réordonne.

Réf. code : `runMetaPipeline.js` — `computeMetaRanking` → `sortRankedStrategies` → `capRankedStrategiesByDiversity` → `writeMetaRanking(top, …)`.

---

## ⚠️ Piège n°2 — champs **non présents** dans le JSON actuel

Ne pas supposer : `avgMetaScore`, `momentum`, `nightsSurvived`, `profitFactor`, `sharpe`, `pnl` au top-level.

**Champs utiles typiques** (présents sur les artefacts générés par ce pipeline) :

| Signal / proxy | Clé JSON |
|----------------|----------|
| Score meta de base | `meta_score` |
| Performance centrale | `expectancy`, `trades`, `winRate`, `drawdown` |
| Stabilité / cross | `stability`, `cross_asset_score`, `timeframe_stability_score` |
| Promotion / champion | `decayed_promotion_bonus`, `promotion_breadth_score`, `effective_promotion_bonus`, … |
| Gate validation | `validation_gate_factor`, `validation_score`, `validationPassed` |
| Lignée / diversité (greedy) | `lineage_depth`, `family_diversity_key`, `family_diversity_rank`, `top_diversity_*` |
| Parent vs enfant | `parent_vs_child_score`, `beats_parent`, `parent_delta_*` |

Formule **meta_score** (composantes normalisées pondérées) : `engine/meta/metaRankingEngine.js` (`DEFAULT_WEIGHTS`).

Tri **greedy** : `computePreDiversityComposite` puis `computeFinalCompositeWithPenalties` dans `runMetaPipeline.js`.

---

## Verdict de phase — run réel (ex. `totalStrategiesRanked` = 4485, `topN` = 20)

✅ **Confirmé** sur un fichier de prod lu sur disque externe (`…/discovery/meta_ranking.json`) :

- L’ordre de **`.strategies[]`** ne reflète **pas** un tri par **`meta_score` seul**.
- Le haut du slice exporté est fortement influencé par **`decayed_promotion_bonus`**, **`validation_gate_factor`** et la logique **greedy / caps diversité**.
- Les meilleurs **`pre_greedy_meta_rank`** ne sont **pas** nécessairement aux premiers **`export_slot`** (ex. `pre_greedy_meta_rank` = 2 à **`export_slot`** = 12).

**Nomenclature jq** : utiliser systématiquement **`export_slot`** = `(.key + 1)` et **`pre_greedy_meta_rank`** = `.value.rank` (ne pas les confondre).

---

## Étape 1 — structure réelle

```bash
jq '.strategies[0]' "$RANKING_FILE"
jq '.strategies[0] | keys | sort' "$RANKING_FILE"
jq '{ count, topN, totalStrategiesRanked, generatedAt }' "$RANKING_FILE"
```

---

## Étape 2 — top exporté avec **bons** champs (+ deux « rangs »)

```bash
jq '[ .strategies
  | to_entries[]
  | {
      export_slot: (.key + 1),
      pre_greedy_meta_rank: .value.rank,
      setupId: .value.setupId,
      source: .value.source,
      trades: .value.trades,
      meta_score: .value.meta_score,
      expectancy: .value.expectancy,
      winRate: .value.winRate,
      stability: .value.stability,
      cross_asset_score: .value.cross_asset_score,
      timeframe_stability_score: .value.timeframe_stability_score,
      decayed_promotion_bonus: .value.decayed_promotion_bonus,
      promotion_breadth_score: .value.promotion_breadth_score,
      validation_gate_factor: .value.validation_gate_factor,
      parent_vs_child_score: .value.parent_vs_child_score,
      family_diversity_rank: .value.family_diversity_rank
    }
]' "$RANKING_FILE"
```

**Proxy « pré-greedy composite »** (approximation, **sans** pénalité famille dynamique) :

```bash
jq '[ .strategies[]
  | . as $s
  | ($s.meta_score * ($s.lineage_depth_penalty_factor // 1) * ($s.validation_gate_factor // 1)
     + ($s.decayed_promotion_bonus // 0) + ($s.promotion_breadth_score // 0)) as $pre
  | { setupId: $s.setupId, source: $s.source, pre_diversity_composite_approx: $pre }
]' "$RANKING_FILE"
```

---

## Étape 2b — parent vs enfant (tie-break dans `sortRankedStrategies`)

Le greedy trie d’abord sur un **composite** (voir code) ; à **égalité** (ou quasi), il utilise notamment **`parent_vs_child_score`**, puis **`expectancy`**, puis **`trades`**. Auditer ces champs sur le slice exporté permet de voir si le haut du fichier est plutôt **bonus promo** ou **avantage parent/enfant**.

**Tout le top exporté**

```bash
jq '[ .strategies
  | to_entries[]
  | {
      export_slot: (.key + 1),
      pre_greedy_meta_rank: .value.rank,
      setupId: .value.setupId,
      source: .value.source,
      meta_score: .value.meta_score,
      decayed_promotion_bonus: .value.decayed_promotion_bonus,
      validation_gate_factor: .value.validation_gate_factor,
      parent_vs_child_score: .value.parent_vs_child_score,
      beats_parent: .value.beats_parent,
      parent_delta_expectancy: .value.parent_delta_expectancy,
      parent_delta_meta_score: .value.parent_delta_meta_score,
      parent_delta_winRate: .value.parent_delta_winRate,
      parent_delta_trades_ratio: .value.parent_delta_trades_ratio
    }
]' "$RANKING_FILE"
```

**Non-`mut_*` seulement**

```bash
jq '[ .strategies
  | to_entries[]
  | select(((.value.setupId // "") | startswith("mut_")) | not)
  | {
      export_slot: (.key + 1),
      pre_greedy_meta_rank: .value.rank,
      setupId: .value.setupId,
      source: .value.source,
      meta_score: .value.meta_score,
      decayed_promotion_bonus: .value.decayed_promotion_bonus,
      validation_gate_factor: .value.validation_gate_factor,
      parent_vs_child_score: .value.parent_vs_child_score,
      beats_parent: .value.beats_parent
    }
]' "$RANKING_FILE"
```

**Lecture typique (run 4485 / 20)** : en tête de slice, **`parent_vs_child_score`** peut rester dans une **basse** plage (~1e‑3) alors que **`decayed_promotion_bonus`** est élevé ; les valeurs **~4–10+** apparaissent surtout sur le bloc **sans** bonus promo — là le tie-break parent/enfant devient **discriminant** entre stratégies au **`meta_score`** proche.

---

## Étape 3 — `mut_*` vs non-`mut_*` dans **l’export** (utiliser `export_slot`)

**Mutations**

```bash
jq '[ .strategies
  | to_entries[]
  | select((.value.setupId // "") | startswith("mut_"))
  | {
      export_slot: (.key + 1),
      pre_greedy_meta_rank: .value.rank,
      setupId: .value.setupId,
      source: .value.source,
      meta_score: .value.meta_score,
      decayed_promotion_bonus: .value.decayed_promotion_bonus,
      expectancy: .value.expectancy
    }
]' "$RANKING_FILE"
```

**Non-mutations**

```bash
jq '[ .strategies
  | to_entries[]
  | select(((.value.setupId // "") | startswith("mut_")) | not)
  | {
      export_slot: (.key + 1),
      pre_greedy_meta_rank: .value.rank,
      setupId: .value.setupId,
      source: .value.source,
      meta_score: .value.meta_score,
      decayed_promotion_bonus: .value.decayed_promotion_bonus,
      expectancy: .value.expectancy
    }
]' "$RANKING_FILE"
```

---

## Étape 4 — hypothèses « tri monotone » (sur l’**ordre fichier**)

Tester si un champ **décroît** quand `export_slot` augmente :

```bash
jq '[ .strategies[]
  | { setupId, source, meta_score, decayed_promotion_bonus, expectancy, trades }
]' "$RANKING_FILE"
```

Si `meta_score` n’est **pas** strictement décroissant sur `.strategies[]`, c’est **normal** : l’ordre final n’est **pas** le tri par `meta_score` seul.

---

## Étape 5 — répartition `source` (drift)

```bash
jq '[.strategies[] | .source] | group_by(.) | map({source: .[0], count: length})' "$RANKING_FILE"
```

---

## Étape 6 — sauvegarde locale (audit)

```bash
mkdir -p /tmp/meta_ranking_audit
jq '.strategies[0]' "$RANKING_FILE" > /tmp/meta_ranking_audit/sample_strategy.json
jq '.strategies[0] | keys | sort' "$RANKING_FILE" > /tmp/meta_ranking_audit/sample_strategy_keys.json
# … réutiliser les `jq` des étapes 2–3 pour écrire top20_full.json, etc.
```

---

## Lecture synthétique

**Run réel 4485 / topN=20** (fichier externe typique) :

- Slots **1–3** : `champion_mutation`, **`decayed_promotion_bonus`** = **0.22**, **`pre_greedy_meta_rank`** très loin (**1099**, **3168**, **3411**), **`parent_vs_child_score`** modéré (**~0.002–0.004**).
- Meilleur **`meta_score`** du slice : ex. **`mut_50c257_open_c90f9c`**, **`pre_greedy_meta_rank`** = **2**, mais **`export_slot`** = **12** ; **`parent_vs_child_score`** **~10.36** (fort).
- Non-mutations aux slots **5, 6, 8, 20** : cohérent avec **bonus promo** (5–6–8) et **bon meta brut sans bonus** (20) ; slot **20** a un **`parent_vs_child_score`** élevé (**~6.07**), comparable au peloton « meta pur ».

**Workspace** `data_workspace/discovery/meta_ranking.json` : autre volumétrie ; mêmes **pièges** `export_slot` vs `pre_greedy_meta_rank` et mêmes **jq**.

Voir aussi :

- `META_CHILD_MIN_TRADES_RELAX_VALIDATION_RUNBOOK.md` (lecture `topN` vs `totalStrategiesRanked`)
- `META_OVER_PROMOTION_BIAS_AUDIT.md` (biais promo vs meta brut, `jq` corrigé, script `scripts/analyzePromotionBias.js`)

---

## Verdict final — audit ranking (run réel 4485 / topN=20)

✅ **Constats** (preuves : `jq` + champs exportés) :

- **En tête de slice** (ex. slots **1–4**), le levier dominant est **`decayed_promotion_bonus`** (souvent avec **`validation_gate_factor`** et pénalités lignée dans le composite).
- **`parent_vs_child_score` n’explique pas** ces premières places : valeurs **faibles** là où le bonus promo est fort.
- **Milieu / bas du top exporté**, quand **`decayed_promotion_bonus` ≈ 0**, **`parent_vs_child_score`** redevient **discriminant** (souvent **ordre de grandeur >>** la tête).
- Le haut du fichier est donc piloté par le **composite greedy opérationnel**, **pas** par le **rang meta brut seul** ni par le **tie-break parent/enfant seul**.

**Logique pratique observée** (cohérente avec le code `sortRankedStrategies` dans `runMetaPipeline.js`) :

1. Bonus promo / decay (via `computePreDiversityComposite` / `computeFinalCompositeWithPenalties`)
2. Gate validation (`validation_gate_factor`)
3. Greedy + caps diversité
4. Tie-breaks **`parent_vs_child_score`**, **`expectancy`**, **`trades`** surtout quand les candidats se resserrent

→ Comportement **non incohérent** ; **fortement orienté « promotion first »** en tête de slice.

---

## Prochain chantier — décision d’architecture (pas un `jq`)

La lecture est **close**. La suite est un **choix produit / risque** :

- **Assumer « promotion first »** : le haut du top exporté reste volontairement **promo-driven** (leaders promus visibles tôt).
- **Rapprocher du rang meta brut** : auditer / **réduire le poids effectif** de **`decayed_promotion_bonus`** (et éventuellement **`promotion_breadth_score`**) dans le tri greedy — point d’entrée code : `computePreDiversityComposite`, `computeFinalCompositeWithPenalties`, `applyPromotionDecay`, `applyPromotionSaturationPenalty` dans `runMetaPipeline.js`.

**Prochaine commande utile** : pas un `jq`, mais une **décision documentée** + si besoin un **audit « poids promotion »** (scénarios avant/après sur le même batch, mêmes métriques d’export).
