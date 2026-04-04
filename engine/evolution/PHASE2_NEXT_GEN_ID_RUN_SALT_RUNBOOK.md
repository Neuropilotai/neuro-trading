# Runbook — Phase 2 : `NEXT_GEN_ID_RUN_SALT` (couche identité)

**Pré-requis** : Phase 1 **clôturée** (voir verdict dans [`HOTSPOT_POLICY_VALIDATION_RUNBOOK.md`](./HOTSPOT_POLICY_VALIDATION_RUNBOOK.md) § *Clôture Phase 1*). Ne **pas** mélanger une expérience « salt ON » avec une lecture Phase 1 encore ouverte sur le même cycle.

> **Portée de ce fichier** : mise à jour du **runbook uniquement** — **0 impact runtime**. Les sorties du pipeline ne changent que si tu modifies le **code** (ex. `buildNextGenerationFromChampions.js`), les **variables d’environnement** (ex. `NEXT_GEN_ID_RUN_SALT`), l’**état disque** (`setup_mut_*` / `existingSetupIds`), ou si tu lances **batch / meta / évolution**. Ici : **tableau de bord + protocole** ; le « moteur », c’est l’**exécution** OFF → ON (§9).

**Référence code** : [`buildNextGenerationFromChampions.js`](./buildNextGenerationFromChampions.js) — env `NEXT_GEN_ID_RUN_SALT`, stdout `NEXT_GEN_ID_POLICY`, rapport `discovery/next_generation_report.json` → `idGeneration` + `filterInstrumentation` + `redundancyInstrumentation` (dénominateur du % goulot identité).

---

## 0. Point de référence — avant le premier salt ON (obligatoire)

**But** : figer une ligne **salt OFF** puis la dupliquer pour **salt ON** sur le **même** état disque / champions / policy — la comparaison doit être **immédiate**.

### 0.1 Métriques builder (`next_generation_report.json`)

| Métrique | Chemin JSON | Salt OFF (noter) | Salt ON (noter) |
|----------|-------------|------------------|-----------------|
| `childrenGenerated` | racine `.childrenGenerated` | | |
| `variantsPassedPrecandidateFilter` | `.filterInstrumentation.variantsPassedPrecandidateFilter` | | |
| `rejectedExistingSetupIdOnly` | `.filterInstrumentation.rejectedExistingSetupIdOnly` | | |
| `championsWithZeroAfterPrecandidate` | `.filterInstrumentation.championsWithZeroAfterPrecandidate` | | |
| `runSaltEnabled` | `.idGeneration.runSaltEnabled` | `false` | `true` |
| `totalVariantAttempts` | `.redundancyInstrumentation.totalVariantAttempts` | | |
| `% rejectedExistingSetupIdOnly`* | `100 × rejectedExistingSetupIdOnly / totalVariantAttempts` si total > 0 | | |
| `% passedPrecandidate`† | `100 × variantsPassedPrecandidateFilter / totalVariantAttempts` si total > 0 | | |

\* **Où ça bloque** : part des tentatives **bloquées uniquement** par collision d’`existingSetupId` (goulot identité).  
† **Ce qui passe** : part des tentatives qui **passent** le filtre précandidat (flux réel vers écriture possible). Les deux ratios ensemble donnent une lecture **blocage + débit** sur le même dénominateur.

**Extraction rapide** (adapter `$NEUROPILOT_DATA_ROOT`) :

```bash
REPORT="$NEUROPILOT_DATA_ROOT/discovery/next_generation_report.json"
jq '{
  childrenGenerated,
  runSaltEnabled: .idGeneration.runSaltEnabled,
  totalVariantAttempts: .redundancyInstrumentation.totalVariantAttempts,
  variantsPassedPrecandidateFilter: .filterInstrumentation.variantsPassedPrecandidateFilter,
  rejectedExistingSetupIdOnly: .filterInstrumentation.rejectedExistingSetupIdOnly,
  championsWithZeroAfterPrecandidate: .filterInstrumentation.championsWithZeroAfterPrecandidate,
  pctRejectedExistingIdOnly: (
    if (.redundancyInstrumentation.totalVariantAttempts // 0) > 0
    then (100 * .filterInstrumentation.rejectedExistingSetupIdOnly / .redundancyInstrumentation.totalVariantAttempts)
    else null
    end
  ),
  pctPassedPrecandidate: (
    if (.redundancyInstrumentation.totalVariantAttempts // 0) > 0
    then (100 * .filterInstrumentation.variantsPassedPrecandidateFilter / .redundancyInstrumentation.totalVariantAttempts)
    else null
    end
  )
}' "$REPORT"
```

### 0.1.1 Repères quantitatifs OFF → ON (indicatifs)

Repères **heuristiques** sur `% rejectedExistingSetupIdOnly` (même dénominateur `totalVariantAttempts` pour OFF et ON) — à calibrer sur ton univers :

| Évolution typique | Lecture rapide |
|-------------------|----------------|
| OFF **~95–100 %** → ON **chute nette** (ex. **40–70 %**) | ✅ Succès clair Phase 2 (identité débloquée) — **GO** même si `delta` plat |
| OFF **~95 %** → ON **~80 %** | ⚖️ Amélioration mais goulot identité **encore fort** — Phase 2 **OK** + prochain chantier mutation / diversité |
| OFF **~95 %** → ON **~93–100 %** (quasi inchangé) | ❌ Le salt ne **déplace** pas le signal — **debug** implémentation / env / pairing A/B (§0.3, §9) |

