# Runbook — validation post `mutation_hotspot_policy` (Phase 1)

Objectif : prouver **variation utile** amont (moins de clones / moins de `far` min-trades sur hotspots) **sans** toucher wildcard, tie-break, `minDelta`, ni seuils meta.

**Mode opératoire** : ce n’est pas « on active et on regarde » — c’est **tester une hypothèse** avec lecture **ordonnée**, **critères d’arrêt** (NO-GO), et **règle claire** avant d’élargir le scope (`pattern_001_open_cf4dce`). La prochaine décision utile après un premier cycle n’est pas « est-ce que ça compile », mais : **est-ce que le patch produit assez de variation utile pour mériter un second run propre ?**

Référence implémentation : [`MUTATION_HOTSPOT_POLICY.md`](./MUTATION_HOTSPOT_POLICY.md).

### Baseline officiel pré–Phase 1 (figé, comparaison)

| Champ | Valeur |
|--------|--------|
| `ts` | `2026-03-22T11:24:41.141Z` |
| `champions` | 23 |
| `validated` | 171 |
| `delta` | −0.00408 |
| `wildcardPromotions` | 0 |
| `maxChampionsInOneFamily` | 2 |
| Alertes (résumé) | delta fortement négatif ; wildcard inactif 10 runs ; diversité stable ; audit OK |

**Attention — `runEvolutionBaseline.sh`** : ce script lance **strategyEvolution + audits + metrics**, **pas** `buildNextGenerationFromChampions.js`. Le flag **`NEUROPILOT_MUTATION_HOTSPOT_POLICY`** n’a **aucun effet** tant que le **next-gen** n’a pas tourné. Pour un **run 1 Phase 1 complet** : **next-gen** (flag=1) → **pipeline batch + meta** habituel → **puis** evolution/monitor/audits min-trades. Utiliser le baseline shell **seul** = cycle évolution sur l’état disque **actuel** (utile pour monitor), mais **ne prouve pas** l’hypothèse hotspot sans l’étape next-gen (+ batch/meta) avant.

**Test Phase 1 — invalide** pour l’hypothèse hotspot si l’une de ces conditions :

| Situation | Verdict |
|-----------|---------|
| **Flag seul** (sans exécuter le next-gen) | ❌ Insuffisant |
| **`runEvolutionBaseline.sh` seul** | ❌ Mesure l’univers **déjà ingéré**, pas les nouvelles mutations |
| Next-gen **sans** `applications[]` non vide dans le report | ❌ Policy inactive ou mismatch parents |

**Chaîne minimale valide** : **next-gen** → **batch + meta** (ingestion `setup_mut_*`) → **evolution** (ex. `runEvolutionBaseline.sh`) → **audits min-trades** → **monitor**.

**Signal le plus important juste après `buildNextGenerationFromChampions.js`** (avant batch, déjà dans `next_generation_report.json`) : `mutationHotspotPolicy.enabled === true`, **pas** de `warning`, **`applications[]` non vide**, **parents Phase 1** présents dans `applications`. Sans ça, **arrêter** — le reste du pipeline ne valide pas le patch.

**Règle de lecture** : le **premier artefact** à ouvrir après le lancement du next-gen est **`discovery/next_generation_report.json`** → bloc **`mutationHotspotPolicy`**. Si ce bloc ne prouve pas l’application réelle de la policy (**`enabled`** + **`applications[]` utile** + parents ciblés), **stopper la lecture GO/NO-GO** — batch, audits et monitor ne corrigent pas une expérience non recevable.

**Point de contrôle temporel** : le **premier vrai garde-fou** n’est **pas** « dans 60 minutes » ni un **monitor** pris au hasard — c’est **dès que `buildNextGenerationFromChampions.js` a fini**. Un snapshot **monitor** avec les **mêmes** métriques que la baseline pré–Phase 1 (ex. même `delta`, `wildcardPromotions`, `champions`, `validated`) indique en général que la **chaîne complète** n’a pas été exécutée ou que l’on observe encore l’**univers non régénéré** : **ce n’est pas** une preuve Phase 1.

