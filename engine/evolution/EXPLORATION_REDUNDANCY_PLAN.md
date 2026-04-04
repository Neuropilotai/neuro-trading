# Plan chantier — redondance d’exploration & diversité amont

Document **remédiation / chantier** (amont de la sélection).  
Ne remplace pas le diagnostic d’audit : voir **[AUDIT_EMERGENCE_BLOCKING.md](./AUDIT_EMERGENCE_BLOCKING.md)** (verdict final, tie-break, forensics).

**Documents voisins (même dossier)** : [EVOLUTION_DELTA_OPERATOR.md](./EVOLUTION_DELTA_OPERATOR.md) · [WILDCARD_PROMOTION_PASS.md](./WILDCARD_PROMOTION_PASS.md) · [CHAMPION_SNAPSHOT_LEGEND.md](./CHAMPION_SNAPSHOT_LEGEND.md)

---

## 1. Contexte

### Verdict verrouillé issu de l’audit

- Le **wildcard / tie-break** a été **prouvé légitime** dans le cas résolu : candidats **indiscernables** du champion du groupe sur les métriques du pass (`momentum`, `avgMetaScore`, nuits, flag mutation, etc.) → `WILDCARD_TIEBREAK_BLOCKED`, `wildcardBlockedTieBreakLost` = `wildcardCandidatesSeen`, autres blocages wildcard nuls (hors quotas).
- Le **diagnostic causal dominant** n’est donc **pas** « seuils trop durs » ni « absence d’edge » au sens brut, mais :
  - **(1)** exploration **trop redondante** / espace de mutation **trop étroit** (dominant) ;
  - **(2)** scoring / rang **intra-groupe** qui ne **sépare** pas des variantes proches (secondaire).

### Symptômes amont observés (exemples type)

- Gros groupes de candidats sous la **même** clé de compétition moteur avec **`distinctScores = 1`** (même score répété N fois) — duplication **effective**, pas « presque pareil ».
- Top candidats **dominés par quelques `parentSetupId`** et familles — réplication de lignes parentes plutôt qu’exploration large.
- Mix **`mutationType`** très concentré (ex. majorité `null` côté base, mutations utiles surtout `parameter_jitter` + un peu `forced_family_shift`).

### Conséquence mécanique

Si l’exploration produit des **quasi-clones** au sein d’un même groupe de compétition, **`compareGroupMembers`** et le **tie-break wildcard** sont **condamnés** à conserver le champion : ce n’est pas une défaillance de la sélection, c’est une **conséquence** de l’amont.

---

## 2. Objectif

| Objectif | Détail |
|----------|--------|
| Réduire la redondance **intra-`competitionGroupKey`** | Moins de variantes qui retombent sur les **mêmes** métriques / mêmes signatures effectives après batch. |
| Augmenter la **diversité réelle** des candidats | Parents, familles, variations **structurelles** et paramétriques **discernables** — pas seulement plus de fichiers. |
| **Ne pas toucher à la sélection dans cette phase** | Pas de modification de wildcard, `minDelta`, tie-break, caps diversity dans un premier temps. |

---

## 3. Périmètre

| Zone | Rôle |
|------|------|
| **[buildNextGenerationFromChampions.js](./buildNextGenerationFromChampions.js)** | Génération d’enfants depuis **champions** ; budget par champion, config de mutations, signature matérielle, dédup locale, tri meta-learning. |
| **[familyExpansionEngine.js](./familyExpansionEngine.js)** | Expansion familiale amont ; le pipeline complet exécute souvent **expansion puis** next-gen (voir `engine/scripts/runFullPipelineExpanded.sh`). Même logique de **diversité** à auditer ici. |
| **[strategyEvolution.js](./strategyEvolution.js)** | **Lecture seule** pour cette phase : `competitionGroupKey`, `compareGroupMembers`, `applyWildcardPromotionPass` — compréhension des effets **aval** ; **pas** le premier levier de code. |

**Rappel moteur** : `competitionGroupKey` rattache les mutations au **parent** (ligne parente) — toute explosion de variants sous le même parent partage la **même** clé de groupe pour le wildcard.

```95:100:neuropilot_trading_v2/engine/evolution/strategyEvolution.js
function competitionGroupKey(e) {
  if (!e || !e.setupId) return null;
  const ps = e.parentSetupId;
  if (ps && String(ps) !== String(e.setupId)) return String(ps);
  return String(e.setupId);
}
```

---

## 4. Ordre de travail

1. **Baseline reproductible**  
   - Run pipeline habituel + `strategyEvolution` / registry.  
   - Capturer : `next_generation_report.json`, `family_expansion_report.json` (si présent), extrait metadata wildcard, et mesures **jq** type « top validated par `group_key` moteur », `distinctScores` par groupe (comme en Phase 2 de l’audit).

