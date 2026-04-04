# Wildcard Promotion Pass — Design & Specification

**Role:** Principal Evolutionary Systems Architect / Trading Research Auditor / Production Reliability Engineer  
**Scope:** Patch canonique après `capChampionDiversity`, avant `validateRegistryConsistency`.  
**Objectif:** Réduire la sous-promotion (avgChampionMomentum < avgValidatedMomentum) sans casser diversité ni invariants.

---

## PART 1 — Diagnostic

**Pourquoi le système actuel garde des validated trop forts hors des champions**

1. **Un seul champion par groupe de compétition**  
   `normalizeChampionPerGroup` choisit le meilleur par `competitionGroupKey`. Les autres membres du groupe (validated ou candidate) restent non-champions même si leur momentum est proche ou supérieur au pire champion global.

2. **Cap diversité par famille**  
   `capChampionDiversity` limite les champions par `familyKey` / `parentFamilyId`. Un validated fort dans une famille déjà au plafond ne peut pas devenir champion sans qu’un champion de la même famille soit dégradé.

3. **Protection diversité limitée à 1 par famille**  
   La règle "champion_diversity_protected" ne s’applique qu’au premier overflow par famille (et seulement si au-dessus du plancher global/famille). Les validated forts qui arrivent après en ordre de traitement restent validated.

4. **Wildcard actuel ne cible que les groupes vides**  
   L’implémentation actuelle ne promeut que des validated dont le groupe n’a **aucun** champion. Les groupes qui ont déjà un champion (éventuellement plus faible qu’un validated du même groupe) ne sont pas traités → pas de remplacement contrôlé.

5. **Pas de seuil minimal de delta ni de nights**  
   Un validated à peine au-dessus du min champion peut être promu sans garantie de stabilité (peu de nuits) ou de marge claire (delta trop faible).

**Conséquence:** Des validated avec momentum > avgChampionMomentum (et parfois > minChampionMomentum + marge) restent bloqués, d’où delta négatif persistant.

---

## PART 2 — Design exact

### `applyWildcardPromotionPass(entries, opts)`

**Inputs**
- `entries`: `Array<object>` — sortie de `capChampionDiversity` (champions + validated + candidates), inchangée côté lineage (pas de modification de `parentSetupId` / `mutationType`).
- `opts`: `object` optionnel — override des env (voir PART 4).

**Outputs**
- `{ entries: Array<object>, wildcardStats: object }`  
  - `entries`: même tableau avec éventuellement des validated promus en champion et/ou des champions dégradés en validated (remplacement).  
  - `wildcardStats`: comptes et moyennes pour métadonnées (promotions, blocages par motif, momentum moyen des promus, etc.).

**Ordre d’exécution**

1. **Enable** — Si `EVOLUTION_WILDCARD_ENABLE` ≠ 1, retourner `{ entries: arr, wildcardStats: zeros }`.
2. **Référence champion** — À partir des `entries` avec `status === 'champion'`, calculer `championMomenta[]`, `minChampionMomentum`, et par groupe le champion actuel (pour Cas 2).
3. **Shortlist** — Parmi les `status === 'validated'` :  
   - `liveStatus !== 'extinct'` (si champ présent).  
   - `nightsInHistory >= minNights`.  
   - `entryMomentum` = momentumMetaScore ou avgMetaScore (fini).  
   - `deltaVsMinChampion = entryMomentum - minChampionMomentum >= minDelta`.  
   - Optionnel : exclure ou inclure selon `statusReason === 'champion_diversity_capped'` (voir `EVOLUTION_WILDCARD_ALLOW_DIVERSITY_CAPPED`).  
   Pour chaque groupe : garder au plus le **meilleur** validated (tri `compareGroupMembers`).
4. **Cas A — Groupe sans champion**  
   Candidat = meilleur validated du groupe si éligible. Raison prévue : `wildcard_promoted`.
5. **Cas B — Groupe avec champion**  
   Si meilleur validated du groupe a `entryMomentum > championMomentum + minDelta`, candidat au **remplacement**. Raison prévue : `wildcard_promoted_over_champion` (promu), champion dégradé reçoit `replaced_by_wildcard`.
6. **Tri global**  
   Tous les candidats (A + B) triés par :  
   - `entryMomentum` desc  
   - `deltaVsMinChampion` desc  
   - `nightsSurvived` desc  
   - mutation gagne l’égalité vs base  
   - `setupId` localeCompare pour déterminisme.