**Ce que ça évite** : croire qu’un **flag** suffit ; lire l’**aval** sur un **univers non régénéré** ; conclure sans preuve que les **parents Phase 1** ont été **patchés**.

### Dépannage — verdict **invalide** (ex. constat en prod)

| Observation | Interprétation typique |
|-------------|-------------------------|
| `mutationHotspotPolicy: { "enabled": false }` | Le **next-gen** qui a écrit ce report **n’avait pas** `NEUROPILOT_MUTATION_HOTSPOT_POLICY` actif **dans l’environnement du processus** `node` (flag exporté ailleurs, autre shell, cron sans env, etc.). |
| `mutationHotspotPolicy` absent ou `{}` sur un vieux fichier | Report **antérieur** à la fonctionnalité, ou mauvais fichier. |
| Deux chemins possibles (`data_workspace/...` vs `$NEUROPILOT_DATA_ROOT/...`) | Lire **le même** `discovery/` que celui utilisé par **`buildNextGenerationFromChampions.js`** (résolu via `NEUROPILOT_DATA_ROOT`). Ne pas se fier à une copie locale périmée. |

**Si batch/meta tourne alors que le garde-fou échoue** : l’expérience Phase 1 est **hors protocole** (univers sans preuve de patch). **Arrêter** le meta / batch en cours, corriger flag + policy, **relancer next-gen**, puis **recontrôler** le bloc avant d’enchaîner.

**Contrôle immédiat après next-gen** (même `NEUROPILOT_DATA_ROOT` que le builder) :

```bash
echo "NEUROPILOT_MUTATION_HOTSPOT_POLICY=$NEUROPILOT_MUTATION_HOTSPOT_POLICY"
ls -l "$NEUROPILOT_DATA_ROOT/governance/mutation_hotspot_policy.json"
node engine/evolution/scripts/printMutationHotspotPolicy.js
```

La sortie JSON doit montrer `enabled: true`, pas de `warning` bloquant, et `applications` non vide. Le script écrit sur **stderr** le chemin exact du report lu (`__source_report`).

**Nuance — `rulesLoaded` vs `parentsMatched`** : `rulesLoaded` compte les règles dans le fichier JSON ; `parentsMatched` compte les **champions** pour lesquels **au moins une** règle a matché ce cycle. Si `parentsMatched < rulesLoaded`, ce n’est **pas** un échec du garde-fou : sur ce registry, seuls certains `setupId` étaient présents (ex. une seule des trois règles Phase 1 peut s’appliquer). L’essentiel reste **`enabled: true`** + **`applications[]` non vide** + parents attendus dans `applications` quand ils sont champions.

**Drapeau jaune (contexte verdict final)** : un next-gen peut être **recevable** (`mutationHotspotPolicy` OK) tout en montrant **`childrenGenerated` faible**, **`championsWithZeroAfterPrecandidate` élevé**, ou beaucoup de **`rejectedExistingSetupIdOnly`** — l’entonnoir amont (salt / `existingSetupIds` / compositeSig) reste serré. La lecture GO/NO-GO **finale** peut être **neutre ou faiblement positive** pour des raisons **autres** que la policy (peu de parents touchés + goulot précandidat). Voir `filterInstrumentation` / `redundancyInstrumentation` dans le même report.

**Pattern observé — collisions `existingSetupId` + `runSaltEnabled: false`** : dans `next_generation_report.json`, si `idGeneration.runSaltEnabled` est **false** et **`rejectedExistingSetupIdOnly`** est **massif** (≈ toutes les tentatives), les variantes sont souvent **matériellement recevables** mais **rejouent les mêmes `childSetupId`** déjà présents sur disque. Ce n’est **pas** un échec de la hotspot policy ; le **frein principal** est alors la **politique d’ID** (absence de `NEXT_GEN_ID_RUN_SALT`), pas le wildcard ni le meta.