Exemples d’**intensité** sur un même total (ex. 120 tentatives) : **119/120 ≈ 99 %** = quasi bloqué par identité ; **60/120 = 50 %** = goulot partiel ; **10/120 ≈ 8 %** = identité peu dominante (autres freins possibles : `compositeSig`, budgets, etc.).

### 0.1.2 Classification rapide (les deux % ensemble)

| Signal | `% rejectedExistingSetupIdOnly` | `% passedPrecandidate` | Lecture |
|--------|--------------------------------|------------------------|---------|
| 🔴 **Verrouillé** | ≈ **100 %** (ou dominant) | ≈ **0 %** | Identité **bloque** presque tout le précandidat. |
| 🟡 **Qui respire** (après salt ON vs OFF) | **↓** net | **↑** net | Identité **débloquée** → la mutation redevient **visible** en aval du filtre. |
| 🟢 **Sain** | **faible** | **élevé** | Là seulement, juger à fond **mutation / meta / delta** sans que l’identité explique la majeure partie du filtre. |

**Succès Phase 2 complet** (rappel) : **`% rejectedExistingSetupIdOnly` ↓**, **`% passedPrecandidate` ↑**, **`childrenGenerated` ↑** — **même si** `delta` est **identique** (ex. encore négatif). Tant que le **builder** bouge dans ce sens sur une paire OFF/ON **propre**, Phase 2 remplit son contrat ; l’aval se lit **après** ingestion.

⚠️ **Piège 🟡** : voir une **ouverture partielle** (🟡) et vouloir **optimiser la mutation tout de suite** — **non**. Ordre strict après diagnostic :

1. **🔴** → débloquer l’**identité** (salt / pairing A/B / §0.3) tant que le verrou domine.  
2. **🟡** → **confirmer la reproductibilité** (re-run contrôlé ou nouvelle ligne de base documentée) avant d’élargir le scope.  
3. **🟢** → **seulement là** → tuning **mutation / meta / scoring** sans confondre avec un goulot identité résiduel.

**Mnémonique** : **🟡 = ça bouge** ; **🟢 = c’est fiable** — évite le tuning sur du 🟡 **non confirmé** (stabilité / reproductibilité / pas artefact disque).

### 0.2 Métriques aval (après batch + meta + évolution — même protocole pour les deux bras)

| Métrique | Où lire | Salt OFF | Salt ON |
|----------|---------|----------|---------|
| `delta` | sortie `monitor.js` / dernier snapshot habituel | | |
| `validated` | idem | | |
| `wildcardPromotions` | idem | | |

👉 **Lecture attendue** : le **premier succès** Phase 2 est **souvent** une amélioration **builder** (plus de matière qui passe le précandidat, moins de `existingSetupIdOnly`), **pas** une amélioration immédiate du **delta**. Si le builder bouge dans le bon sens après ingestion, Phase 2 remplit son rôle ; l’aval se réévalue **ensuite**.

### 0.3 Règle anti-bruit (comparabilité A/B)

⚠️ **Ne pas** enchaîner un **second** next-gen **salt ON** (ni `ON → ON → ON`) **sans** :

- **reset** explicite du périmètre testé (ex. restauration snapshot de `generated_strategies` / `discovery` selon ton protocole de lab), **ou**
- **nouvelle ligne de base** documentée (tu acceptes que le disque a changé et tu refais un tableau §0 **depuis ce nouvel état**).

**Protocole minimal recommandé** :

| Étape | Action |
|-------|--------|
| 1 | **1** run next-gen **salt OFF** → noter §0.1 / §0.2 |
| 2 | **1** run next-gen **salt ON** (même champions, même policy, **même état disque qu’au départ du bras OFF** si possible) → noter §0.1 / §0.2 |
| 3 | **STOP** → analyse GO / ajustement / bug |

**Pourquoi** : après le premier salt ON, de nouveaux `setup_mut_*` **augmentent** `existingSetupIds`. Un second salt ON **sans** reset **mélange** « effet salt » et « effet historique disque » → **signal dilué** + **biais temporel**. Pour une nouvelle itération, repartir d’un **snapshot clair** ou traiter le run suivant comme **nouvelle expérience** avec tableau §0 **réinitialisé**.

---

## 1. Objectif

Réduire le goulot **`rejectedExistingSetupIdOnly`** quand le moteur de mutation produit des règles **matériellement distinctes** mais des **`childSetupId`** qui **collisionnent** avec des fichiers déjà présents sous `generated_strategies/setup_mut_*`.

- **Sans salt** : le seed de nom est `parentSetupId + mutationType + compositeSig` (concaténation) → IDs **stables** d’un run à l’autre sur le même disque → **rejeux massifs** si l’historique `setup_mut_*` est large.
- **Avec salt** : le seed inclut `|salt|` → **`childName` / `childSetupId` varient par run** tout en laissant **`compositeSig`** (et donc la logique de dédup **matérielle** dans le batch) **inchangée**.

👉 Phase 2 ne « répare » pas le meta, le wildcard, ni `minDelta` : elle **déverrouille l’existence** de nouvelles entrées disque pour la même exploration mutationnelle.

---

## 2. Sémantique exacte (preuve code)

| Élément | Comportement |
|--------|----------------|
| **Variable d’environnement** | `NEXT_GEN_ID_RUN_SALT` — si définie et **non vide** après `trim()`, le salt est actif. |
| **Ce qui change** | Uniquement le **seed** passé à `shortHash` pour fabriquer `childName` → `computeCanonicalSetupId` → **`childSetupId`**. |
| **Ce qui ne change pas** | `sig` / **`compositeSig`** = `parentFamilyKey \| mutationType \| materialRulesSignature(rules)` — inchangé par le salt. |
| **Seed avec salt** | `` `${parentSetupId}\|${mut.type}\|${sig}\|${nextGenIdRunSalt}` `` |
| **Seed sans salt** | `` `${parentSetupId}${mut.type}${sig}` `` |

