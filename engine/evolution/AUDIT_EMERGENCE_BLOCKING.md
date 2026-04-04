# Audit — blocage d’émergence (evolution / wildcard / scoring)

**Objectif** : trancher *où* le goulot se situe — **exploration**, **scoring plat**, **seuils**, ou **absence d’edge dans le search space** — **sans modifier** wildcard, mutation ni seuils avant conclusion.

**Principe** : même `NEUROPILOT_DATA_ROOT` que les runs qui ont produit le registry (voir `engine/governance/DATA_ROOT_ALIGNMENT.md`).

**Références** : `WILDCARD_PROMOTION_PASS.md`, `EVOLUTION_DELTA_OPERATOR.md`, `CHAMPION_SNAPSHOT_LEGEND.md`, `strategyEvolution.js` (`applyWildcardPromotionPass`, `buildRegistryEntries`, `buildEvolutionMetadata`).

---

## 0. Préambule (à ne pas sauter)

1. **Ne rien changer** dans le code ou les env de prod jusqu’au diagnostic écrit.
2. Travailler sur **un** `champion_registry.json` **figé** (copie horodatée si besoin) pour que les stats soient reproductibles.
3. Coller dans ta conclusion **le chemin du registry** et **`generatedAt` / `experimentId`** du `metadata` (pas de secrets).

---

## Axe 1 — Wildcard : vrais candidats ou filtre étanche ?

### Fichiers

| Fichier | Rôle |
|---------|------|
| `<dataRoot>/champion_setups/champion_registry.json` | `metadata.wildcard*`, `setups[]`, et tableaux racine `champions` / `validated` / `candidates` |
| `engine/evolution/WILDCARD_PROMOTION_PASS.md` | Signification de chaque `wildcardBlocked*` |
| `engine/evolution/strategyEvolution.js` | Logique `applyWildcardPromotionPass` (~L1270+) |

### Commandes (depuis `neuropilot_trading_v2/`)

```bash
export NEUROPILOT_DATA_ROOT="/chemin/vers/ton/data/root"   # aligné pipeline

node engine/evolution/validateWildcardPass.js
node engine/evolution/scripts/snapshotEvolutionMetrics.js
```

`validateWildcardPass` : compteurs wildcard + delta + cohérence registry.  
`snapshotEvolutionMetrics` : JSON compact (delta, wildcard partiel — compléter avec `jq` ci-dessous).

### Extraire tout le bloc `metadata` wildcard + effectifs

```bash
REG="$NEUROPILOT_DATA_ROOT/champion_setups/champion_registry.json"
jq '.metadata | {
  generatedAt, experimentId,
  avgChampionMomentum, avgValidatedMomentum, delta,
  effectiveMinDelta, effectiveMaxPromotions,
  wildcardPromotions, wildcardPromotionsOverChampion, wildcardCandidatesSeen,
  wildcardBlockedFamilyLimit, wildcardBlockedGroupStrongerChampion,
  wildcardBlockedLowDelta, wildcardBlockedTotalLimit, wildcardBlockedTieBreakLost,
  wildcardTieBreakComparisons, wildcardTieBreakAuditRejects,
  championsProtectedByDiversity, championsDemotedByDiversity
}' "$REG"
```

### Lecture attendue (checklist)

| Observation | Piste |
|-------------|--------|
| `wildcardCandidatesSeen` élevé, **tous** les `wildcardBlocked*` ≈ 0 sauf **`wildcardBlockedTieBreakLost`** élevé | Beaucoup de candidats en **zone d’égalité** / tie-break — voir `WILDCARD_PROMOTION_PASS` (égalité eps, audit `compareGroupMembers`). |
| `wildcardBlockedLowDelta` élevé | Seuil **`minDelta`** (vs `effectiveMinDelta`) trop dur **par rapport** à la dispersion réelle des momentums. |
| `wildcardBlockedGroupStrongerChampion` élevé | Candidats ne battent pas le champion du groupe (séparation ou exploration). |
| `wildcardBlockedFamilyLimit` / `wildcardBlockedTotalLimit` | Quotas, pas “qualité”. |
| `wildcardCandidatesSeen` ≈ 0 | Peu ou pas de candidats éligibles en entrée du pass — problème **amont** (statuts, `minNights`, pipeline). |

### Distribution & “near-miss” (manuel recommandé)