- **Ne pas** enchaîner plusieurs **next-gen** « en boucle » dans le même état disque sans traiter les collisions — les retombées seront souvent **les mêmes** `existingSetupId`.
- **Piste** (hors scope immédiat Phase 1) : activer un salt **non secret** par run, ex. `NEXT_GEN_ID_RUN_SALT` (voir en-tête `buildNextGenerationFromChampions.js` — varie `childSetupId` sans changer `compositeSig` / règles).

**GO conditionnel** : si le garde-fou `mutationHotspotPolicy` est OK mais l’entonnoir ci-dessus domine, **finir une fois** la chaîne (batch → meta → évolution → audits → monitor) pour **clôturer** la lecture Phase 1 ; le verdict probable est **GO Phase 1 valide, effet limité par collisions amont**, **prochaine priorité** = `existingSetupId` / salt — pas wildcard.

### Modèle en deux couches (lecture stratégique)

| Couche | Rôle | Phase 1 |
|--------|------|--------|
| **Mutation** (hotspot policy, poids, jitter) | Oriente **quelle** variation est produite | Validable quand `mutationHotspotPolicy` est recevable |
| **Identité** (`childSetupId`, salt, `existingSetupIds`) | Décide si la variante **existe** comme enfant nouveau sur disque | Peut **bloquer** même si les signatures matérielles diffèrent |

Tant que la couche **identité** refuse les IDs (collisions), la couche **mutation** ne peut **pas** s’exprimer pleinement en production. Ce n’est **pas** un problème wildcard, `minDelta`, ni seuil meta — c’est **infrastructure d’évolution** (génération d’ID).

**Pipeline réel (trois étages)** :

1. **Moteur de mutation** — produit des variantes (règles / signatures matérielles).  
2. **Couche identité** — accepte ou rejette (`childSetupId`, `existingSetupIds`, salt). *Goulot actuel typique si collisions massives.*  
3. **Évaluation** (batch, meta, évolution) — ne voit **que** ce qui a passé (1) et (2).

👉 Tant que (2) bloque, le système peut **croire** explorer alors que (3) **n’évalue presque rien de nouveau**.

**Ordre des chantiers** : **ne pas** activer `NEXT_GEN_ID_RUN_SALT` « sur un feeling » **avant** la **lecture complète** des 7 blocs de fin de chaîne — sinon on mélange deux expériences. Après verdict Phase 1 + confirmation du goulot dans le report (`rejectedExistingSetupIdOnly`, `idGeneration`), **Phase 2** typique = politique **salt / ID** documentée (voir en-tête `buildNextGenerationFromChampions.js`, `NEXT_GEN_ID_RUN_SALT`).

### Clôture Phase 1 (verdict final figé — synthèse)

| Verdict | Détail |
|---------|--------|
| **GO technique** | `mutationHotspotPolicy.enabled === true`, `warning === null`, `applications[]` non vide, parent Phase 1 ciblé patché (ex. `mut_2c9c6f_close_f17d88`, `jitterScale = 0.75`, `forcedFamilyShiftWeight = 0`). |
| **Effet aval** | **Faible à nul** si `delta` ne s’améliore pas (voire légère dégradation), et métriques évolution **stables** (`champions`, `validated`, `wildcardPromotions`, etc.). |
| **Lecture causale** | Patch **non invalidé** ; effet **étouffé** par la couche **identité / précandidat** (`rejectedExistingSetupIdOnly` massif, `runSaltEnabled: false`). |
| **Décision** | **Pas de rollback** Phase 1 ; **ne pas** élargir la hotspot ni activer `pattern_001_open_cf4dce` sur ce seul constat ; **priorité suivante** = Phase 2 identité. |

**Runbook Phase 2** : [`PHASE2_NEXT_GEN_ID_RUN_SALT_RUNBOOK.md`](./PHASE2_NEXT_GEN_ID_RUN_SALT_RUNBOOK.md).

