# Audit — Over-promotion bias (`meta_ranking.json`)

**Rôle** : quantifier si le **bonus promotion** (et le composite greedy) **désaligne** le slice exporté par rapport au **rang meta pré-greedy** et au **`meta_score`**, au point de constituer un **biais** — ou une **politique « promotion-first »** assumée.

**Règles** : uniquement champs présents dans le JSON ; **`export_slot`** = index dans `.strategies[]` + 1 ; **`pre_greedy_meta_rank`** = `.rank` ; le fichier = **topN exporté**, pas le classement complet.

---

## jq — tableau d’analyse (⚠️ `to_entries` obligatoire)

Le pattern suivant est **incorrect** : `[.strategies[] | { export_slot: (.key + 1), ... }]` — **`strategies[]` n’a pas de `.key`**.

**Correct** :

```bash
export RANKING_FILE="${1:-$NEUROPILOT_DATA_ROOT/discovery/meta_ranking.json}"

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
      stability: .value.stability,
      cross_asset_score: .value.cross_asset_score,
      timeframe_stability_score: .value.timeframe_stability_score
    }
]' "$RANKING_FILE"
```

---

## Script reproductible (métriques + corrélations + inversions)

```bash
node engine/meta/scripts/analyzePromotionBias.js /path/to/meta_ranking.json
# ou
RANKING_FILE=/path/to/meta_ranking.json node engine/meta/scripts/analyzePromotionBias.js
```

Sortie : JSON unique (corrélations de Pearson sur le slice, buckets promo, inversions vs ordre `pre_greedy_meta_rank`, distribution `source`, comparaison stabilité).

**Définition inversion (vs rang pré-greedy)** : paires `(i,j)` avec `i < j` en **ordre export** et `rank[i] > rank[j]` (un **meilleur** rang pré-greedy apparaît **après** un pire). C’est une mesure de **désalignement** avec le tri `computeMetaRanking`, **pas** un bug en soi si la politique est promotion-first.

---

## Checklist d’audit (pour LLM ou revue humaine)

1. **Dominance promo** : corrélation `decayed_promotion_bonus` × `export_slot` ; `meta_score` × `export_slot`.
2. **Inversions** : taux + pires cas (gros écart de `pre_greedy_meta_rank`).
3. **Segments** : HIGH / MID / NO promo — moyennes `meta_score`, `export_slot`, `parent_vs_child_score`, `validation_gate_factor`.
4. **Promo vs signal parent/enfant** : fort promo + faible `parent_vs_child_score` vs zéro promo + fort `parent_vs_child_score`.
5. **Source** : `group_by(.source)` — part vs `avg(meta_score)`.
6. **Stabilité** : comparer moyennes `stability` (ou cross/tf) tête promo vs bloc sans promo.
7. **Verdict** : LOW / MODERATE / HIGH (biais **par rapport à meta brut**), distinct de « est-ce souhaitable ».

---

## Exemple chiffré — run réel `totalStrategiesRanked=4485`, `topN=20`

*Source : `analyzePromotionBias.js` sur le fichier prod utilisé pendant l’audit (même révision que les `jq` parent_vs_child).*

### SECTION 1 — Faits clés

- Corrélation **`decayed_promotion_bonus` vs `export_slot`** ≈ **-0.88** → les **premiers slots** sont **très** associés au **bonus élevé**.
- Corrélation **`meta_score` vs `export_slot`** ≈ **+0.62** → les **`meta_score` plus élevés** tendent vers des **slots plus bas** dans ce slice (tête moins « meta pure »).
- **~62 %** des paires `(i,j)` en ordre export sont des **inversions** vs l’ordre strict par `pre_greedy_meta_rank` (118 / 190 paires).
- Bucket **HIGH promo (>0.15)** : **avg `meta_score` ≈ 0.479**, **avg `export_slot` ≈ 3.5** ; bucket **NO promo** : **avg `meta_score` ≈ 0.496**, **avg `export_slot` ≈ 14.5** → en tête, **meta moyen plus faible** mais **forte promo**.
- **6 / 6** stratégies **HIGH promo** ont **`parent_vs_child_score` < 0.01** ; le bloc **sans promo** avec **`parent_vs_child_score` > 4** est **8** stratégies (slots 9–14, 17, 20, etc.).
- Stabilité : moyenne **slots 1–4** ≈ **0.502** vs **sans promo, slots 9–14** ≈ **0.514** — écart **modeste** sur ce run.
- **champion_mutation** : **80 %** du top20, **avg `meta_score`** ≈ **0.490** ; **grid** **10 %**, **avg meta** ≈ **0.477** (sous-représentation grid avec meta plus bas dans ce slice).

### SECTION 2 — Tableaux (résumé)