7. **Application sous contraintes**  
   - Quota global : au plus `maxPromotions`.  
   - Quota wildcard par famille : au plus `wildcardMaxPerFamily` promotions wildcard par `familyKey`.  
   - Pour chaque promotion : soit ajout (groupe vide), soit remplacement (dégrader l’ancien champion).  
   - Incrémenter les compteurs de blocage (famille, total, delta trop bas, champion déjà plus fort) quand un candidat est refusé pour l’une de ces raisons.
8. **Retour**  
   `entries` mis à jour + `wildcardStats` (promotions, promotions over champion, candidats vus, blocages par motif, avgWildcardPromotedMomentum, etc.).

**Invariants garantis**
- Au plus un champion par `competitionGroupKey`.
- Aucune modification de `parentSetupId` / `mutationType` / lineage.
- Statuts dans { candidate, validated, champion }.
- Déterminisme : même `entries` + opts → même sortie.

---

## PART 3 — Patch code-level

### 3.1 `strategyEvolution.js` — fonction principale

- **Renommer / généraliser** `applyWildcardPromotion` → `applyWildcardPromotionPass`.
- **Signature** : `function applyWildcardPromotionPass(entries, opts = {})` → `{ entries, wildcardStats }`.
- **Enable** : si `opts.enable ?? process.env.EVOLUTION_WILDCARD_ENABLE !== '1'`, retourner `{ entries: arr, wildcardStats: makeZerosWildcardStats() }`.
- **Params** : lire depuis opts / env :  
  `maxPromotions`, `minNights`, `minDelta`, `wildcardMaxPerFamily`, `allowDiversityCapped`, `requireValidatedStatus`, `maxPerFamilyKey`.
- **Référence** : champions actuels → `minChampionMomentum`, `byGroup[gk].champion` (le champion du groupe s’il existe).
- **Shortlist** :  
  - Grouper par `competitionGroupKey`.  
  - Pour chaque groupe : meilleur validated (tri `compareGroupMembers`).  
  - Filtrer : status === 'validated', liveStatus !== 'extinct', nightsInHistory >= minNights, momentum fini, delta >= minDelta.  
  - Si !allowDiversityCapped et statusReason === 'champion_diversity_capped', exclure.  
  - Cas A : groupe sans champion → candidat `wildcard_promoted`.  
  - Cas B : groupe avec champion, validated.momentum > champion.momentum + minDelta → candidat `wildcard_promoted_over_champion`.
- **Tri** : comme en PART 2 (momentum, delta, nightsSurvived, mutation, setupId).
- **Boucle** : pour chaque candidat dans l’ordre, si quota global et quota famille OK :  
  - Cas A : promouvoir validated → champion, `statusReason: 'wildcard_promoted'`.  
  - Cas B : promouvoir validated → champion, `statusReason: 'wildcard_promoted_over_champion'` ; dégrader champion actuel → validated, `statusReason: 'replaced_by_wildcard'`.  
  Sinon incrémenter le blocage approprié dans `wildcardStats`.
- **Retour** : `{ entries: arr modifié, wildcardStats }`.

### 3.2 Helper `entryMomentumForCap(e)`

- Déjà présent ; réutiliser pour momentum (momentumMetaScore puis avgMetaScore).

### 3.3 `buildEvolutionMetadata(entries, consistency, wildcardStats)`

- Troisième argument optionnel `wildcardStats`.
- Si présent, ajouter dans l’objet retourné :  
  `wildcardPromotions`, `wildcardPromotionsOverChampion`, `wildcardCandidatesSeen`, `wildcardBlockedFamilyLimit`, `wildcardBlockedGroupStrongerChampion`, `wildcardBlockedLowDelta`, `wildcardBlockedTotalLimit`, `avgWildcardPromotedMomentum`, `avgChampionMomentumPostWildcard`, `avgValidatedMomentumPostWildcard`.
- `avgChampionMomentumPostWildcard` / `avgValidatedMomentumPostWildcard` = moyennes calculées sur les `entries` finaux (après wildcard), donc identiques aux champs existants `avgChampionMomentum` / `avgValidatedMomentum` quand le pass a été appliqué ; on peut les dupliquer pour clarté sémantique ou les déduire d’un seul calcul.

### 3.4 `runEvolution()`

- Après `capChampionDiversity`, appeler  
  `const { entries: entriesAfterWildcard, wildcardStats } = applyWildcardPromotionPass(entries, capOpts);`  
  puis utiliser `entriesAfterWildcard` partout à la place de `entries` (validateRegistryConsistency, setups, metadata).
- Passer `wildcardStats` à `buildEvolutionMetadata(entriesAfterWildcard, consistency, wildcardStats)`.

---

## PART 4 — Paramètres (env / opts)