La précandidate filtre avec : **pass** ssi `compositeSig` ∉ `duplicateSignature` **et** `childSetupId` ∉ `existingSetupIds` (disque + run courant). Voir `filterInstrumentation.filterSemantics` dans le rapport.

---

## 3. Format du salt (garde-fous)

| Règle | Détail |
|--------|--------|
| **Non secret** | Utiliser un identifiant **opérationnel** (timestamp, `run_id`, git short sha **public**, numéro de ticket). **Ne jamais** mettre de token, clé API, ou secret client. |
| **Stabilité intra-run** | **Une valeur par invocation** du builder : même processus = même salt pour tous les champions de ce run. |
| **Traçabilité** | La valeur complète **n’est pas** persistée dans `next_generation_report.json` (seulement `idGeneration.runSaltEnabled`, `runSaltLength`). **Noter le salt** (ou un alias run) dans ton **journal d’ops** / snapshot, pas dans des logs publics bruyants. |
| **Caractères** | Éviter espaces en tête/fin (trim). Préférer `[A-Za-z0-9._-]+` pour éviter surprises shell. |

**Exemples acceptables** :

```bash
export NEXT_GEN_ID_RUN_SALT="run_$(date -u +%Y%m%d_%H%M%S)"
# ou
export NEXT_GEN_ID_RUN_SALT="p2_20260313_001"
```

**Ne pas** : réutiliser **volontairement** le même salt sur des runs comparatifs A/B **sans** le documenter — tu perds la traçabilité « quel univers disque ».

---

## 4. Reproductibilité

| Mode | Effet |
|------|--------|
| **Salt absent / vide** | Reproductibilité **maximale des IDs** pour un même code + mêmes règles + même arbre `setup_mut_*` — utile pour debug, **mauvais** pour casser les collisions cross-run. |
| **Salt fixe documenté** | IDs reproductibles **si** tu fixes `NEXT_GEN_ID_RUN_SALT` à une constante connue (ex. rerun CI) — documente la valeur **hors** repo si besoin d’audit interne. |
| **Salt horodaté** | Reproductibilité **faible** des noms de fichiers — **intentionnel** pour forcer de nouvelles lignées disque. |

Pour **reproduire un run donné** après coup : il faut le **triplet** (commit code, état `generated_strategies` / backup, **valeur de salt**). Sans le salt noté, le rerun génère d’autres `setup_mut_*`.

---

## 5. Comparabilité (monitor / delta)

- **Ne pas** comparer `delta` ou `validated` entre deux mondes où l’un a ingéré **N** nouveaux `setup_mut_*` et l’autre **0** sans tenir compte du **volume** et de la **couverture batch/meta**.
- **Même symbole, même timeframe, même couverture** : règles projet (voir `.cursorrules` / runbooks data).
- Phase 2 **réussie au niveau builder** se lit d’abord dans **`next_generation_report.json`** :
  - `idGeneration.runSaltEnabled === true`
  - `childrenGenerated` **> 0** et **`rejectedExistingSetupIdOnly`** **baisse** matériellement vs un run **sans** salt sur le **même** état champion + policy (contrôle paired si possible).
- L’**aval** (évolution, monitor) est **indicateur secondaire** : peut rester plat si le edge est nul — ce n’est **pas** un NO-GO Phase 2 si le goulot identité est levé.

---

## 6. Tracking & ordre d’exécution

1. **Geler** meta / batch longs avant next-gen si tu veux une lecture propre (même discipline que Phase 1).
2. Exporter `NEXT_GEN_ID_RUN_SALT` (+ conserver Phase 1 `NEUROPILOT_MUTATION_HOTSPOT_POLICY=1` si toujours en prod test).
3. `node engine/evolution/buildNextGenerationFromChampions.js`
4. Vérifier **immédiatement** :
   - stdout : `NEXT_GEN_ID_POLICY` → `runSaltEnabled: true`
   - `$NEUROPILOT_DATA_ROOT/discovery/next_generation_report.json` → `idGeneration`, `filterInstrumentation`, `childrenGenerated`
5. Pipeline habituel **batch → meta** (ingestion des nouveaux mutants).
6. `runEvolutionBaseline.sh` ou équivalent **après** meta stabilisé.
7. Audits min-trades (`engine/meta/auditChildMinTrades*.js`) + `engine/evolution/monitor.js`.

**Journal minimal** (hors secrets) : date, `runSaltLength`, flag hotspot, `childrenGenerated`, `rejectedExistingSetupIdOnly`, hash court du rapport ou chemin snapshot ops.

---

## 7. Critères GO / NO-GO Phase 2

### Cas typiques — lecture après le tableau §0

| Cas | Signaux builder (vs salt OFF, même point de départ) | Lecture | Suite |
|-----|------------------------------------------------------|---------|--------|
| **1 — Succès** | `rejectedExistingSetupIdOnly` **↓ fortement** ; `variantsPassedPrecandidateFilter` **↑** ; `childrenGenerated` **↑** ; `championsWithZeroAfterPrecandidate` **↓** — **même si** `delta` est plat ou légèrement pire | Goulot identité **levé** pour ce cycle | ✅ **GO Phase 2** (identité validée) ; aval à réévaluer après ingestion complète |
| **2 — Semi-succès** | Moins de collisions ID, mais **peu** de variants passent encore le précandidat | Goulot **mixte** : identité partiellement adressée, **mutation / compositeSig** encore serrés | Phase 2 **OK partiel** → prévoir **affinement mutation** (hors scope immédiat salt) |
| **3 — Échec Phase 2** | `rejectedExistingSetupIdOnly` **toujours massif** ; **pas** de gain net sur `childrenGenerated` | Le problème n’est **pas** réduit à « manque de salt » seul (ou autre cause : état disque, implémentation, mauvais pairing A/B — voir §0.3) | **Debug** génération d’ID / protocole expérimental ; **ne pas** conclure « salt inutile » sans vérifier pairing et `runSaltEnabled` |

