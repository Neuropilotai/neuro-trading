# Validation pack — NeuroPilot governance / P5–P8.1

Objectif : **ne pas mélanger** UI, gouvernance, P7.1, pipeline et artefacts dans un seul diagnostic. Trois passes :

| Passe | But | Outil principal |
|--------|-----|-----------------|
| **1 — Smoke fonctionnel** | Tout démarre, bons artefacts / sorties | `run_validation_pack.sh` |
| **2 — E2E contrôlé** | Chemins critiques par scénario | Commandes ci-dessous + smokes déjà ciblés |
| **3 — Audit « mega prompt »** | Architecture, contrats JSON, angles morts | **Après** 1 + 2, avec sorties réelles |

---

## Pass 1 — Smoke (automatisable)

### Commande

Depuis `neuropilot_trading_v2` :

```bash
./engine/governance/run_validation_pack.sh
```

Sans fichiers discovery sur le workspace (clone frais) :

```bash
./engine/governance/run_validation_pack.sh --skip-workspace-checks
```

Ou directement :

```bash
node engine/governance/validationPackSmoke.js
node engine/governance/validationPackSmoke.js --skip-workspace-checks
```

### Ce qui est vérifié (sans `--skip-workspace-checks`)

Sous `NEUROPILOT_DATA_ROOT` (sinon `data_workspace/` local) :

- `discovery/governance_mini_report.json` — présent, JSON, clés `experimentId`, `governanceStatus`
- `discovery/run_trend_memory.json` — `trendMemoryVersion`
- `discovery/portfolio_governor.json` — `governanceStatus`, `experimentId`
- `discovery/mutation_policy.json` — `experimentId`

### Ce qui est toujours exécuté

1. `node engine/evolution/scripts/exportOpsSnapshot.js`  
   - Attendu : `ops-snapshot/latest.json`, `governance_dashboard.json`, `governance_dashboard.html`, etc.
2. Contrôle structure `governance_dashboard.json` (`dashboardVersion`, `lastRun`, `sources`).
3. Smokes **isolés** (répertoires temporaires, pas d’écriture dans le data root) :
   - `engine/scripts/smokePortfolioGovernor.js` — nominal / degraded / blocked
   - `engine/scripts/smokeRunTrendMemory.js` — P7
   - `engine/scripts/smokeTrendMemoryApply.js` — P7.1 conservative + mutations off puis on

**Exit code** : `0` = OK, `1` = échec (message `[validation-pack]` sur stderr).

---

## P5 — Contrat temporel (prod)

Documenté dans **`engine/evolution/P5_TEMPORAL_CONTRACT.md`** : en pipeline étendu, P5 lit le mini report du **cycle précédent** (ordre shell actuel). Toute évolution (Option B : même cycle) = réordonnancement explicite + revalidation.

## Stores JSON gouvernance (fail-fast)

`experiment_registry.json` et `dataset_versions.json` sont lus via **`engine/governance/jsonArtifactStore.js`** :

- Fichier absent → structure vide attendue (pas d’erreur).
- Fichier présent mais vide, JSON invalide, ou schéma incorrect (`experiments` / `versions` pas des tableaux) → **renommage** `*.corrupt.<timestamp>` + **`throw`** (processus exit ≠ 0).

Récupération manuelle / scripts de secours : **`NEUROPILOT_LENIENT_JSON_STORES=true`** rétablit l’ancien repli silencieux vers vide (à n’utiliser qu’en intervention contrôlée).

## cycleId & chaîne P5

- **`engine/governance/cycleContext.js`** : `getCurrentCycleId`, seal `last_completed_cycle.json`, assert P5 (`assertP5MiniMatchesLastCompleted`).
- **Doc** : `engine/evolution/P5_TEMPORAL_CONTRACT.md`.
- **Preuve assert** : `node engine/governance/testCycleP5Chain.js` (ou `npm run test:cycle-p5-chain`).
- **Pass 1** : alignement `cycleId` entre `portfolio_governor.json`, `mutation_policy.json`, `run_trend_memory.json` (`producingCycleId`) lorsque ≥ 2 champs présents (le mini report est exclu — Option A).

**Preuve exécutable (4 cas : absent, JSON invalide, schéma invalide, lenient)** :

```bash
node engine/governance/testJsonArtifactStoreFailFast.js
```

---

## Pass 2 — E2E contrôlé (manuel / CI avancé)

À lancer **quand** tu veux valider le pipeline sur **données réelles**, en séparant les scénarios.

### Commande pack Pass 2 (isolée)

```bash
cd neuropilot_trading_v2
node engine/governance/validationPackPass2.js
```

Rapports générés :

- `ops-snapshot/validation_pass2_report.json`
- `ops-snapshot/validation_pass2_report.md`

| Scénario | Piste | Fichiers / indices à inspecter |
|----------|--------|----------------------------------|
| Nominal | Pipeline complet ou `validateP6EndToEnd.js` | `governance_mini_report.json` OK/PASS, governor `promotionMode` normal, dashboard badges verts |
| Degraded | Mini report DEGRADED ou historique | `portfolio_governor.json`, `decisionReasons`, exposure &lt; 1 |
| Blocked | `cycle_valid: false` ou scénario C smoke P6 | `promotionMode: blocked`, strategies vidées, P7.1 skip raisons |
| P7.1 conservative ON | `TREND_MEMORY_APPLY=true`, mode conservative | `trendMemoryApply` governor, deltas exposure / admission |
| P7.1 mutations OFF puis ON | `smokeTrendMemoryApply.js` ou env | policy `appliedDeltas.skipped` puis poids mutés |

### Script optionnel (mutation workspace)

```bash
cd neuropilot_trading_v2
node engine/scripts/validateP6EndToEnd.js
# ou démo seuils: node engine/scripts/validateP6EndToEnd.js --relax-supervisor
```

⚠️ Ce script **modifie** le workspace (mini report, governor, registry) ; lire l’aide en tête de fichier. Ne pas l’inclure dans Pass 1 sans le vouloir explicitement.

### Check-list rapide après un run réel

- [ ] Badges dashboard alignés avec `governanceStatus` + `verdict`
- [ ] `trendMemoryApply` : applied vs skipped + `reasons` / `skip` explicites
- [ ] `experiment_registry.json` cohérent avec le dernier `experimentId`
- [ ] Pas de changement silencieux (comparer `decisionReasons` / mini report)

---

## Pass 3 — Audit « mega prompt »

À faire **après** Pass 1 (et idéalement un Pass 2 ciblé). Fournir au modèle :

- État **P3 → P8.1** (ce qui est closed / en cours)
- Liste des **fichiers clés** (gouvernance, evolution, dashboard)
- Extraits **JSON réels** (mini report, governor, mutation_policy, run_trend_memory, `governance_dashboard.json`)
- Résumé d’**un run nominal**, **un blocked**, **un P7.1 apply**
- Question finale : **« What can still break? »**

---

## Références rapides

| Sujet | Chemin |
|--------|--------|
| Dashboard P8.1 | `engine/governance/buildGovernanceDashboard.js`, `P8_GOVERNANCE_DASHBOARD.md` |
| Export ops | `engine/evolution/scripts/exportOpsSnapshot.js` |
| P6 smoke 3 cas | `engine/scripts/smokePortfolioGovernor.js` |
| P7 smoke | `engine/scripts/smokeRunTrendMemory.js` |
| P7.1 smoke | `engine/scripts/smokeTrendMemoryApply.js` |
| P6 E2E data root | `engine/scripts/validateP6EndToEnd.js` |