| Env | Défaut | Description |
|-----|--------|-------------|
| `EVOLUTION_WILDCARD_ENABLE` | `1` | `1` = actif, autre = désactivé. |
| `EVOLUTION_WILDCARD_MAX_PROMOTIONS` | `3` | Nombre max total de promotions wildcard (ajouts + remplacements). |
| `EVOLUTION_WILDCARD_MIN_NIGHTS` | `4` | `nightsInHistory >=` pour être éligible. |
| `EVOLUTION_WILDCARD_MIN_DELTA` | `0.0015` | `entryMomentum - minChampionMomentum >=` pour éligibilité. |
| `EVOLUTION_WILDCARD_MAX_PER_FAMILY` | `1` | Max promotions wildcard par `familyKey`. |
| `EVOLUTION_WILDCARD_ALLOW_DIVERSITY_CAPPED` | `1` | `1` = autoriser validated avec statusReason `champion_diversity_capped`. |
| `EVOLUTION_WILDCARD_REQUIRE_VALIDATED_STATUS` | `1` | `1` = exiger `status === 'validated'`. |
| `EVOLUTION_WILDCARD_TIE_BREAK` | `1` | `1` = activer la zone d’égalité momentum + tie-break wildcard. |
| `EVOLUTION_WILDCARD_EQUALITY_EPS` | `1e-9` | Tolérance \|Δ momentum candidate−champion\| ≤ eps pour considérer l’égalité (prioritaire). Valeur invalide/absente → `1e-9`. |
| `EVOLUTION_WILDCARD_TIE_EPS` | *(legacy)* | Alias d’`EVOLUTION_WILDCARD_EQUALITY_EPS` si celui-ci est absent. |

Opts équivalentes : `enable`, `maxPromotions`, `minNights`, `minDelta`, `wildcardMaxPerFamily`, `allowDiversityCapped`, `requireValidatedStatus`, `maxPerFamilyKey` (pour cohérence cap), `tieBreakEnable`, `tieMomentumEpsilon`.

---

## PART 5 — Status reasons

**Sur les entrées (registry)**

| Raison | Signification |
|--------|----------------|
| `wildcard_promoted` | Validated promu en champion (groupe sans champion). |
| `wildcard_promoted_over_champion` | Validated promu en champion en remplacement d’un champion plus faible (momentum > champion + minDelta). |
| `wildcard_promoted_over_champion_tiebreak` | Remplacement en zone d’égalité momentum (\|Δ\| ≤ EQUALITY_EPS) : `compareWildcardTieBreak` favorise le candidat **et** `compareGroupMembers(candidat, champion) < 0` (invariant audit). |
| `wildcard_promoted_tiebreak_over_champion` | *(legacy)* Ancien nom ; conservé dans les compteurs rétrocompat. |
| `replaced_by_wildcard` | Champion dégradé (remplacement momentum strict). |
| `replaced_by_wildcard_tiebreak` | Champion dégradé (remplacement tie-break). |

**Uniquement en métadonnées (wildcardStats)**

- `wildcardBlockedFamilyLimit` — refus car quota famille wildcard atteint.
- `wildcardBlockedGroupStrongerChampion` — refus car champion du groupe déjà plus fort (hors bande d’égalité).
- `wildcardBlockedTieBreakLost` — zone d’égalité mais pas de promotion (tie-break perdu **ou** rejet audit).
- `wildcardTieBreakComparisons` — nombre d’entrées évaluées dans la zone \|Δmomentum\| ≤ eps (avec champion présent).
- `wildcardTieBreakAuditRejects` — tie-break qualitatif gagné mais `compareGroupMembers` ne place pas le candidat au-dessus du champion (pas de promotion ; invariant audit préservé).
- `wildcardPromotionsTieBreak` — promotions par tie-break (sous-ensemble de `wildcardPromotionsOverChampion`).
- `wildcardBlockedLowDelta` — refus car delta < minDelta.
- `wildcardBlockedTotalLimit` — refus car quota global atteint.

---

## PART 6 — Validation / smoke tests