### GO (couche identité — objectif atteint)

- `idGeneration.runSaltEnabled === true` et cohérent avec l’intention ops.
- Sur une paire de runs **comparables** (même policy, mêmes champions, même disque de départ) : **baisse nette** de `rejectedExistingSetupIdOnly` et/ou **hausse** de `childrenGenerated` / fichiers `setup_mut_*` **nouveaux** réellement écrits.
- Pas de régression **bloquante** : pas d’explosion de `rejectedDuplicateCompositeSigOnly` inexpliquée (le salt ne doit pas « inventer » des collisions matérielles — il ne touche pas `compositeSig`).

### NO-GO / stop

- Salt **activé** mais `childrenGenerated` **0** avec causes dominantes **autres** que `existingSetupId` (ex. `allVariantsFiltered` pour `duplicateSignature` uniquement) → le goulot n’est **pas** l’identité ; **ne pas** empiler du salt en boucle.
- **Mélange d’expériences** : salt togglé au milieu d’une série sans taguer les runs → lecture monitor **invalide**.
- **Enchaînement salt ON répété** sans reset / nouvelle ligne de base §0 → comparabilité **cassée** (voir **§0.3**).
- ⚠️ **Croissance disque** : chaque run salé peut ajouter beaucoup de `setup_mut_*` — prévoir **rétention / archivage** et charge batch ; pas de fuite de secrets dans les noms ou logs.

### Hors scope Phase 2 (ne pas détourner)

- Wildcard, tie-break, `minDelta`, seuils meta — **après** preuve que le pipeline **reçoit** assez de nouveaux candidats.

---

## 8. Lien avec Phase 1

Phase 1 a validé **mutationHotspotPolicy** (recevable, patch appliqué). Si l’aval est **plat** avec **`runSaltEnabled: false`** et **`rejectedExistingSetupIdOnly`** massif, la cause dominante est **identité / collisions**, pas l’invalidité du patch hotspot. Phase 2 est la **suite logique** documentée ici.

Voir aussi : [`EXPLORATION_REDUNDANCY_PLAN.md`](./EXPLORATION_REDUNDANCY_PLAN.md), [`MUTATION_HOTSPOT_POLICY.md`](./MUTATION_HOTSPOT_POLICY.md).

---

## 9. Checklist exécution terrain (éviter les pièges au moment du run)

Les erreurs arrivent souvent **à l’exécution**, pas dans le design. Ordre strict :

### 9.1 Baseline — salt OFF

- **Ne pas** définir `NEXT_GEN_ID_RUN_SALT` (ou variable vide / absente selon ton shell).
- Lancer **exactement 1** `buildNextGenerationFromChampions.js`.
- **Immédiatement** : copier / figer `next_generation_report.json` (ou extraire §0.1 avec `jq`) — `childrenGenerated`, `variantsPassedPrecandidateFilter`, `rejectedExistingSetupIdOnly`, `championsWithZeroAfterPrecandidate`, et optionnellement `%` (§0.1).

**Exemple shell** (depuis la racine où tu exécutes d’habitude ce script, ex. `neuropilot_trading_v2/`) :

```bash
unset NEXT_GEN_ID_RUN_SALT
# NEUROPILOT_DATA_ROOT inchangé entre OFF et ON
node engine/evolution/buildNextGenerationFromChampions.js
# puis jq §0.1 ou copie du report → remplir §9.7 colonne OFF
```

### 9.2 Run test — salt ON

- `export NEXT_GEN_ID_RUN_SALT="..."` (non secret, voir §3).
- **Même contexte** que le bras OFF : **même disque** (pas de nettoyage entre OFF et ON **sauf** si c’est **explicitement** le protocole — sinon la comparaison est fausse), **mêmes champions**, **même policy**.
- Lancer **exactement 1** next-gen.
- Remplir la colonne **ON** du tableau §0.1.

**Exemple shell** (enchaînement **après** capture OFF — **pas** sur la même ligne que OFF) :

```bash
export NEXT_GEN_ID_RUN_SALT=run_001
node engine/evolution/buildNextGenerationFromChampions.js
# jq §0.1 ou copie du report → remplir §9.7 colonne ON → STOP (§9.3)
```

### 9.3 Après le run ON — STOP lecture builder

Avant batch / meta / évolution :

- ❌ **Ne pas** relancer un autre next-gen (ni OFF ni ON).
- ❌ **Ne pas** enchaîner pipeline complet **avant** d’avoir lu et noté le rapport **builder** (`next_generation_report.json` + métriques §0.1).

👉 **Analyser tout de suite** : la preuve A/B est dans le rapport ; le pipeline aval peut attendre (ou ne tourner qu’**après** cette lecture, selon ton plan — l’essentiel est de ne **pas** mélanger plusieurs next-gen ni de « perdre » le snapshot mental entre deux écritures disque).

### 9.4 Lecture rapide (~30 s), dans cet ordre

1. `rejectedExistingSetupIdOnly` et **`% rejectedExistingSetupIdOnly`** (§0.1) — doivent **baisser** si le salt débloque l’identité ; voir repères §0.1.1.
2. `variantsPassedPrecandidateFilter` et **`% passedPrecandidate`** (§0.1) — doivent **monter** (flux réel sur le même dénominateur).
3. `childrenGenerated` — doit **monter** (sous contrainte budget / disque).
4. `championsWithZeroAfterPrecandidate` — doit **baisser**.