---

## 0. Pré-requis

| Élément | Attendu |
|---------|---------|
| Policy fichier | Copier **`config/mutation_hotspot_policy.phase1_safe.json`** vers `$NEUROPILOT_DATA_ROOT/governance/mutation_hotspot_policy.json` (ou chemin explicite). |
| Phase 1 | **Ne pas** inclure `pattern_001_open_cf4dce` tant que la branche n’est pas validée séparément. |
| Flag | `NEUROPILOT_MUTATION_HOTSPOT_POLICY=1` |
| Optionnel | `NEUROPILOT_MUTATION_HOTSPOT_POLICY_FILE=/chemin/vers/policy.json` |

**Règle stricte `pattern_001_open_cf4dce`** : **ne pas** ajouter cette règle à la policy tant que Phase 1 n’a pas produit **au moins 2 runs propres** avec **amélioration** ou **neutralité acceptable** (voir §6 et résumé mental §7).

**Garde-fou stérilité** : chaque parent garde au minimum **2× `parameter_jitter`** + les slots dont le poids reste > 0. Si une policy met **tous** les poids structurels à 0, il reste **2 variantes** — pas un parent totalement muet. Si `childrenGenerated` ou `variantAttempts` par champion chutent de façon anormale vs baseline, **NO-GO** (voir §6).

**Variété étroite (nuance)** : même avec 2 jitters, la combinaison **`sessionFlipWeight: 0` + `forcedFamilyShiftWeight: 0` + jitter resserré** peut réduire la **largeur** de l’espace exploré (moins de « surprises positives » possibles). Ce n’est pas la stérilité totale, mais un **risque de corridor étroit** — d’où l’intérêt de **Phase 1 limitée à 3 règles** et de surveiller redondance / `jitterNoOpRate` en plus du volume brut.

---

## 1. Séquence d’un run de test (ordre recommandé)

1. **Policy on disk** + `export NEUROPILOT_MUTATION_HOTSPOT_POLICY=1`
2. **Next-gen** — `node engine/evolution/buildNextGenerationFromChampions.js` (seul endroit où la policy s’applique)
3. **Pipeline habituel** (batch, meta) pour ingérer les nouveaux `setup_mut_*`
4. **Évolution** — ex. `./engine/evolution/scripts/runEvolutionBaseline.sh` **ou** ton orchestrateur équivalent **après** next-gen + batch/meta (étapes 2–3)
5. **Audits min-trades post-run** (§3)
6. **Monitor** (`monitor.js latest` / `alerts` / `trend`)
7. **Décision GO / NO-GO** (§7)

```bash
cd ~/neuro-pilot-ai/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"

# 1) Policy on disk (une fois)
cp config/mutation_hotspot_policy.phase1_safe.json \
  "$NEUROPILOT_DATA_ROOT/governance/mutation_hotspot_policy.json"

# 2) Next generation (exemple — remplacer par ton entrypoint réel)
export NEUROPILOT_MUTATION_HOTSPOT_POLICY=1
node engine/evolution/buildNextGenerationFromChampions.js

# 3) Puis batch + meta (ingestion des nouveaux setup_mut_*)
# 4) Puis evolution, ex. :
#    ./engine/evolution/scripts/runEvolutionBaseline.sh

# 5) Audits min-trades (§3)
unset NEUROPILOT_MUTATION_HOTSPOT_POLICY   # pas requis pour les audits
AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation \
  node engine/meta/auditChildMinTradesRejects.js
AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation \
  node engine/meta/auditChildMinTradesByParent.js
```

---

## 2. Premier run post-activation — 5 checks prioritaires (**dans cet ordre**)

### 1) La policy s’applique vraiment

Dans `discovery/next_generation_report.json` → `mutationHotspotPolicy` :

- `enabled === true`
- pas de `warning` fichier invalide / absent
- `applications[]` **non vide**
- les **parents ciblés** (Phase 1) apparaissent dans `applications`