```bash
# Depuis neuropilot_trading_v2

# 1) Run evolution avec wildcard activé (défaut)
node engine/evolution/strategyEvolution.js

# 2) Vérifier métadonnées wildcard et delta
node -e "
const path = require('path');
const dataRoot = require('./engine/dataRoot');
const r = require(path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json'));
const m = r.metadata || {};
const cm = m.avgChampionMomentum;
const vm = m.avgValidatedMomentum;
console.log('champions:', r.championsCount, 'wildcardPromotions:', m.wildcardPromotions,
  'wildcardPromotionsOverChampion:', m.wildcardPromotionsOverChampion);
console.log('avgChampion:', cm, 'avgValidated:', vm, 'delta:', (cm != null && vm != null) ? (cm - vm) : null);
console.log('wildcardBlocked*:', m.wildcardBlockedFamilyLimit, m.wildcardBlockedGroupStrongerChampion, m.wildcardBlockedLowDelta, m.wildcardBlockedTotalLimit);
"

# 3) Audit invariants
node engine/evolution/auditRegistryConsistency.js
echo "Audit exit: $?"

# 4) Vérifier maxChampionsInOneFamily
node -e "
const path = require('path');
const dataRoot = require('./engine/dataRoot');
const r = require(path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json'));
const byF = {};
for (const e of (r.setups || []).filter(x => x.status === 'champion')) {
  const fk = e.familyKey || 'unknown';
  byF[fk] = (byF[fk] || 0) + 1;
}
console.log('maxChampionsInOneFamily:', Math.max(...Object.values(byF), 0));
"

# 5) Désactiver wildcard et comparer
EVOLUTION_WILDCARD_ENABLE=0 node engine/evolution/strategyEvolution.js
# Puis relancer avec =1 et comparer champions count et delta
```

---

## PART 7 — Safety notes

- **Trop de promotions** : limité par `EVOLUTION_WILDCARD_MAX_PROMOTIONS` et `EVOLUTION_WILDCARD_MAX_PER_FAMILY`. Risque si max trop élevé → augmenter légèrement le nombre de champions ; garder des valeurs faibles (3, 1) en prod.
- **Famille dominante** : le plafond par famille (wildcard + cap existant) évite qu’une seule famille prenne tout ; surveiller `maxChampionsInOneFamily` et `wildcardBlockedFamilyLimit`.
- **Oscillation champion/validated** : en Cas 2, un même setup peut passer champion → validated → champion d’un run à l’autre si les scores bougent. Acceptable tant que le tri et les seuils sont déterministes ; on peut ajouter un cooldown ou un seuil plus élevé plus tard si besoin.
- **Faux positifs** : un validated promu avec peu de nuits ou un delta limite peut régresser ensuite (extinction/stagnation). `minNights` et `minDelta` réduisent ce risque ; monitorer `avgWildcardPromotedMomentum` et rétroperformance des promus.

---

## PART 8 — Recommandation finale

- **Activation** : activé par défaut (`EVOLUTION_WILDCARD_ENABLE=1`) avec paramètres prudents (max 3, minDelta 0.0015, minNights 4, wildcardMaxPerFamily 1).
- **Progressive** : possible de lancer d’abord avec `EVOLUTION_WILDCARD_MAX_PROMOTIONS=1` ou `2`, puis monter à 3 après vérification des métriques.
- **Dry run** : pas de mode “dry run” dans la spec ; on peut ajouter un flag `dryRun: true` qui remplit `wildcardStats` sans modifier `entries` si nécessaire plus tard.
- **Shadow metrics** : les champs `wildcardCandidatesSeen`, `wildcardBlocked*`, `avgWildcardPromotedMomentum`, `avgChampionMomentumPostWildcard` permettent de suivre l’effet du pass sans déployer en aveugle.

**En une phrase** : activer par défaut avec les valeurs prudentes ci-dessus, surveiller delta et `maxChampionsInOneFamily` les premiers runs, et ajuster `minDelta` / `maxPromotions` si le delta reste négatif ou si le nombre de champions dépasse la cible.

---

## Baseline recommandée (post-tuning)

Verdict : le wildcard n’est pas mal tuné ; il reste inactif quand aucun validated ne bat vraiment le champion de son groupe. Réglage à garder :

- **EVOLUTION_WILDCARD_ENABLE=1**
- **EVOLUTION_WILDCARD_MIN_DELTA=0.001** (ne pas descendre sous 0.001 en prod)
- **EVOLUTION_WILDCARD_MAX_PROMOTIONS=4**

Ces valeurs sont les **défauts** dans le code. Pour un run manuel avec env explicite :

```bash
cd neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
export EVOLUTION_WILDCARD_ENABLE=1
export EVOLUTION_WILDCARD_MIN_DELTA=0.001
export EVOLUTION_WILDCARD_MAX_PROMOTIONS=4
./engine/evolution/scripts/runEvolutionBaseline.sh
node engine/evolution/scripts/snapshotEvolutionMetrics.js
```

Métriques à surveiller sur plusieurs cycles : `wildcardPromotions`, `wildcardBlockedGroupStrongerChampion`, `deltaChampionVsValidated`, `championsDemotedByDiversity`. Si après plusieurs runs les promotions restent à 0 et le delta négatif, agir en amont (extinction, stagnation, discovery), pas en assouplissant le wildcard.