1. Lister **validated** avec `momentumMetaScore` fini, tri décroissant :
   ```bash
   jq '[.setups[] | select(.status=="validated") | {setupId, familyKey, momentumMetaScore, nightsInHistory}] | sort_by(-.momentumMetaScore)' "$REG"
   ```
2. Même chose pour **champions**.
3. Pour chaque **groupe de compétition** (`competitionGroupKey` = logique parent dans `strategyEvolution.js` : `parentSetupId` ou `setupId`), comparer **top validated** du groupe vs **champion** du groupe : écart de `momentumMetaScore` vs `EVOLUTION_WILDCARD_MIN_DELTA` / `effectiveMinDelta`.

**Questions à trancher** (à noter dans la conclusion) :

- Les candidats vus sont-ils **structurellement différents** (familles / groupes) ?
- Combien **ratent** la promotion **de peu** (juste sous `minDelta` ou tie-break perdu) ?
- Le blocage vient-il de la **qualité** des candidats ou des **règles** (compteurs `wildcardBlocked*` + doc) ?

---

## Axe 2 — Dispersion `meta_score` / `momentumMetaScore`

### Définition rappel

`momentumMetaScore` par setup : voir **`EVOLUTION_DELTA_OPERATOR.md`** (pondération nuits si ≥ 4, sinon moyenne simple).

### Commandes — listes triées

**Via `setups[]`** (statut explicite) :

```bash
jq '[.setups[] | select(.status=="champion") | .momentumMetaScore] | map(select(. != null)) | sort' "$REG"
jq '[.setups[] | select(.status=="validated") | .momentumMetaScore] | map(select(. != null)) | sort' "$REG"
```

**Équivalent via tableaux racine** — voir **Annexe — blocs `jq` Mac / racine** (souvent plus court).

### À calculer (hors repo : tableur ou 10 lignes de script)

Sur **champions** et **validated** séparément, puis **pool global** :

- min, max, moyenne, **médiane**
- **p10, p25, p75, p90** (ou IQR)
- **écart-type** ou IQR comme robuste

### Comparaisons utiles

- **Overlap** : part des validated avec `momentumMetaScore` **>** médiane des champions (ou top 10 validated vs bottom 10 champions).
- Si **distributions quasi identiques** et **étroites** : Δ négatif stable est **cohérent** ; le score a peu de **pouvoir séparateur**.

### Lecture attendue

| Pattern | Piste |
|---------|--------|
| Distributions très recouvrantes, IQR faible | Scoring **plat** ou population **homogène**. |
| Queue validated > champions claire | Sélection / wildcard / caps méritent examen (avec axe 1). |
| Tout compressé dans une bande étroite | Peu de marge pour `minDelta` — émergence **mathématiquement rare**. |

---

## Axe 3 — Seuils & sélection (règles, pas données)

### Fichiers

| Fichier | Rôle |
|---------|------|
| `WILDCARD_PROMOTION_PASS.md` | Table env **PART 4** |
| `engine/evolution/adaptive/deriveAdaptiveWildcardOpts.js` | `effectiveMinDelta`, `effectiveMaxPromotions` (si adaptive actif) |
| `strategyEvolution.js` | `capChampionDiversity`, promotion standard, `applyWildcardPromotionPass` |

### Commandes

```bash
jq '.metadata | { effectiveMinDelta, effectiveMaxPromotions, stagnationAvgDelta, stagnationIsStagnating }' "$REG"
# En parallèle : noter les env réels du run (EVOLUTION_WILDCARD_*, EVOLUTION_MAX_*) sans les logger dans un ticket public
```

### Checklist

- [ ] `minDelta` (effectif) **vs** dispersion observée (axe 2) : la marge est-elle réaliste ?
- [ ] `maxPromotions` / `wildcardMaxPerFamily` / cap global : bloquent-ils **après** que des candidats valides existent ?
- [ ] `championsProtectedByDiversity` / `championsDemotedByDiversity` : étau sur l’élite ?
- [ ] Si **tous** les `wildcardBlocked*` sont bas **et** peu de promotions : problème plus probable **scoring / exploration** (axes 1–2).

---

## Annexe — blocs `jq` (racine `champions` / `validated` / `candidates`)

Le registry expose en général **`champions`**, **`validated`**, **`candidates`** au même niveau que **`setups`**. Les requêtes ci-dessous les utilisent (équivalent filtrer `setups[]` par `status`).