2. **Instrumentation (comportement par défaut inchangé)**  
   - **`redundancyInstrumentation`** (Phase 1a) : redondance **matérielle** intra-batch / jitter no-op (`totalVariantAttempts`, `globalDistinctMaterialSignaturesAmongAttempts`, `duplicateMaterialSignatureAttemptsTotal`, `jitterNoOp*`, `perChampion`, `topRedundantParents`, `topRedundantMutationTypes`, `childrenWritten*`) ; stdout **`NEXT_GEN_REDUNDANCY_SUMMARY`**.  
   - **`filterInstrumentation`** (Phase 1b) — filtre **pré-écriture** (`filteredVariants` : même condition que le code, pas de changement de logique) :  
     - Globaux : `variantsPassedPrecandidateFilter`, `variantsRejectedTotal`, `rejectedDuplicateCompositeSigOnly`, `rejectedExistingSetupIdOnly`, `rejectedBothCompositeSigAndExistingId`, `rejectedDistinctMaterialInParentBatch`, `championsWithZeroAfterPrecandidate`, `championsAnalyzedForPrecandidate`.  
     - Détail : `byMutationType`, `perChampion[]`, `topChampionsByPrecandidateRejections`, `topChampionsAllVariantsPrecandidateFiltered`, `filterSemantics`.  
     - Résumé stdout : **`NEXT_GEN_FILTER_SUMMARY`**.  
   - **`NEXT_GEN_ID_RUN_SALT`** (opt-in) : casse les collisions `existingSetupIds` **cross-run** en salant uniquement la fabrique `childName` → `childSetupId` ; **ne modifie pas** `compositeSig` ni les `rules`. Rapport : `idGeneration` ; stdout : `NEXT_GEN_ID_POLICY`. Utiliser un salt **non secret** (ex. `run_$(date +%Y%m%d_%H%M%S)`).  
   - Option : petit script sous `engine/evolution/scripts/` pour agréger « redondance intra-groupe » depuis registry + meta (sans supprimer d’entrées).  
   - **Audit entonnoir meta (B2 / top-N)** : `node engine/meta/auditMetaSetupFunnel.js <setupId>…` — lecture seule ; rejoue `groupResultsBySetup` → `buildStrategiesForMeta` → `filterChildrenByMinTrades` → `computeMetaRanking` → … → `capRankedStrategiesByDiversity` (même `TOP_N` que le pipeline, défaut 30). Ne couvre pas les étapes portfolio / cluster après le top écrit dans `meta_ranking.json`.  
   - **Rejets enfant/parent (trades)** : `node engine/meta/auditChildMinTradesRejects.js` — liste agrégée des enfants coupés par `filterChildrenByMinTrades` (tri par écart au seuil). Verdict figé type cas observé : [META_CHILD_MIN_TRADES_VERDICT.md](../meta/META_CHILD_MIN_TRADES_VERDICT.md).

3. **Changements amont derrière flags env**  
   - Toute évolution de graines, nombre de slots, mix structural vs jitter, ou biais anti-redondance doit rester **désactivée par défaut** (régression = 0).  
   - Exemples de noms : `NEXT_GEN_*`, `FAMILY_EXPANSION_*` — à fixer lors de l’implémentation.  
   - **`NEXT_GEN_ID_RUN_SALT`** est opt-in et **n’écrit pas** sa valeur dans le rapport JSON ; ne stocker **aucun** fragment de secret sur disque.

4. **Re-run & comparaison**  
   - Même période / mêmes datasets que la baseline quand c’est possible.  
   - Comparer rapports + métadonnées evolution **avant** de réinterpréter le wildcard.

5. **Relecture wildcard (phase suivante)**  
   - Uniquement si les critères de succès amont sont **atteints** : sinon, les compteurs `wildcardBlockedTieBreakLost` peuvent rester élevés **sans** que la sélection soit en cause.

---

## 5. Ce qu’on ne change pas (cette phase)

- **Wildcard** : `applyWildcardPromotionPass`, quotas, `EVOLUTION_WILDCARD_*` (sauf lecture / debug).  
- **`minDelta` / marge** wildcard.  
- **Tie-break** : `compareWildcardTieBreak`, `EVOLUTION_WILDCARD_TIE_BREAK`, `EVOLUTION_WILDCARD_EQUALITY_EPS`.  
- **Caps diversity** champions (`capChampionDiversity`, `EVOLUTION_MAX_*` associés) — hors scope sauf décision explicite post-mesure.

**Pourquoi** : l’audit a montré que relâcher la sélection promouvrait surtout des **équivalents**, pas des gagnants mesurables.