Si `enabled === true` mais `applications[]` vide : rollout **techniquement actif, fonctionnellement inutile** → traiter comme **NO-GO** jusqu’à correction (registry / `setupId` / préfixes).

### 2) Pas de stérilité accidentelle

Toujours dans le rapport :

- pas d’**effondrement** de `childrenGenerated` vs baseline
- pas de chute anormale de `totalVariantAttempts` / tentatives par champion
- redondance / clonage en **baisse ou stable** (pas explosion silencieuse d’échecs)

Le risque principal n’est pas une erreur visible, c’est une **baisse silencieuse** de production utile.

### 3) Audit min-trades sur hotspots

`auditChildMinTradesRejects.js` + `auditChildMinTradesByParent.js` (champion) :

- **baisse** du `far` sur les parents ciblés, **ou** au minimum **non-aggravation nette**
- si les **3** parents patchés **empirent tous ensemble** sur le même run → patch **mal orienté** → investiguer avant de continuer

### 4) Évolution aval

Baseline / monitor :

- `wildcardPromotions` peut rester à **0** au premier run — **non fatal**
- le **delta** devrait au moins **cesser de se dégrader** ; idéalement un peu **moins négatif**
- moins de blocages **identiques** sur les mêmes parents (tie-break à delta 0), si traçable dans les logs

### 5) Diversité inchangée

- `maxChampionsInOneFamily` **stable** (idéalement ≤ 2)
- pas de **concentration famille** qui remonte
- autres garde-fous d’audit habituels **OK**

**Signal global sur le premier cycle** (tout le bloc ci-dessus vu ensemble) : pas de **NO-GO fonctionnel** (`applications[]` non vide) ; pas de **stérilité** ni corridor **trop** resserré au point de casser le volume utile ; pas d’**aggravation nette** sur les hotspots ; et au moins un **début de détente aval** — delta qui **cesse de se dégrader**, ou wildcard qui **recommence à respirer**, ou **moins** de blocages clonés sur les mêmes parents.

**Barre mentale run 1** : la question utile n’est pas « le flag a-t-il marché ? » mais : **as-t-on assez de variation utile pour justifier un 2ᵉ run propre ?** (voir aussi §7.)

**Après le 1er cycle complet** (next-gen → batch/meta → evolution) **— checklist d’envoi** (dans **cet ordre**, pour une lecture GO / NO-GO **propre et défendable**) :

1. Bloc **`mutationHotspotPolicy`** depuis **`discovery/next_generation_report.json`** (premier artefact — si invalide, **ne pas** poursuivre l’interprétation des suivants).
2. **Bref résumé batch / meta** : ingestion des nouveaux `setup_mut_*` (fichiers touchés, counts, extrait log).
3. Résumé **`auditChildMinTradesRejects.js`** (`AUDIT_SUMMARY_ONLY=1`, `ONLY_SOURCE_SUBSTRING=champion_mutation`).
4. Résumé **`auditChildMinTradesByParent.js`** (même env).
5. **`node engine/evolution/monitor.js latest`**
6. **`node engine/evolution/monitor.js alerts`**
7. **`node engine/evolution/monitor.js trend 10`**

*(Sans le §1 montrant `enabled` + **`applications[]` utile**, le test Phase 1 n’est **pas recevable**.)*

---

## 3. Checklist artefacts / commandes (référence)

**Chemins audits min-trades** (dans ce repo) : **`engine/meta/auditChildMinTradesRejects.js`** et **`engine/meta/auditChildMinTradesByParent.js`** — **pas** sous `engine/evolution/`. Depuis `neuropilot_trading_v2` : `find . -name "*auditChildMinTrades*" -type f`.

**Ordre aval** : laisser **`runMetaPipeline`** se terminer **avant** `runEvolutionBaseline.sh` / monitor final — sinon `meta_ranking` / discovery peuvent encore bouger pendant l’évolution.