`REG="$NEUROPILOT_DATA_ROOT/champion_setups/champion_registry.json"`

### 1) Dispersion champions

```bash
jq '[.champions[] | .momentumMetaScore | select(. != null)]
  | {count: length, min: min, max: max, avg: (add/length)}' "$REG"
```

### 2) Dispersion validated

```bash
jq '[.validated[] | .momentumMetaScore | select(. != null)]
  | {count: length, min: min, max: max, avg: (add/length)}' "$REG"
```

### 3) Top 10 validated

```bash
jq '[.validated[]
  | {setupId, familyKey, mutationType, score: .momentumMetaScore, statusReason}]
  | map(select(.score != null))
  | sort_by(.score) | reverse | .[0:10]' "$REG"
```

### 4) Bottom 10 champions

```bash
jq '[.champions[]
  | {setupId, familyKey, mutationType, score: .momentumMetaScore, statusReason}]
  | map(select(.score != null))
  | sort_by(.score) | .[0:10]' "$REG"
```

### 5) Near-miss vs moyenne des champions (`avgChampionMomentum`)

*(Écart à la **moyenne** des champions — proxy lecture ; le pass wildcard compare au **min** champion par groupe + `minDelta`.)*

```bash
jq '
  (.metadata.avgChampionMomentum) as $acm
  | [.validated[]
    | select(.momentumMetaScore != null)
    | {setupId, familyKey, mutationType, score: .momentumMetaScore, statusReason,
       delta_vs_avgChampion: (.momentumMetaScore - $acm)}]
  | sort_by(.delta_vs_avgChampion) | reverse | .[0:15]
' "$REG"
```

### 6) Diversité des top 30 validated (familles)

```bash
jq '[.validated[]
  | {familyKey, score: .momentumMetaScore}
  | select(.score != null)]
  | sort_by(.score) | reverse | .[0:30]
  | group_by(.familyKey)
  | map({familyKey: .[0].familyKey, count: length})
  | sort_by(.count) | reverse' "$REG"
```

### 7) Diversité des `candidates` (familles)

```bash
jq '[.candidates[]
  | {setupId, familyKey, mutationType, score: .momentumMetaScore, statusReason}
  | select(.score != null)]
  | group_by(.familyKey)
  | map({familyKey: .[0].familyKey, count: length})
  | sort_by(.count) | reverse' "$REG"
```

### 8) Top 15 candidates

```bash
jq '[.candidates[]
  | {setupId, familyKey, mutationType, score: .momentumMetaScore, statusReason}
  | select(.score != null)]
  | sort_by(.score) | reverse | .[0:15]' "$REG"
```

### 9) Chevauchement simple (meilleur validated vs pire champion)

```bash
jq '{
  best_validated: ([.validated[] | .momentumMetaScore | select(. != null)] | max),
  worst_champion: ([.champions[] | .momentumMetaScore | select(. != null)] | min),
  gap_bestValidated_minus_worstChampion:
    (([.validated[] | .momentumMetaScore | select(. != null)] | max) -
     ([.champions[] | .momentumMetaScore | select(. != null)] | min))
}' "$REG"
```

---

## Ordre de travail recommandé

1. **Top validated vs champions** (momentum, par groupe si possible) — 30 min.
2. **Dispersion globale** (min / max / quartiles / overlap) — si tout est serré, noter avant d’affiner wildcard.
3. **Near-miss wildcard** — `wildcardBlocked*` + écarts candidat / `minChampionMomentum` (logique dans code / doc).
4. **Diversité** des candidats (familles, groupes) — même `jq` sur `familyKey` / `parentSetupId`.

---

## Sortie attendue : une page, 4 blocs

### 1. Wildcard

- `wildcardCandidatesSeen`, chaque `wildcardBlocked*`, promotions réelles.
- Une phrase : candidats **variés ou monotones** ; **proches du seuil** ou non.

### 2. Meta-score

- Dispersion : **séparateur** ou **plat** ; overlap champions / validated en une ligne.

### 3. Sélection

- Seuils effectifs vs dispersion : **raisonnables** ou **trop durs**.

### 4. Verdict (un seul des quatre)

| # | Diagnostic |
|---|------------|
| **1** | **Exploration trop pauvre** — candidats trop semblables, peu de nouveauté structurelle. |
| **2** | **Scoring trop plat** — `momentumMetaScore` ne sépare pas assez ; Δ négatif cohérent. |
| **3** | **Seuils trop durs** — near-misses massifs, `wildcardBlocked*` explicites. |
| **4** | **Pas d’edge dans ce search space** — exploration + score + seuils plausibles, mais rien n’émerge. |