---

## 6. Critères de succès

| Critère | Indicateur |
|---------|------------|
| Plus de **séparation** intra-groupe | Pour les gros `competitionGroupKey` : **`distinctScores` > 1** (ou équivalent : plusieurs valeurs distinctes de `momentumMetaScore` / métrique de rang parmi les validated du groupe). |
| Moins de duplication par **parent** | Distribution `byParentSetupId` (rapports + meta) **moins concentrée** ; baisse du « pic » 11/6/6/6 sur le top si ce pattern était dominant. |
| **Mutation mix** moins concentré | `byMutationType` : moins de dépendance à seul `parameter_jitter` ; présence mesurable de types **structurels** quand le budget le permet. |
| Intégrité | Aucune régression non flaggée ; logs de skip (duplicate signature, no rules) **explicites** et traçables. |
| Wildcard | **Ensuite seulement** : si amont OK, re-vérifier `wildcardPromotions`, `wildcardBlockedTieBreakLost` / logs — sans changer les seuils par défaut dans ce document. |

---

## 7. Références code (points d’ancrage)

### `strategyEvolution.js`

- Rang intra-groupe (wildcard et normalisation champions) : `compareGroupMembers`  
- Groupe de compétition moteur : `competitionGroupKey` (cf. extrait §3)  
- Pass wildcard : `applyWildcardPromotionPass` — **lecture / validation** post-chantier uniquement  

```72:93:neuropilot_trading_v2/engine/evolution/strategyEvolution.js
function compareGroupMembers(a, b) {
  const ma = Number.isFinite(Number(a.momentumMetaScore))
    ? Number(a.momentumMetaScore)
    : Number(a.avgMetaScore) || -Infinity;
  const mb = Number.isFinite(Number(b.momentumMetaScore))
    ? Number(b.momentumMetaScore)
    : Number(b.avgMetaScore) || -Infinity;
  if (mb !== ma) return mb - ma;
  // ... avgMetaScore, nightsSurvived, mutation vs base, setupId ...
}
```

### `buildNextGenerationFromChampions.js`

- Budget global / par champion : `NEXT_GEN_MAX_CHILDREN`, `MAX_CHILDREN_PER_CHAMPION`  
- Profil adaptatif (jitter vs structural) : `getAdaptiveMutationProfile`, `buildMutationsConfig`  
- Dédup génération : `sig = parentFamilyKey|mutationType|materialRulesSignature(rules)` ; sets `duplicateSignature`, `existingSetupIds`  
- Rapport : `next_generation_report.json` (`skipReasons`, `byMutationType`, `byParentSetupId`)

```160:198:neuropilot_trading_v2/engine/evolution/buildNextGenerationFromChampions.js
function buildMutationsConfig(champion, parentSetupId) {
  const p = getAdaptiveMutationProfile(champion);
  const base = String(parentSetupId) + String(champion.setupId || '');
  const list = [];
  list.push({ type: 'parameter_jitter', fn: (pr, pid) =>
    mutateParameterJitter(pr, numericSeed(base + 'j0'), p.jitterScale) });
  list.push({ type: 'parameter_jitter', fn: (pr, pid) =>
    mutateParameterJitter(pr, numericSeed(base + 'j1'), p.jitterScale) });
  // session_flip, regime_flip, forced_family_shift ...
  return list;
}
```

### `familyExpansionEngine.js`

- Mutation types, budget, policy (`mutation_policy.json` / perf) — à aligner avec les mêmes objectifs de diversité ; éviter double génération **redondante** champion expansion + next-gen sans coordination documentée.

### Pipeline

- **`engine/scripts/runFullPipelineExpanded.sh`** : enchaînement typique **family expansion** puis **`buildNextGenerationFromChampions.js`** — toute mesure « amont » doit tenir compte des **deux** étapes.

---

## 8. Notes de méthode

- **Top validated global ≠** meilleur validated par **`competitionGroupKey`** moteur — ne pas utiliser l’un pour conclure sur l’autre (voir audit, Phase 2).  
- La **dédup par score** n’a pas de sens **à la génération** (pas encore de nightly) ; un garde-fou « même groupe + même score + mêmes attributs » relève du **post-batch / observabilité** ou d’une spec **explicite** avant toute suppression d’entrées registry.  
- Secrets : ne jamais logger `process.env` ni tokens ; instrumentation = **compteurs et signatures métier** uniquement.

---

*Dernière mise à jour : aligné sur le verdict final d’[AUDIT_EMERGENCE_BLOCKING.md](./AUDIT_EMERGENCE_BLOCKING.md) (tie-break légitime, goulot amont).*