| # | Commande / artefact | But |
|---|---------------------|-----|
| A1 | `next_generation_report.json` → `mutationHotspotPolicy` | `enabled`, `path`, `warning`, `parentsMatched`, `applications[]`. |
| A2 | Même rapport → `redundancyInstrumentation` | `jitterNoOpRate`, `duplicateMaterialSignatureAttemptsTotal` vs baseline. |
| A3 | `AUDIT_SUMMARY_ONLY=1` + `auditChildMinTradesRejects.js` (champion) | `counts`, `rejectsGapByBucketMatchingSourceFilter.buckets`. |
| A4 | `AUDIT_SUMMARY_ONLY=1` + `auditChildMinTradesByParent.js` (champion) | `topParentsByPenalty` pour hotspots Phase 1. |
| A5 | Logs / JSON **évolution** | `wildcardPromotions`, `wildcardCandidatesSeen`, `WILDCARD_TIEBREAK_BLOCKED`, delta trend, `validated`, `maxChampionsInOneFamily`. |

---

## 4. Critères **GO** (succès partiel acceptable)

Au moins **plusieurs** des signaux suivants sur **1–3 runs** comparés à la baseline **figée** :

| Signal | Direction souhaitée |
|--------|----------------------|
| `mutationHotspotPolicy.parentsMatched` | > 0 ; `applications` alignés avec les 3 règles Phase 1. |
| `warning` | `null` (fichier policy valide). |
| Champion `rejectsGapByBucketMatchingSourceFilter.far` | Baisse **ou** stabilité avec baisse **intermediate+near** sur hotspots (pas d’aggravation nette du far). |
| `topParentsByPenalty` (hotspots) | Moins de `gapBuckets.far` / moins de `rejectedChildren` sur les mêmes `parentSetupId`. |
| `wildcardPromotions` | **0 → ≥1** sur au moins un run (pas exigé à chaque run). |
| Delta trend (évolution) | Remonte vers **moins négatif** (ex. −0.004 → −0.003). |
| `WILDCARD_TIEBREAK_BLOCKED` | Moins de cas **même parent** avec `deltaVsChampion === 0` **si** les candidats sont mieux différenciés (preuve indirecte). |
| Diversité famille | `maxChampionsInOneFamily` **≤ 2** idéalement (pas de régression). |

**Pas besoin** de « plein de promotions » : la cible est **variation utile** + **moins de thinly traded** côté hotspots.

### Validité expérimentale **vs** puissance du signal

| Notion | Question |
|--------|----------|
| **Validité** | L’hypothèse *a-t-elle été testée* ? (`mutationHotspotPolicy` recevable + chaîne next-gen → batch → …) |
| **Puissance aval** | L’effet *se voit-il fortement* dans delta / wildcard / audits ? |

Avec un **entonnoir précandidat serré** et **`parentsMatched` faible** sur un cycle, la **puissance** peut rester modeste **sans** invalider la policy : **GO Phase 1 (effet limité mais réel)** reste défendable si **pas de régression** (min-trades hotspots, diversité, volume utile) et **signal minimum viable** (delta qui **cesse de se dégrader**, léger mieux, ou moins de blocages clonés / tie-break identiques). **Wildcard à 0** sur un run n’y contredit pas seul.

### Lecture fine des 7 blocs — priorités (verdict final)

1. **Signal minimum viable** : delta **stable** ou un peu **moins négatif** ; ou **moins** de blocages répétés sur les mêmes parents.
2. **Pas de régression** : pas d’**explosion** des rejets min-trades sur hotspots ; pas de chute **anormale** du volume utile.
3. **Cohérence avec le drapeau jaune** : si l’aval est **faible** mais le next-gen montrait **`parentsMatched` bas** + **precandidate / `existingSetupId` massifs** → interpréter comme **limite structurelle amont**, pas comme « patch inutile » sans autre preuve.

