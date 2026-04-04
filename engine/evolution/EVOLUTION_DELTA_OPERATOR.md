# Evolution Δ (delta) — lecture opérateur

**Purpose (EN)**  
Strict operator definition of **`delta`** in `champion_registry.json` → `metadata.delta`, aligned with **`strategyEvolution.js`**.  
**Not** a trading edge, PnL, or OOS claim — **internal lab coherence** only.

**Code source** : `engine/evolution/strategyEvolution.js` — `buildRegistryEntries` (`momentumMetaScore`), `buildEvolutionMetadata` (moyennes), puis calcul de `deltaMeta` avant écriture du registry.

**Voir aussi** : `CHAMPION_SNAPSHOT_LEGEND.md`, `WILDCARD_PROMOTION_PASS.md`, `AUDIT_EMERGENCE_BLOCKING.md` (plan d’audit goulot exploration / scoring / seuils), `engine/governance/EVOLUTION_SUMMARY_SCHEMA.md` (section *Related: metadata.delta* — Δ vit dans le registry, pas dans l’objet `evolutionSummary`).

---

## Définition stricte de Δ (delta)

```
delta = avgChampionMomentum − avgValidatedMomentum
```

**Où :**

- **`momentumMetaScore`** (par setup)  
  - tire les `meta_score` **nightly** (`meta_score` ou `raw.meta_score`) ;  
  - si **`nightsInHistory >= 4`** et la pondération est calculable → **moyenne pondérée** (poids ∝ **(i+1)³**, **i = 0** = nuit la plus **ancienne** → biais fort **récent**) ;  
  - sinon → **moyenne simple** des `meta_score` sur l’historique (`avgMetaScore`).

- **`avgChampionMomentum`**  
  = moyenne des `momentumMetaScore` des entrées avec **`status === 'champion'`** (valeurs finies seulement).

- **`avgValidatedMomentum`**  
  = moyenne des `momentumMetaScore` des entrées avec **`status === 'validated'`** (valeurs finies seulement).

- **Arrondi** : moyennes et **delta** arrondis à **6 décimales** dans le metadata.

---

## Ce que Δ mesure réellement

Un **écart moyen de méta-score (lab)** entre la cohorte **champions** et la cohorte **validated**.

- **Δ > 0** → en moyenne, les champions ont un `momentumMetaScore` **plus élevé** que les validated (sur la définition ci-dessus, récent-biaisée si assez de nuits).
- **Δ < 0** → l’inverse.

👉 Comparaison **relative interne au lab**, pas une mesure de **performance marché**.

---

## Ce que Δ **ne** mesure **pas**

Δ **ne** représente **pas** :

- PnL réel (paper ou live)  
- edge de trading exploitable  
- robustesse out-of-sample  
- coûts réels (slippage, exécution, etc.)

👉 Δ est un indicateur de **cohérence interne** du pipeline evolution / ranking lab, **pas** un signal économique.

---

## Nature du signal

- **Biais récent** si historique suffisant (≥ 4 nuits, pondération cubique).  
- **Dépendant** de la définition et de la qualité de **`meta_score`** (définie en amont des nightly runs).  
- **Moyenne de population** — pas le score d’un setup isolé.  
- **Sensible** à la **composition** des cohortes (qui est champion vs validated, tailles, exclusions éventuelles).

---

## Lecture opérateur (3 niveaux)

### Δ non exploitable (même au sens “lab structure”)

- signe **instable** (flip fréquent run à run) ;  
- **spike isolé** (ex. gros saut ponctuel puis retour) ;  
- amplitude **proche de 0** sans contexte (peu de séparation signal / bruit numérique) ;  
- **non confirmé** par wildcard, diversité, learning paper (quand applicable).

### Δ à surveiller

- **tendance** qui se **stabilise** (signe et ordre de grandeur) ;  
- **variance** des métriques satellite en **baisse** ;  
- **cohérence** avec la structure des champions (familles, pas de monoculture forcée) ;  
- pas encore **robuste** à des découpes temporelles / sous-ensembles d’expériences.

### Δ potentiellement “substantiel” (toujours **lab-level**)

Conditions **minimales** (indicatives, pas automatiques) :

- **persistance** sur **plusieurs** runs ;  
- **stabilité** du signe ;  
- **robustesse** à un découpage temporel ou à des sous-ensembles raisonnables ;  
- **cohérence** avec au moins une partie de :  
  - wildcard **> 0** (promotions réelles, **répétées** si possible) ;  
  - **diversité** des champions / familles ;  
  - learning paper : **≥ 3** stratégies éligibles, best/worst **stables** dans le temps.

👉 Même ici : **pas** un signal de trading — au mieux un signal que **la structure lab** (champions vs validated) **s’aligne** avec d’autres couches.

---

## Cas typique (illustratif)

**Δ ≈ -0.0035** stable, **`wildcardPromotions = 0`**, champions stables, learning paper **non informatif** (N faible, pas de ranking).

**Lecture prudente** : le système **sélectionne**, mais la moyenne des champions **ne dépasse** pas celle des validated sur `momentumMetaScore` → **pas d’avantage structurel détecté** dans **cette** métrique, **cohérent** avec wildcard inactif et validated potentiellement “forts” non promus (voir doc wildcard).

**Cohérent aussi avec** : `wildcardCandidatesSeen > 0` et `wildcardPromotions = 0` → filtres actifs, rien ne passe les barres.

---

## Interprétation avancée (prudente)

**Δ < 0** stable **peut** aller de pair avec :

- sélection **conservatrice** ;  
- validated **élevés** en meta non promus ;  
- seuils de promotion / wildcard **stricts** ;  
- wildcard **inactif** ou bloqué (famille, delta min, caps).

👉 Toujours **croiser** avec les champs `wildcard*` et la légende snapshot.

---

## Règle opérateur clé

**Δ seul ne fonde jamais une décision.**

Toujours lire Δ avec :

1. **wildcard** (candidats vus, promotions réelles, raisons de blocage) ;  
2. **diversité** (familles, concentration) ;  
3. **learning paper** (cohorte, N, ranking exploitable ou non) ;  
4. **stabilité temporelle** (série de registries / logs).

---

## Résumé en une phrase

**Δ** mesure si les **champions** sont en **moyenne** “meilleurs” que le pool **validated** selon le **méta-score lab récent-biaisé** — **sans** prouver un **edge de trading**.

---

## Piste ultérieure (hors scope immédiat)

Enrichir la lecture au-delà des **moyennes** : distribution des `meta_score` / `momentumMetaScore` (**variance**, asymétrie, queues), pour détecter une **dominance** masquée par une moyenne plate — **à traiter** avec la même discipline (pas d’over-interprétation).