**Dernière ligne** : *« Aucun changement de paramètres recommandé avant : [répéter l’évidence manquante]. »* ou *« Hypothèse prioritaire : … ; validation proposée : … »* (encore sans mutation jusqu’à preuve).

---

## Ce que tu peux coller pour reprise d’analyse (agent / toi)

- Sortie de `validateWildcardPass.js` + `snapshotEvolutionMetrics.js`.
- Bloc `jq` metadata (wildcard + delta + effectifs).
- Tableau **min / médiane / max / IQR** champions vs validated.
- 5–10 lignes **top validated** (setupId, familyKey, momentumMetaScore) et **bottom champions** pour comparaison.

**Ne pas coller** : secrets, chemins home complets si sensibles, contenu `.env`.

---

## Exemple de verdict verrouillé (à adapter à ton registry)

*À copier dans tes notes d’audit une fois les sorties obtenues ; ne pas traiter comme contrat machine.*

> **Verdict provisoire verrouillé** : blocage d’émergence principalement dû à un **arbitrage final / tie-break dominant**, sur fond de **validated mieux scorés que les champions** (moyenne cohorte + gap max validated / min champion) et de **forte concentration par familles**.  
> L’hypothèse **minDelta trop dur** est peu soutenue si **`wildcardBlockedLowDelta = 0`**.  
> L’hypothèse **« pas d’edge » au sens fort** n’est pas retenue si des validated dépassent nettement le **pire** champion sur `momentumMetaScore`.

**Diagnostic parmi les 4 (exemple cohérent avec ce pattern)** : **(2)** scoring / séparation **mal convertie en promotion**, avec composante **tie-break** — pas **(3)** sur LowDelta ; **(1)** exploration secondaire si diversité faible ; **(4)** seulement si, après forensics, tout s’explique par tie-break **et** absence de marge réelle au niveau groupe.

**Toujours interdit sans preuve supplémentaire** : baisser `minDelta`, forcer wildcard, augmenter mutation, conclure « pas d’edge ».

Si, **après** forensics + logs `EVOLUTION_DEBUG_WILDCARD`, les lignes `WILDCARD_TIEBREAK_BLOCKED` montrent une **égalité stricte** candidat/champion sur les champs du payload → utiliser le **verdict final — clôture d’audit** (fin du document).

---

## Phase 2 — Forensics tie-break (Mac / `jq`)

**But** : voir *contre quel champion de groupe* les validated forts se comparent, et si `|Δ momentum| ≤ equalityEps` (zone d’égalité) explique le compteur **`wildcardBlockedTieBreakLost`**.

**Référence code** : `applyWildcardPromotionPass` dans `strategyEvolution.js` — après passage du filtre global `mom - minChampionMomentum >= minDelta`, pour chaque groupe avec champion : soit `mom > champMom + minDelta`, soit zone **`|deltaVsChampion| ≤ equalityEps`** (défaut **`1e-9`**, env `EVOLUTION_WILDCARD_EQUALITY_EPS`), puis `compareWildcardTieBreak` + `compareGroupMembers` (audit).

### A) Carte « validated → champion du même groupe »

`groupKey` aligné sur **`competitionGroupKey`** : `parentSetupId` si différent de `setupId`, sinon `setupId`.

Momentum aligné sur **`entryMomentumForCap`** : `momentumMetaScore` si fini, sinon `avgMetaScore`.

```bash
REG="$NEUROPILOT_DATA_ROOT/champion_setups/champion_registry.json"

jq '
  def group_key:
    if (.parentSetupId != null) and ((.parentSetupId | tostring) != (.setupId | tostring))
    then .parentSetupId | tostring
    else .setupId | tostring
    end;
  def em_num:
    if .momentumMetaScore != null then .momentumMetaScore | tonumber
    elif .avgMetaScore != null then .avgMetaScore | tonumber
    else null
    end;

  (reduce .champions[] as $c ({}; .[$c | group_key] = $c)) as $champByGroup
  | [.validated[]
    | em_num as $m | select($m != null)
    | . as $v
    | ($champByGroup[($v | group_key)]) as $ch
    | ($ch | em_num) as $cm
    | {
        setupId: $v.setupId,
        groupKey: ($v | group_key),
        statusReason: $v.statusReason,
        vMom: $m,
        championSetupId: (if $ch != null then $ch.setupId else null end),
        cMom: $cm,
        deltaVsChampion: (if $cm != null then ($m - $cm) else null end)
      }
    ]
  | sort_by(.deltaVsChampion // -1e9)
  | reverse
  | .[0:50]
' "$REG"
```