`delta` / `validated` / `wildcard` = **secondaires** à ce stade (§0.2).

### 9.5 Pièges classiques

| Piège | Effet |
|-------|--------|
| Comparer OFF sur un **ancien** état disque vs ON après **plusieurs** mutations non contrôlées | Fausse causalité |
| Regarder le **delta** avant d’avoir validé le **builder** | Bruit / mauvaise conclusion Phase 2 |
| **Plusieurs** salt ON d’affilée sans reset §0.3 | Preuve diluée, biais temporel |
| Oublier que le run ON **ajoute** déjà des `setup_mut_*` | Le prochain next-gen voit un **autre** `existingSetupIds` |

### 9.6 Rappel objectif Phase 2

**Faire passer plus de variantes par la couche identité** — **pas** viser le PnL immédiat. Une fois le builder validé, le reste du pipeline peut apprendre sur une **matière nouvelle** structurée, pas sur du bruit.

### 9.7 Gabarit pour revue externe (coller après le test)

Copier-coller et remplir (sortie `jq` §0.1 ou tableau à la main) :

```text
OFF (unset NEXT_GEN_ID_RUN_SALT):
- totalVariantAttempts:
- rejectedExistingSetupIdOnly:     (abs + % rejectedExistingSetupIdOnly)
- variantsPassedPrecandidateFilter: (abs + % passedPrecandidate)
- childrenGenerated:

ON (export NEXT_GEN_ID_RUN_SALT=…, runSaltLength: __):
- totalVariantAttempts:
- rejectedExistingSetupIdOnly:     (abs + % rejectedExistingSetupIdOnly)
- variantsPassedPrecandidateFilter: (abs + % passedPrecandidate)
- childrenGenerated:

Optionnel aval: delta / validated / wildcardPromotions:
```

👉 À partir de ça : verdict **GO / semi / bug**, puis si besoin **tuning mutation** ou **debug couche ID**.

---

## 10. Après un **GO Phase 2** (builder) — confirmation & chaîne aval

### 10.1 Ce que valide un GO (rappel)

Un **GO** sur la **couche identité** signifie : sur une paire OFF/ON **propre**, **`% rejectedExistingSetupIdOnly`** chute fortement et **`% passedPrecandidate`** / **`childrenGenerated`** montent — **sans** exiger encore un meilleur **delta**. La **causalité** « salt → déblocage identité » est alors **établie** pour ce cycle.

### 10.2 Nuance — `totalVariantAttempts` OFF ≠ ON (souvent normal)

Le builder s’arrête quand le **budget global** est atteint : `NEXT_GEN_MAX_CHILDREN` (défaut **40** via `process.env`, voir `buildNextGenerationFromChampions.js`).

- Bras **OFF** avec **`childrenGenerated: 0`** : le budget ne se remplit pas → le parcours peut analyser **tous** les champions → `totalVariantAttempts` **plus élevé** (ex. une centaine).
- Bras **ON** avec **`childrenGenerated`** au plafond : le parcours **s’arrête tôt** → moins de champions vus → `championsAnalyzedForPrecandidate` et `totalVariantAttempts` **plus bas**.

👉 Pour la décision **identité**, les **ratios** et le **renversement** OFF→ON priment ; les **totaux absolus** de tentatives ne sont pas toujours comparables **1:1** entre les deux bras si l’un **sature** le budget et l’autre **non**. Noter dans le journal : `NEXT_GEN_MAX_CHILDREN`, `childrenGenerated` (saturation oui/non).

### 10.3 Run de **confirmation** (reproductibilité — avant tuning mutation)

**Objectif** : vérifier que le pattern **n’est pas** un artefact ponctuel (disque / env / run unique).

| Option | Procédé |
|--------|---------|
| **A — Lab (idéal)** | Repartir d’un **snapshot** identique de `generated_strategies` / `discovery` (état **avant** le premier OFF). Refaire **exactement** : unset salt → **1** next-gen → capture §9.7 → **même** salt (ou nouveau non secret documenté) → **1** next-gen → capture → **STOP**. Attendre le **même type** de signal (OFF verrouillé identité, ON ouverture). |
| **B — Sans snapshot** | Le disque contient déjà de nouveaux `setup_mut_*`. Traiter comme **nouvelle ligne de base** (§0.3). Refaire §0.1 / §9.7 en documentant l’état ; l’OFF peut montrer **moins** de `100 %` rejected ID (historique enrichi) — interpréter avec les **ratios** + contexte disque. |

**Règle 🟡** : si la confirmation tient → passer à l’**aval** ; **ne pas** enchaîner du tuning mutation **avant** cette étape (§0.1.2).

### 10.4 Chaîne **aval** avec salt ON (après confirmation ou décision ops)

1. **Garder** `NEXT_GEN_ID_RUN_SALT` **cohérent** pour les prochains next-gen **si** tu continues à générer sur le même plan (valeur **non secrète**, notée dans le journal ; ou **nouveau** salt par run documenté — éviter l’ambiguïté).
2. **Batch** → **meta** → **évolution** (ex. `runEvolutionBaseline.sh` ou équivalent) → **monitor** / audits habituels.
3. **Là seulement** : lire **`validated`**, **`wildcardPromotions`**, **`delta`**, avec les garde-fous **couverture / comparabilité** du projet (`.cursorrules`, runbooks data).

### 10.5 Ce qu’il ne faut **pas** faire juste après un GO

