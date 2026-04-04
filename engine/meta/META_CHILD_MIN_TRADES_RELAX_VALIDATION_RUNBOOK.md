# Runbook — validation `NEUROPILOT_META_CHILD_MIN_TRADES_RELAX`

## Noms d’environnement (à ne pas confondre)

| Rôle | **Nom canonique (recommandé)** | Alias reconnus par le code |
|------|--------------------------------|-----------------------------|
| Activer relax | `NEUROPILOT_META_CHILD_MIN_TRADES_RELAX=1` | `META_RELAX_CHILD_MIN_TRADES=1` |
| Plancher ABS | `NEUROPILOT_META_CHILD_MIN_TRADES_ABS=10` | `META_MUTATION_CHILD_MIN_TRADES=10`, `META_MUTATION_CHILD_MIN_TRADES_ABSOLUTE` |
| Ratio parent | `NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO=1` | `META_USE_PARENT_RATIO_FOR_MUTATION_CHILD=1`, `META_MUTATION_CHILD_USE_PARENT_RATIO=1` |
| Valeur ratio | `NEUROPILOT_META_CHILD_MIN_TRADES_RATIO` | `META_MUTATION_CHILD_MIN_TRADES_RATIO` |

**Gouvernance — source de vérité** : en exploitation, utiliser **`NEUROPILOT_META_CHILD_MIN_TRADES_*`** comme interface **principale** (doc, runbooks, commandes ops). Les variables **`META_*`** du tableau ne sont que des **alias** de compatibilité / copier-coller erroné ; ne pas les promouvoir comme interface officielle.

---

## Blocs ops (copier-coller — **canonique uniquement**)

Prérequis : `cd neuropilot_trading_v2`, `export NEUROPILOT_DATA_ROOT=…`, puis batch/discovery **avant** meta si ton protocole l’exige.

### 1) Baseline

```bash
unset NEUROPILOT_META_CHILD_MIN_TRADES_RELAX
unset NEUROPILOT_META_CHILD_MIN_TRADES_ABS
unset NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO
unset NEUROPILOT_META_CHILD_MIN_TRADES_RATIO
node engine/meta/runMetaPipeline.js 30 12
```

### 2) Relax par défaut (ABS implicite = 12)

```bash
export NEUROPILOT_META_CHILD_MIN_TRADES_RELAX=1
unset NEUROPILOT_META_CHILD_MIN_TRADES_ABS
unset NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO
unset NEUROPILOT_META_CHILD_MIN_TRADES_RATIO
node engine/meta/runMetaPipeline.js 30 12
```

### 3) Seulement si nécessaire — ABS=10

```bash
export NEUROPILOT_META_CHILD_MIN_TRADES_RELAX=1
export NEUROPILOT_META_CHILD_MIN_TRADES_ABS=10
unset NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO
unset NEUROPILOT_META_CHILD_MIN_TRADES_RATIO
node engine/meta/runMetaPipeline.js 30 12
```

### 4) Cas extrême — ABS=8 (uniquement sur **preuve** nette, après 12 et 10)

```bash
export NEUROPILOT_META_CHILD_MIN_TRADES_RELAX=1
export NEUROPILOT_META_CHILD_MIN_TRADES_ABS=8
unset NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO
unset NEUROPILOT_META_CHILD_MIN_TRADES_RATIO
node engine/meta/runMetaPipeline.js 30 12
```

## Règle d’or

- **Une seule chose à la fois** : baseline → relax ABS défaut (12) → baisse d’`ABS` **seulement** si preuve.
- **Ne pas** activer `NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO` au **premier** essai relax (garder le plancher absolu seul, comme défaut code).
- **ABS=12 d’abord** ; passer à **10** si trop serré après lecture du rapport ; **8** seulement si 12 et 10 sont **prouvés** insuffisants (gouvernance / robustesse).

| Trades enfant (typique) | Avec ABS=12 |
|-------------------------|-------------|
| 0–1 | exclus ✓ |
| 8 | exclus |
| 15–17 | passent ✓ |

Pour inclure volontairement **8–10** trades : `NEUROPILOT_META_CHILD_MIN_TRADES_ABS=10` (puis 8 si mandaté).

---

## Lecture immédiate après §2 ou §3

```bash
cat "$NEUROPILOT_DATA_ROOT/discovery/meta_child_min_trades_filter.json" | jq .
jq '[.strategies[]?.setupId | select(test("^mut_"))] | length' \
  "$NEUROPILOT_DATA_ROOT/discovery/meta_ranking.json"
```

**Répartition par `source` dans le topN exporté** (reproductible, détection de drift) :

```bash
jq '[.strategies[] | .source] | group_by(.) | map({source: .[0], count: length})' \
  "$NEUROPILOT_DATA_ROOT/discovery/meta_ranking.json"
```

Exemple attendu (run typique mutation-dominant, `topN=20`) :

```json
[
  { "source": "champion_mutation", "count": 16 },
  { "source": "familyexp", "count": 2 },
  { "source": "grid", "count": 2 }
]
```

Si une entrée n’a pas `.source`, `jq` peut regrouper sous `null` — alors vérifier le schéma / version du pipeline.

**Lecture correcte de `meta_ranking.json`** : le fichier contient `totalStrategiesRanked` (ex. 4485) **et** `topN` (ex. 20). Le tableau **`.strategies[]` est uniquement l’export du top N** — pas l’ensemble des stratégies classées. Compter les `mut_` dans `.strategies[]`, c’est **mut_ dans le top exporté** (ex. 16/20), pas « seulement 16 mutations survivent sur tout le classement ».

**§1 attendu** : `relaxEnabled: false` ; `mutationChildrenKeptRelax: 0`.

---

## Cibler des `setupId` frais

```bash
SID=mut_bb6a82_close_b9364f
jq --arg id "$SID" '.strategies[]? | select(.setupId==$id)' \
  "$NEUROPILOT_DATA_ROOT/discovery/meta_ranking.json"
```

---

## Chaîne aval (si OK)

```bash
./engine/evolution/scripts/runEvolutionBaseline.sh
node engine/evolution/monitor.js latest
```

---

## À coller pour relecture externe

Après un run **relax** :

1. Contenu (ou `jq .`) de `discovery/meta_child_min_trades_filter.json`
2. Le **count** `mut_` dans `meta_ranking.json` (commande « Lecture immédiate »)
3. **3–5** `setupId` frais qui étaient absents **avant** et présents **après**

→ verdict **12 suffit / passer à 10 / autre**.

---

Voir aussi : `META_MUTATION_CHILD_MIN_TRADES.md`.

## Validation child min trades relax — baseline vs relax ABS=12

Baseline:
- relax disabled
- mutation children kept: 532
- mutation children dropped: 262
- mut_ strategies in exported `meta_ranking` **topN**: 16/20

Relax ABS=12:
- relax enabled
- mutationMinAbs: 12
- mutationUseParentRatio: false
- mutation children kept: 756
- mutation children dropped: 38
- mut_ strategies in exported `meta_ranking` **topN**: 16/20

Conclusion:
Baseline vs relax ABS=12 shows **no change** in the number of `mut_` strategies present in the **exported** `meta_ranking` **topN** (16/20 in both runs). **However**, relax ABS=12 materially improves mutation-child retention at the filter stage (kept 532 → 756, dropped 262 → 38). Since `champion_mutation` already dominates the exported topN, there is **no evidence** that lowering ABS to 10 is needed. **ABS=12 validated** ; ABS=10 **not justified** ; topic « child min trades relax » **closed** unless new data contradicts this.