**Lecture** : lignes avec `deltaVsChampion` **très proche de 0** (≤ ~`1e-9` en valeur absolue si mêmes floats) → candidates **typiques** de la voie tie-break. Si `wildcardTieBreakComparisons` ≈ `wildcardCandidatesSeen`, cohérent.

### B) Même chose restreinte aux `statusReason` « structurants »

```bash
jq '
  def group_key: if (.parentSetupId != null) and ((.parentSetupId|tostring) != (.setupId|tostring))
    then .parentSetupId|tostring else .setupId|tostring end;
  def em_num: if .momentumMetaScore != null then .momentumMetaScore|tonumber
    elif .avgMetaScore != null then .avgMetaScore|tonumber else null end;
  (reduce .champions[] as $c ({}; .[$c|group_key] = $c)) as $cbg
  | [.validated[]
    | em_num as $m | select($m != null)
    | select(.statusReason // "" | test("replaced_|champion_diversity|mutation"; "i"))
    | . as $v | ($cbg[$v|group_key]) as $ch
    | ($ch | em_num) as $cm
    | {setupId: $v.setupId, groupKey: ($v|group_key), statusReason: $v.statusReason,
       vMom: $m, championSetupId: (if $ch then $ch.setupId else null end), cMom: $cm,
       deltaVsChampion: (if $cm != null then ($m - $cm) else null end)}]
' "$REG"
```

### C) Logs binaires du pass (run suivant, pas rétroactif)

Pour une trace **ligne par ligne** (champion, candidat, `tieBreakWinner`, `auditGroupRankPrefersCandidate`, `promoted`) :

```bash
export EVOLUTION_DEBUG_WILDCARD=1
# puis relancer le job qui écrit champion_registry.json (même env / data root)
```

Les lignes JSON émises sont **`WILDCARD_TIEBREAK_PROMOTED`** ou **`WILDCARD_TIEBREAK_BLOCKED`** (champ **`tieBreakWinner`** : `candidate` \| `champion` \| `tie`, plus **`auditGroupRankPrefersCandidate`**, **`promoted`**) — payload `tieBreakDebugPayload` dans `strategyEvolution.js`. *(Pas de tags nommés `WILDCARD_TIEBREAK_COMPARE` / `WINNER` dans le code actuel.)*

### D) Check rapide metadata

```bash
jq '.metadata | {
  wildcardCandidatesSeen, wildcardBlockedTieBreakLost, wildcardTieBreakComparisons,
  wildcardTieBreakAuditRejects, effectiveMinDelta
}' "$REG"
```

Si **`wildcardBlockedTieBreakLost` + promotions** ≈ **`wildcardTieBreakComparisons`** et **`wildcardTieBreakAuditRejects`** > 0, une partie des pertes vient du **rejet audit** (`compareGroupMembers`), pas seulement du tie-break qualitatif.

---

## Annexe C — Copier-coller Mac (variante `familyKey|parent` + metadata + debug)

### ⚠️ Sémantique de `group_key` (à lire avant A′/B′/C′)

Les blocs **A′, B′, C′** utilisent :

```text
group_key = (familyKey // "NA") + "|" + (parentSetupId // setupId)
```

Ce n’est **pas** **`competitionGroupKey`** du moteur (`strategyEvolution.js`), qui est uniquement :

- `parentSetupId` (string) si présent et ≠ `setupId`, sinon `setupId`.

| Objectif | Quel bloc utiliser |
|----------|-------------------|
| **Coller au wildcard / tie-break réel** | **Phase 2 §A–B** ( `group_key` = parent/setupId ) |
| **Diversité familles / lignée / lecture opérateur** | **A′/B′/C′** ci-dessous |

**Rappel** : le pass wildcard ne considère que le **meilleur validated par groupe moteur** (`compareGroupMembers`), pas chaque ligne des A′/B′.

### Préambule (une fois par session)