- Tuning **mutation** ou **meta** **immédiatement** parce que le builder « respire » — attendre **confirmation** + **premier** cycle aval lisible.
- Enchaîner **plusieurs** next-gen **salt ON** sans protocole (§0.3) ni journal de salt / disque.

### 10.6 Option A — commandes type (snapshot + rerun OFF → ON)

#### 10.6.0 Prérequis — quel snapshot utiliser (sinon A/B **invalide**)

L’archive doit reproduire l’état où le goulot identité était **visible** en OFF : beaucoup de **`setup_mut_*`** déjà sur disque → `existingSetupIds` **chargé**.

| Erreur observée (ops) | Effet |
|----------------------|--------|
| `rm -rf …/generated_strategies/*` puis OFF → ON **sans** restaurer une archive **riche** | Disque **vide** de mutants → **aucune** collision `existingSetupId` en OFF → OFF et ON **identiques** (tous deux « ouverts »). |
| Conclure « salt inutile » ou « OFF = ON » sur ce protocole | ❌ **Faux** — la condition n’est plus « OFF bloqué vs ON débloqué », mais « disque propre ». |

**Ce que ce cas prouve quand même** : sans historique `setup_mut_*`, le builder respire **même sans salt** → le goulot vu avant était bien porté par **l’état disque** / **`existingSetupIds`**. Ça **renforce** le diagnostic identité ; ça **ne remplace pas** un A/B OFF-bloqué vs ON-débloqué.

**Journal** : si une confirmation a été faite sur disque vide, noter explicitement : *« Confirmation A non comparable : OFF exécuté sur `generated_strategies` sans historique mutant → pas de rejeu existingSetupId ; ne pas inférer équivalence salt. »*

#### 10.6.1 A/B **comparable** — double restauration du **même** snapshot

Pour retester OFF-bloqué vs ON-débloqué, il faut le **même** état disque **S** avant **chaque** bras (sinon le premier run modifie `generated_strategies`).

1. Restaurer **S** (archive riche en `setup_mut_*`).  
2. **OFF** → capture §9.7.  
3. **Re-restaurer S** (identique à l’étape 1).  
4. **ON** → capture §9.7 → STOP.

#### 10.6.2 Créer une archive

À faire **avant** la première expérience Phase 2 (ou pour figer un état connu) :

```bash
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:?set DATA_ROOT}"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
mkdir -p "$NEUROPILOT_DATA_ROOT/archives"
tar -czf "$NEUROPILOT_DATA_ROOT/archives/phase2_generated_strategies_${STAMP}.tgz" \
  -C "$NEUROPILOT_DATA_ROOT" generated_strategies
cp "$NEUROPILOT_DATA_ROOT/discovery/next_generation_report.json" \
  "$NEUROPILOT_DATA_ROOT/archives/next_generation_report_${STAMP}.json" 2>/dev/null || true
```

#### 10.6.3 Exécution (remplacer le `.tgz` par l’archive **riche** réelle)

```bash
cd /chemin/vers/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:?}"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
SNAP="$NEUROPILOT_DATA_ROOT/archives/phase2_generated_strategies_RICHE_AVANT_PHASE2.tgz"

restore_s() {
  rm -rf "$NEUROPILOT_DATA_ROOT/generated_strategies"
  mkdir -p "$NEUROPILOT_DATA_ROOT/generated_strategies"
  tar -xzf "$SNAP" -C "$NEUROPILOT_DATA_ROOT"
}

# Bras OFF depuis l’état S
restore_s
unset NEXT_GEN_ID_RUN_SALT
node engine/evolution/buildNextGenerationFromChampions.js
# jq §0.1 → §9.7 colonne OFF

# Revenir à S avant le bras ON (obligatoire si OFF a écrit des fichiers ; recommandé toujours)
restore_s
export NEXT_GEN_ID_RUN_SALT="run_confirm_${STAMP}"
node engine/evolution/buildNextGenerationFromChampions.js
# jq §0.1 → §9.7 colonne ON ; STOP (§9.3)
```

⚠️ **Destructif** sur `generated_strategies` — vérifier `NEUROPILOT_DATA_ROOT` **deux fois** avant `rm -rf`.

### 10.7 Option B — chaîne aval salt ON (opérationnel)

Si la **confirmation A** s’est faite sur **disque vide** (§10.6.0), elle **n’annule pas** le **GO Phase 2** obtenu sur l’état **riche** d’origine — elle invalide seulement **ce** rerun comme A/B OFF-bloqué vs ON. La suite **propre** est souvent **B** (aval sur état ouvert) ou un **nouvel A** avec archive **riche** + double `restore_s`.

**Journal d’ops** : noter `NEXT_GEN_ID_RUN_SALT`, **+N** enfants `setup_mut_*`, `NEUROPILOT_DATA_ROOT`, hash/commit.

```bash
cd /chemin/vers/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:?}"
export NEXT_GEN_ID_RUN_SALT="${NEXT_GEN_ID_RUN_SALT:-run_001}"   # documenté, non secret ; pour futurs next-gen

# 1) Batch / ingestion — runTwoStageDiscovery inclut les setup_mut_*.json (préfixe supporté).
# Adapter SYMBOL TF dataGroup à ton univers (répéter pour chaque groupe habituel).
node engine/discovery/runTwoStageDiscovery.js XAUUSD 5m xauusd_5m

# 2) Meta
TOP_N="${TOP_N:-30}"
PORTFOLIO_MAX="${PORTFOLIO_MAX:-12}"
node engine/meta/runMetaPipeline.js "$TOP_N" "$PORTFOLIO_MAX"

# 3) Évolution + audits + append metrics (ne lance pas buildNextGenerationFromChampions)
./engine/evolution/scripts/runEvolutionBaseline.sh

# 4) Monitor
node engine/evolution/monitor.js latest
```

