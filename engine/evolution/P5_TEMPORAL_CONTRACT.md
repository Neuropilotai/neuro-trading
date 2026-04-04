# P5 — Contrat temporel (mutation policy vs mini report)

## Comportement actuel (Option A — **documenté, stable**)

Dans `engine/scripts/runFullPipelineExpanded.sh`, **P5** (`adaptMutationPolicy.js`) s’exécute en **étape 3.6**, **avant** le **Research Supervisor** (3.7) et **avant** la génération du **governance mini report** final de fin de run (8.5).

Conséquence : au moment où `mutation_policy.json` est écrit pour ce cycle pipeline, le fichier lu par P5 :

- `discovery/governance_mini_report.json`

est en pratique celui du **run / cycle précédent** (ou absent au tout premier run), **pas** le mini qui sera produit à la fin du pipeline en cours.

**Ce n’est pas un bug implicite : c’est un contrat intentionnel tant qu’il reste documenté** : P5 adapte les poids de mutation à partir de la **gouvernance constatée au dernier mini report archivé**, puis le cycle courant produit supervisor → governor → … → nouveau mini.

## Option B (non implémentée)

Pour que P5 consomme le **même** état de cycle que le supervisor courant (mini + signaux alignés N), il faudrait **réordonner** le pipeline (ex. exécuter P5 **après** supervisor / mini intermédiaire, ou après une étape qui matérialise `supervisor_config.json` + décision de risque sans le mini final). Tout réordonnancement doit être **explicite** et revérifié (registry, expansion, governor).

## Fichiers concernés

| Fichier | Rôle |
|---------|------|
| `engine/evolution/adaptMutationPolicy.js` | Lit `governance_mini_report.json` comme `previousGovernance` ; **P7 Health Guard V1** (optionnel) : `NEUROPILOT_ENABLE_P7_HEALTH_GUARD=true` → lit `governance/p7_metrics.json` (`lastAlertReason`) pour skip / atténuer l’apply trend sur les poids mutation — contrat `engine/governance/P7_HEALTH_GUARD_V1.md` |
| `engine/scripts/runFullPipelineExpanded.sh` | Ordre 3.6 (P5) puis 3.7 (supervisor) |
| `engine/scripts/generateGovernanceMiniReport.js` | Écrit le mini **courant** en fin de pipeline |

## cycleId & chaîne machine (Option A)

- **`cycleId`** : identifiant stable du cycle pipeline, **aligné sur `experimentId`** pour le run courant (voir aussi `NEUROPILOT_CYCLE_ID` exporté avec `EXPERIMENT_ID` dans `runFullPipelineExpanded.sh`).
- **`governance_mini_report.json`** : inclut `cycleId` (même valeur que `experimentId` quand présent).
- **`governance/last_completed_cycle.json`** : écrit **à la fin** de `generateGovernanceMiniReport.js` avec `{ cycleId, completedAt }` — c’est le **dernier cycle scellé**.
- **Assertion P5** (`assertP5MiniMatchesLastCompleted` dans `engine/governance/cycleContext.js`) : si `last_completed_cycle.json` **et** le mini on-disk ont un `cycleId`, ils **doivent être égaux**. Sinon → **throw** (mini observé ≠ dernier cycle scellé).  
  - Bootstrap : pas de fichier seal → pas d’assert.  
  - Legacy : mini sans `cycleId` → pas d’assert (jusqu’à régénération du mini).  
  - Secours : `NEUROPILOT_SKIP_CYCLE_P5_ASSERT=true` — **break-glass uniquement** (pas en prod nominale ; journaliser toute utilisation).

**Observabilité** : `adaptMutationPolicy.js` émet une ligne `console.log` **à préfixe figé** `[P5 cycle]` (ne pas le renommer — contrat grep). Champs : `currentCycleId`, `lastCompletedCycleId`, `miniCycleId_prior`, `chainAssert=(ok|mismatch_will_throw|skipped_no_seal|skipped_legacy_mini)`. Exemple audit : `grep '\[P5 cycle\]'` sur la sortie du run.

**Persistance V1** : la même ligne est appendée sous `governance/p5_cycle_events.log` (préfixe horodatage ISO). `engine/observability/p5Metrics.js` agrège → `governance/p5_metrics.json` ; anomalies uniquement → `governance/p5_alerts.log`. Le dashboard P8 (`buildGovernanceDashboard.js`) expose `p5Health` dans `governance_dashboard.json`.

Propagation aussi dans : `mutation_policy.json` (`cycleId`), `portfolio_governor.json` / historique (`cycleId`), `run_trend_memory.json` (`producingCycleId`).

## Vérification opérationnelle

- Après un run complet, comparer les **horodatages** : `mutation_policy.json` (étape 3.6) vs `governance_mini_report.json` (8.5) — le mini le plus récent est **postérieur** à la policy du même run.
- Vérifier `governance/last_completed_cycle.json` = `cycleId` du dernier mini généré.
- Le **Pass 2** (`validationPackPass2.js`) valide la logique P5/P6/P7.1 dans un root isolé ; il ne remplace pas une relecture d’ordre du shell de prod.