```bash
cd ~/neuro-pilot-ai/neuropilot_trading_v2   # adapter au chemin du clone
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
REG="$NEUROPILOT_DATA_ROOT/champion_setups/champion_registry.json"
```

### A′) Validated vs champion — **même clé `familyKey|parent`**

```bash
jq '
def em:
  if .momentumMetaScore != null then .momentumMetaScore
  elif .avgMetaScore != null then .avgMetaScore
  else null end;

def group_key:
  (.familyKey // "NA") + "|" + (.parentSetupId // .setupId | tostring);

[
  .validated[]
  | select(em != null)
  | . as $v
  | ($v | group_key) as $g
  | (
      [.champions[]
        | select(group_key == $g)
        | select(em != null)
      ][0]
    ) as $ch
  | ($v | em) as $m
  | (if $ch != null then ($ch | em) else null end) as $cm
  | {
      setupId: $v.setupId,
      groupKey: $g,
      statusReason: $v.statusReason,
      vScore: $m,
      championSetupId: (if $ch then $ch.setupId else null end),
      cScore: $cm,
      deltaVsChampion: (if $cm != null then ($m - $cm) else null end)
    }
]
| sort_by(.deltaVsChampion) | reverse | .[0:20]
' "$REG"
```

### B′) Même chose — `statusReason` filtré (`replaced` / `diversity` / `mutation`)

```bash
jq '
def em:
  if .momentumMetaScore != null then .momentumMetaScore
  elif .avgMetaScore != null then .avgMetaScore
  else null end;

def group_key:
  (.familyKey // "NA") + "|" + (.parentSetupId // .setupId | tostring);

[
  .validated[]
  | select(em != null)
  | select((.statusReason // "") | test("replaced|diversity|mutation"; "i"))
  | . as $v
  | ($v | group_key) as $g
  | (
      [.champions[]
        | select(group_key == $g)
        | select(em != null)
      ][0]
    ) as $ch
  | ($v | em) as $m
  | (if $ch != null then ($ch | em) else null end) as $cm
  | {
      setupId: $v.setupId,
      groupKey: $g,
      statusReason: $v.statusReason,
      vScore: $m,
      championSetupId: (if $ch then $ch.setupId else null end),
      cScore: $cm,
      deltaVsChampion: (if $cm != null then ($m - $cm) else null end)
    }
]
| sort_by(.deltaVsChampion) | reverse | .[0:20]
' "$REG"
```

### C′) Distribution des `deltaVsChampion` (même clé `familyKey|parent`)

```bash
jq '
def em:
  if .momentumMetaScore != null then .momentumMetaScore
  elif .avgMetaScore != null then .avgMetaScore
  else null end;

def group_key:
  (.familyKey // "NA") + "|" + (.parentSetupId // .setupId | tostring);

[
  .validated[]
  | select(em != null)
  | . as $v
  | ($v | group_key) as $g
  | (
      [.champions[]
        | select(group_key == $g)
        | select(em != null)
      ][0]
    ) as $ch
  | select($ch != null)
  | ($v | em) as $m
  | ($ch | em) as $cm
  | ($m - $cm)
]
| {
  count: length,
  min: min,
  max: max,
  avg: (add / length)
}
' "$REG"
```

### D′) Metadata wildcard / tie-break (bloc diagnostic étendu)

```bash
jq '{
  wildcardCandidatesSeen: .metadata.wildcardCandidatesSeen,
  wildcardPromotions: .metadata.wildcardPromotions,
  wildcardBlockedTieBreakLost: .metadata.wildcardBlockedTieBreakLost,
  wildcardTieBreakComparisons: .metadata.wildcardTieBreakComparisons,
  wildcardTieBreakAuditRejects: .metadata.wildcardTieBreakAuditRejects,
  wildcardBlockedLowDelta: .metadata.wildcardBlockedLowDelta,
  wildcardBlockedGroupStrongerChampion: .metadata.wildcardBlockedGroupStrongerChampion,
  wildcardBlockedFamilyLimit: .metadata.wildcardBlockedFamilyLimit,
  wildcardBlockedTotalLimit: .metadata.wildcardBlockedTotalLimit,
  effectiveMinDelta: .metadata.effectiveMinDelta,
  effectiveMaxPromotions: .metadata.effectiveMaxPromotions
}' "$REG"
```

### E′) Debug runtime tie-break (optionnel — **nouveau run**, sortie fichier)