**Décisions possibles en fin de chaîne** : **GO** Phase 1 ; **GO conditionnel** (poursuivre avec mêmes garde-fous + noter entonnoir) ; **NO-GO** surtout si régression claire ou invalidité expérimentale — le **NO-GO policy** pur est **moins probable** lorsque le garde-fou next-gen était déjà OK et l’entonnoir connu serré.

---

## 5. Critères **NO-GO** (stop ou rollback policy)

| Condition | Action |
|-----------|--------|
| `mutationHotspotPolicy.warning` persistant (fichier introuvable / JSON invalide) | Corriger chemin / JSON ; ne pas interpréter les métriques batch. |
| `applications[]` vide alors que les champions ciblés sont dans le registry | Rollout inutile : corriger matching (`setupId`, préfixes). |
| `childrenGenerated` ou `totalVariantAttempts` **effondrés** vs baseline sans autre cause | Risque branche trop pauvre / corridor trop étroit → assouplir patch. |
| Champion `far` **en hausse** nette sur les 3 parents ciblés sur 2 runs consécutifs | Revoir règles (ordre, `jitterScaleMin`, slots à 0). |
| `maxChampionsInOneFamily` ou concentration empire | Revoir exploration ailleurs ; pas seulement hotspot. |
| Delta **plus négatif** sans bénéfice latéral visible (min-trades / diversité) | Pause et analyse avant poursuite. |

---

## 6. Tableau **GO / NO-GO** synthétique (par run)

| Check | GO si… |
|-------|--------|
| Policy appliquée | `warning == null` et `parentsMatched ≥ 1` et **`applications[]` non vide** |
| Pas de stérilité | `childrenGenerated` dans l’ordre de grandeur baseline ± raisonnable |
| Min-trades (champion) | Pas d’aggravation du `far` sur hotspots sur 2 runs d’affilée |
| Wildcard (optionnel) | `wildcardPromotions ≥ 1` **ou** delta trend **améliore** **ou** delta **ne se dégrade plus** |
| Diversité | Pas de régression `maxChampionsInOneFamily` |

**Décision** : **GO poursuivre Phase 2** (envisager `pattern_001_open_cf4dce`) **uniquement** si ≥ 4 lignes GO sur 5 sur **au moins 2 runs** consécutifs **et** amélioration ou neutralité acceptable sur min-trades / delta.

---

## 7. Résumé mental GO / NO-GO (2 runs)

**GO** si, sur **2 runs** :

- la policy **matche** réellement les bons parents (`applications[]` peuplé, bons `parentSetupId`) ;
- **pas** de stérilité visible (volume / tentatives) ;
- **FAR** hotspots en **baisse** ou **stable** (pas dégradation concertée) ;
- delta **stable** ou un peu **mieux** ;
- diversité **non** dégradée.

**NO-GO** si **un** des cas :

- `applications[] === 0` ;
- `warning` policy / fichier invalide ;
- chute **claire** du volume enfant / tentatives ;
- hausse **nette** du FAR sur les parents ciblés ;
- concentration famille qui **empire** ;
- delta **plus négatif** sans bénéfice latéral visible.

---

## 8. Phase 2 (hors Phase 1 par défaut)

- **Ne pas** toucher à `pattern_001_open_cf4dce` tant que Phase 1 n’a pas validé **≥ 2 runs propres** avec amélioration ou neutralité acceptable (§6–§7).
- Quand GO : lecture séparée de la branche `familyexp_…pattern_001_open_cf4dce…` ; ajouter la règle depuis `mutation_hotspot_policy.example.json` (patch léger), puis itérer sur fichier.

---

## 9. Hors scope (inchangé sur cette validation)

- Logique wildcard, tie-break, `minDelta`
- `minTradesAbsolute`, `minTradesRatio` (meta)

Tant que les candidats restent **trop proches** du champion (`deltaVsChampion === 0`), modifier le tie-break **promouvrait du quasi-égal** — à éviter avant preuve d’écart matériel amont.