**Note** : `engine/batch/runStrategyBatch.js` peut rester un **stub** selon branche ; la voie documentée pour **charger** les stratégies fichier (dont `setup_mut_*.json`) vers des résultats batch exploitables par le meta est souvent **`runTwoStageDiscovery.js`**. Si ton orchestrateur interne diffère, garder l’ordre logique **batch → meta → evolution → monitor** et le **même** `NEUROPILOT_DATA_ROOT`.

### 10.8 Après exécution — quoi transmettre pour revue

| Choix | Action | À envoyer (relecture externe) |
|-------|--------|-------------------------------|
| **A** | §10.6 snapshot + rerun OFF→ON | Tableau **§9.7** **confirmation** (OFF vs ON) + mention archive / `NEUROPILOT_DATA_ROOT` — **valide** seulement si snapshot **riche** + **double `restore_s`** (§10.6.0–10.6.3) ; sinon noter « A/B non comparable » (disque vide). |
| **B** | §10.7 chaîne aval | Sorties **`node engine/evolution/monitor.js latest`**, **`alerts`**, **`trend`** (ex. `trend 20`) + tout signal aval utile (`validated`, `wildcardPromotions`, `delta`, cohérence couverture) |

**Règle** : **A** = preuve **builder** reproductible ; **B** = preuve **aval** après ingestion — objectifs de lecture différents.

### 10.9 Après verdict **B** plat — lecture & vérification d’ingestion

#### Lecture structurée (monitor inchangé)

| Signal | Interprétation typique |
|--------|-------------------------|
| **GO identité / builder** | Inchangé : le salt a déjà prouvé le déblocage au **next-gen**. |
| **Aval neutre** | `champions` / `validated` / `delta` / `wildcard` **stables** après un cycle B **ne prouvent pas** que le salt est inutile en aval. |
| Causes possibles | Nouveaux `setup_mut_*` **non** ou **peu** présents dans les **batch results** consommés par le meta ; **ranking / caps / wildcard / minDelta** inchangés ; **historique** domine encore le classement. |

**Prochaine action** : **ne pas** tuner wildcard ou mutation **tant que** l’ingestion réelle n’est pas **prouvée**. Si ingestion **OK** et aval **toujours** plat → chantier suivant = **meta / ranking / sélection / caps**, **pas** la couche identité.

#### Checklist — la chaîne B a-t-elle intégré les mutants ?

Exécuter depuis la machine (adapter `NEUROPILOT_DATA_ROOT`) ; **aucun secret** dans les sorties.

⚠️ **Chemin meta** : le fichier est **`$NEUROPILOT_DATA_ROOT/discovery/meta_ranking.json`**, **pas** `.../meta/meta_ranking.json` (piège fréquent).

1. **Fichiers disque** — enfants champion encore présents :

```bash
DR="${NEUROPILOT_DATA_ROOT:?}"
ls -1 "$DR/generated_strategies"/setup_mut_*.json 2>/dev/null | wc -l
```

2. **Batch** — les `setupId` des mutants apparaissent dans **au moins un** `strategy_batch_results_*.json` **après** ton run discovery / batch (sinon le meta ne peut pas les classer) :

```bash
# setupId contenant "mut_" dans les batch (aperçu) — ripgrep si dispo
rg '"setupId"\s*:\s*"[^"]*mut_' "$DR/batch_results"/strategy_batch_results_*.json 2>/dev/null | head -20
# Sinon : grep -h oneline JSON (moins fiable si pretty-print)
grep -h 'mut_' "$DR/batch_results"/strategy_batch_results_*.json 2>/dev/null | head -c 4000; echo
```

3. **Meta** — présence dans `meta_ranking.json` (le meta fusionne les batch files + règles depuis `generated_strategies` pour `setup_mut_*.json`) :

```bash
META="$DR/discovery/meta_ranking.json"
test -f "$META" && jq '[.strategies[]?.setupId | select(test("mut_"))] | length' "$META"
jq '.strategies[]? | select(.setupId | test("mut_")) | .setupId' "$META" 2>/dev/null | head -15
```

4. **Ordre temporel** — `meta_ranking.json` et les `strategy_batch_results_*.json` concernés doivent être **plus récents** que le dernier `buildNextGenerationFromChampions.js` **salé** (sinon tu lis un **vieux** aval).

```bash
ls -lt "$DR/discovery" | head
ls -lt "$DR/batch_results"/strategy_batch_results_*.json 2>/dev/null | head
```

5. **Couverture** — si tu n’as lancé `runTwoStageDiscovery` que pour **un** `dataGroup` (ex. `xauusd_5m`), les mutants n’ont des métriques batch que pour les symboles / TFs **effectivement** backtestés. Enchaîner les **mêmes** groupes que ton orchestrateur habituel.

| Cas | Si… | Alors goulot probable… |
|-----|-----|-------------------------|
| **1** | `mut_` **absent** du batch | Discovery / batch **non** relancé ou mauvais `dataGroup` |
| **2** | `mut_` **dans** batch, **0** dans `meta_ranking` | Meta / filtre `isValidResult` / contrat résultat |
| **3** | `mut_` **dans** meta, **pas** dans champions / monitor plat | Ranking, caps, wildcard, sélection évolution |
| **4** | `mut_` **partout**, monitor **toujours** plat | **Qualité** des mutations / scoring (edge faible), pas ingestion |