Ne modifie pas le code ; active seulement des logs si `EVOLUTION_DEBUG_WILDCARD=1`.

```bash
cd ~/neuro-pilot-ai/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
export EVOLUTION_DEBUG_WILDCARD=1

./engine/evolution/scripts/runEvolutionBaseline.sh 2>&1 | tee debug_wildcard.log
grep -E 'WILDCARD|TIEBREAK' debug_wildcard.log | tail -n 50
```

**À coller pour clore le diagnostic** : sorties **A′, B′, C′, D′** (et extrait **E′** si lancé). Pour **verdict aligné moteur**, ajouter aussi **Phase 2 §A** (ou « best validated par `group_key` moteur »).

---

## Verdict final — clôture d’audit *(cas résolu : tie-break légitime, égalités strictes)*

*À utiliser **uniquement** lorsque la preuve runtime confirme que les candidats wildcard ne sont **pas** « meilleurs mais bloqués », mais **indiscernables** du champion de leur groupe sur les métriques du pass (momentum, avgMetaScore, nuits, mutation flag, etc.).*  
*Ne remplace pas les verdicts provisoires ; c’est une **clôture** après Phase 2 + **E′**.*

### Préconditions typiques (à cocher)

- [ ] `wildcardBlockedLowDelta` = 0, `wildcardBlockedGroupStrongerChampion` = 0, `wildcardBlockedFamilyLimit` = 0, `wildcardBlockedTotalLimit` = 0 (ou cohérent avec quotas).
- [ ] `wildcardCandidatesSeen` = `wildcardBlockedTieBreakLost` (ex. 15/15) et `wildcardPromotions` = 0.
- [ ] Sur les JSON `WILDCARD_TIEBREAK_BLOCKED` : `candidateMomentum` = `championMomentum`, `deltaVsChampion` = 0, champs parallèles (`avgMetaScore`, `nightsSurvived`, `nightsInHistory`, `candidateIsMutation` / `championIsMutation`) **égaux**, `tieBreakWinner` = `"champion"`, `auditGroupRankPrefersCandidate` = false.

### Texte prêt à coller (notes d’audit / ticket)

> **Verdict final verrouillé** : le blocage n’est **pas** une émergence réelle étouffée par le tie-break, mais un **tie-break légitime** entre **quasi-clones intra-groupe** : à chaque candidat wildcard considéré, les métriques du payload sont **strictement égales** à celles du champion du groupe ; le moteur n’arrive pas à un candidat **strictement meilleur** au sens du pass, seulement à des **égalités effectives**. Les compteurs metadata (`wildcardBlockedTieBreakLost` = `wildcardCandidatesSeen`, autres `wildcardBlocked*` nuls hors quotas) et les logs `WILDCARD_TIEBREAK_BLOCKED` le confirment.
>
> **Diagnostic parmi les 4** : **(1) exploration trop pauvre / redondante** (dominant) + **(2) séparation de score insuffisante intra-groupe** (secondaire). **Pas (3)** seuils trop durs (LowDelta absent). **Pas (4)** « absence d’edge » au sens où le système **refuserait** un candidat meilleur — les **top validated globaux** ne sont pas la même chose que le **meilleur validated par `competitionGroupKey`** vu par le wildcard.
>
> **Décision** : ne **pas** baisser `minDelta`, ne **pas** forcer wildcard, ne **pas** relâcher le tie-break sans autre preuve — cela promouvrait surtout des **équivalents**. **Leviers suivants** : amont — **exploration** (moins de clones effectifs vs champions), éventuellement **groupement** (`competitionGroupKey`) et **résolution du scoring** — **après** constat que l’exploration produit autre chose que des duplicatas métriques.
>
> **Synthèse** : *Le tie-break n’étouffe pas un edge réel ; il arbitre des égalités effectives. Le goulot est surtout une exploration qui produit des candidats trop proches des champions dans le groupe, avec une séparation insuffisante pour les départager.*

### Ce que ce verdict invalide explicitement

- L’interprétation « le moteur **voit** un setup **meilleur** et le **bloque** » **sans** preuve d’écart sur le **meilleur candidat du groupe** au moment du pass.
- Tout tweak **immédiat** de tie-break / `minDelta` fondé uniquement sur des **moyennes globales** validated vs champions.

**Suite chantier amont** : [EXPLORATION_REDUNDANCY_PLAN.md](./EXPLORATION_REDUNDANCY_PLAN.md)