| Métrique | Valeur |
|----------|--------|
| ρ(bonus, export_slot) | ≈ -0.88 |
| ρ(meta_score, export_slot) | ≈ +0.62 |
| Taux inversion vs `pre_greedy_meta_rank` | ≈ 62 % |
| HIGH promo : n / avg meta / avg slot | 6 / 0.479 / 3.5 |
| NO promo : n / avg meta / avg slot | 12 / 0.496 / 14.5 |

Pire inversion (écart de rang) : **slot 7** (`pre_greedy_meta_rank` **4371**, bonus **0.14**, meta **0.464**) **avant** **slot 12** (`rank` **2**, bonus **0**, meta **0.506**).

### SECTION 3 — Mécanisme

Le slice exporté reflète le **composite greedy** (promo + gate + diversité + tie-breaks), pas le **`meta_score` seul**. Les chiffres ci-dessus montrent une **forte cohérence « promotion-first »** en tête : **bonus élevé**, **rangs pré-greedy médiocres**, **`parent_vs_child` faible** ; le **milieu** du top20 concentre **sans promo** + **`meta_score` plus élevé** + **`parent_vs_child` élevé**.

### SECTION 4 — Verdict biais (par rapport au meta brut)

**HIGH** — au sens : le classement exporté est **fortement désaligné** de l’ordre **`pre_greedy_meta_rank` / `meta_score` pur** ; la promotion **explique** une grande partie de la **tête de slice**.

**Nuance produit** : ce niveau de biais peut être **volontaire** (discovery / evolution / leaders récents). Voir recommandation stratégique dans `META_RANKING_AUDIT_RUNBOOK.md` (**ne pas réduire le bonus sans trigger** : stagnation, churn champions, ou faux leaders avérés).

### SECTION 5 — Recommandations (si tu choisis de réduire le biais)

À n’appliquer **que** si la politique « meta-first » est décidée ou si un trigger métier est tiré :

- cap ou decay plus agressif sur **`decayed_promotion_bonus`** ;
- séparer **« vue exploration »** (promo forte) et **« vue allocation »** (meta + risque) dans deux exports ou deux passes ;
- contrainte : pas de slot **< K** sans **plancher `meta_score`** ou **`pre_greedy_meta_rank`** ;
- A/B documenté : même batch, comparer exports avant / après (voir `META_RANKING_AUDIT_RUNBOOK.md`).

---

## Protocole A/B minimal — poids effectif du bonus promo (**à lancer sur trigger**)

**Objectif** : comparer **le même univers d’entrée** sous trois armes, **sans** mélanger les batches.

**Prérequis** (non négociables) :

- Même répertoire **`batch_results`** (ou même liste de fichiers ; tracer un **hash / manifest** si possible).
- Mêmes args pipeline : `node engine/meta/runMetaPipeline.js <topN> <portfolioMax>` identiques.
- Mêmes variables d’env **sauf** le levier promo testé.
- **Aujourd’hui** : il n’existe **pas** encore de variable d’env documentée pour **scaler** `decayed_promotion_bonus` dans le composite greedy — les armes « bonus réduit / neutralisé » impliquent **un petit patch code** (ex. multiplier le terme promo dans `computePreDiversityComposite` / `computeFinalCompositeWithPenalties`) **ou** l’ajout d’un **`NEUROPILOT_*`** dédié lors du chantier. Noter le **commit / diff** pour chaque bras.

**Armes** :

| Bras | Description |
|------|-------------|
| **A — Baseline** | Code + env **prod** actuels. |
| **B — Bonus réduit** | Ex. multiplier le bonus injecté dans le composite par **~0.7** ou cap plus bas (hypothèse à calibrer sur le code réel). |
| **C — Bonus neutralisé** | Terme promo **0** dans le composite (conserver le reste : gate, diversité, tie-breaks). |

**Sorties à archiver par bras** (même chemin relatif sous `discovery/`) :

- `meta_ranking.json`
- `meta_child_min_trades_filter.json` (si comparatif filtre)
- `strategy_portfolio.json` (si l’impact allocation compte)

**Analyse** :

```bash
node engine/meta/scripts/analyzePromotionBias.js discovery/meta_ranking.json
```

Comparer : ρ(bonus, slot), ρ(meta, slot), taux d’inversions, buckets HIGH/NO promo, **ordre des `setupId`** (diff liste ou Jaccard top10).

**Interprétation** : un bras **meta-first** doit **rapprocher** l’ordre exporté du **`pre_greedy_meta_rank`** et **abaisser** ρ(meta_score, export_slot) si celui-ci était positif — **à valider** sur **métriques métier** (stabilité champions, OOS, pas seulement alignement statistique).

---

## Voir aussi

- `META_RANKING_AUDIT_RUNBOOK.md` — piège `export_slot` / `pre_greedy_meta_rank`, verdict final, fourche architecture.
- `META_CHILD_MIN_TRADES_RELAX_VALIDATION_RUNBOOK.md` — filtre enfant validé.