**Ne pas** ajuster **wildcard**, **minDelta**, ni **tuning mutation** **avant** d’avoir classé le blocage dans le tableau ci-dessus via les checks 1–5.

#### À coller pour relecture externe (3 chiffres)

1. Nombre de `setup_mut_*.json` (check 1).  
2. **2–3 lignes** de sortie batch (check 2).  
3. **2–3** `setupId` meta (check 3).

### 10.10 Après **GO ingestion** (§10.9) — audit **sélection / ranking / évolution**

**Gate** : **ne pas** modifier le code (portfolio, caps, wildcard, meta, évolution) **avant** d’avoir exécuté ce bloc, vérifié la **cohérence temporelle** meta vs `next_generation_report.json`, et classé le résultat dans le tableau de lecture — sinon risque de corriger le **mauvais étage**.

#### 10.10.0 Synchroniser le pipeline **avant** les requêtes §10.10 (si horodatages décalés)

Si **`discovery/next_generation_report.json`** est **plus récent** que **`discovery/meta_ranking.json`** (ou que les `strategy_batch_results_*.json` concernés), le plateau monitor peut être un **faux problème** : portfolio / registry lisent encore un **meta antérieur** au dernier next-gen.

**Obligation** : enchaîner **batch/discovery** (pour tes `dataGroup` habituels) → **meta** → **évolution**, **puis** seulement §10.10.

Exemple minimal (depuis `neuropilot_trading_v2/`, adapter **symbol tf dataGroup** — répéter pour chaque groupe que tu traites d’habitude, voir §10.7) :

```bash
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:?}"
cd /chemin/vers/neuropilot_trading_v2

node engine/discovery/runTwoStageDiscovery.js XAUUSD 5m xauusd_5m
# … autres runTwoStageDiscovery si besoin

TOP_N="${TOP_N:-30}"
PORTFOLIO_MAX="${PORTFOLIO_MAX:-12}"
node engine/meta/runMetaPipeline.js "$TOP_N" "$PORTFOLIO_MAX"

./engine/evolution/scripts/runEvolutionBaseline.sh
```

Contrôle rapide : `ls -lt "$NEUROPILOT_DATA_ROOT/discovery/meta_ranking.json" "$NEUROPILOT_DATA_ROOT/discovery/next_generation_report.json"` — le meta doit être **au moins aussi récent** que le report next-gen que tu veux expliquer.

Quand les `mut_` sont **dans** batch **et** `discovery/meta_ranking.json`, le plateau monitor vient **probablement** des étapes **après** meta : **portfolio**, **caps**, **wildcard**, **registry** (validated / champions).

**Nuance fichier meta** : `meta_ranking.json` ne contient que le **top N** post-filtres (`capRankedStrategiesByDiversity`, `topN` — voir `runMetaPipeline.js`). Les mutants **absents** du fichier peuvent exister **plus bas** dans le classement interne ; s’ils y **sont**, ils sont déjà dans la fenêtre **top N** exportée.

**Cohérence temporelle** : si `next_generation_report.json` est **plus récent** que `meta_ranking.json`, les **derniers** `setup_mut_*` **ne sont pas** dans ce meta — il faut **rebatch + remeta** avant de conclure (**§10.10.0**).

#### Commandes (adapter `NEUROPILOT_DATA_ROOT`)

```bash
DR="${NEUROPILOT_DATA_ROOT:?}"
META="$DR/discovery/meta_ranking.json"
PORT="$DR/discovery/strategy_portfolio.json"
REG="$DR/champion_setups/champion_registry.json"

# 1) Combien de mut_ dans le top meta exporté (+ méta-score min / max pour contexte)
jq '[.strategies[]? | select(.setupId | test("mut_"))] | length' "$META"
jq '.strategies[]? | select(.setupId | test("mut_")) | {setupId, meta_score, portfolio_score, family_diversity_rank}' "$META" | head -40

# 2) Combien dans le portfolio sélectionné (strategy_portfolio.json)
jq '[.strategies[]? | select(.setupId | test("mut_"))] | length' "$PORT"
jq '.strategies[]? | select(.setupId | test("mut_")) | {setupId, allocation_weight, meta_score}' "$PORT" | head -30

# 3) Registry évolution — candidats / validated / champions
jq '[(.candidates // [])[] | select(.setupId | test("mut_"))] | length' "$REG"
jq '[(.validated // [])[] | select(.setupId | test("mut_"))] | length' "$REG"
jq '[(.champions // [])[] | select(.setupId | test("mut_"))] | length' "$REG"
jq '(.candidates // []), (.validated // []), (.champions // []) | .[] | select(.setupId | test("mut_")) | {setupId, status}' "$REG" 2>/dev/null | head -25
```

#### Lecture rapide

| Pattern | Interprétation |
|---------|----------------|
| mut_ **dans** meta, **0** dans portfolio | Filtre portfolio (`validationPassed`, diversification, correlation, `portfolioMax`, etc.) |
| mut_ **dans** portfolio, **0** dans validated | Blocage ou lenteur **évolution** (promotion candidate → validated) |
| mut_ **dans** validated, **0** champions | **Delta** / momentum / wildcard / caps champions |
| mut_ **partout** mais metrics **plat** | Edge faible vs historique — chantier **qualité** / scoring, pas identité |

---

## Annexe — Exemple de résultat **GO** (référence interne, non normative)

Cycle documenté : OFF verrouillé à **100 %** `rejectedExistingSetupIdOnly` et **0** enfant ; ON avec salt → **0 %** rejected ID-only, **100 %** passed precandidate, **`childrenGenerated`** au plafond budget — **renversement complet** du goulot identité pour ce lab. Toute reproduction doit **noter** budget, disque et `runSaltEnabled`.
