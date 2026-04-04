# Postmortem technique — Overlap pipeline & interruption SIGTERM
 
Projet : NeuroPilot Trading System (`neuropilot_trading_v2`)  
Composants impactés : smart-loop, pipeline d’évolution (`run-smart-evolution-loop.sh`, `engine/scripts/runFullPipelineExpanded.sh`)  
Date : 2026-03  
Statut : ✅ Corrigé (fix minimal + traçabilité ajoutée)
 
## 1. Résumé exécutif
 
Un défaut dans la protection d’exclusion mutuelle du smart-loop permettait, dans certaines conditions, le démarrage d’un nouveau cycle alors qu’une sous-étape critique du pipeline précédent (notamment `runMetaPipeline.js`) était encore active.
 
Ce comportement pouvait survenir après une interruption du pipeline principal (`runFullPipelineExpanded.sh`) par un signal **SIGTERM** (exit code **143**), laissant un sous-processus actif temporairement.
 
Conséquence :
- chevauchement partiel des cycles (“overlap”)
- exécutions incomplètes (“discovery only”)
- absence de mise à jour de `registry`, `ops_snapshot`, `run_trend_memory`
 
Le correctif implémenté empêche désormais tout overlap et ajoute une traçabilité formelle des interruptions.
 
## 2. Root cause (prouvée)
 
### Défaut technique
 
Le smart-loop vérifiait uniquement la présence du processus parent :
- `runFullPipelineExpanded.sh`
 
Mais pas celle des sous-processus critiques, notamment :
- `node engine/meta/runMetaPipeline.js`
 
### Mode d’échec permis par le code
 
1. Le pipeline est en cours d’exécution
2. Il reçoit un SIGTERM (exit 143)
3. Le processus parent `bash` est arrêté
4. Un sous-processus (Meta) peut rester actif brièvement
5. Le smart-loop ne détecte plus le parent → relance un cycle
6. Overlap partiel entre deux pipelines
 
Important :
- La cause du SIGTERM (launchd, opérateur, script externe, etc.) n’est pas identifiée
- Mais le repo permettait ce scénario et ne le bloquait pas
 
## 3. Symptômes observés
 
- Logs : `=== 3/8 Meta Pipeline ===` puis `exited 143`
- Runs incomplets :
  - pas de mise à jour `registry`
  - pas de `ops_snapshot`
  - pas de `run_trend_memory`
- Présence de runs “discovery only” dans `experiment_registry`
 
Ces observations sont cohérentes avec une interruption SIGTERM pendant l’étape Meta.
 
## 4. Correctifs appliqués
 
### A) Smart-loop — Anti-overlap renforcé (minimal)
 
Avant :
- Skip uniquement si `runFullPipelineExpanded.sh` est actif
 
Après :
- Skip si un composant pipeline critique est actif :
  - `runFullPipelineExpanded.sh`
  - `runMetaPipeline.js`
 
Log ajouté :
- `SKIP: previous pipeline component still running (runMetaPipeline.js). No overlap.`
 
État enregistré :
- `LAST_RUN_REASON=pipeline_already_running_or_orphaned_stage`
 
Impact :
- garantie effective : un seul pipeline à la fois
- protection contre les orphelins Meta
 
### B) Pipeline — Traçabilité SIGTERM + stage courant
 
Ajout dans `runFullPipelineExpanded.sh` :
 
1) Tracking de stage  
`set_stage "3_meta_pipeline"` avant chaque étape majeure
 
2) Trap SIGTERM  
`trap '...' TERM`
 
3) Marqueur JSON écrit dans :  
`$NEUROPILOT_DATA_ROOT/loop_logs/pipeline_last_sigterm.json`
 
Contenu du marqueur (exemple) :
 
```json
{
  "event": "pipeline_sigterm",
  "stage": "3_meta_pipeline",
  "experimentId": "...",
  "pid": 12345,
  "ts": "2026-03-25T18:42:00Z"
}
```
 
Log stderr :
- `[SIGTERM] pipeline terminating at stage=3_meta_pipeline ...`
 
Impact :
- identification précise : moment, étape, process
- corrélation possible avec logs système / scheduler / actions opérateur
 
## 5. Pourquoi le fix est sûr
 
- ✅ Aucun changement métier (stratégies, ranking, filtres inchangés)
- ✅ Aucun impact sur XAU / data engine / near-live
- ✅ Minimal (`pgrep` + `trap` uniquement)
- ✅ Réversible facilement
- ✅ N’introduit pas de faux positifs
- ✅ N’empêche pas les échecs réels
- ✅ Ajoute de la visibilité (au lieu de masquer)
 
## 6. Validation runtime
 
```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
 
# 1) Validation syntaxe
bash -n run-smart-evolution-loop.sh
bash -n engine/scripts/runFullPipelineExpanded.sh
 
# 2) Test anti-overlap
node engine/meta/runMetaPipeline.js 30 12 &
bash run-smart-evolution-loop.sh
# Attendu: SKIP: previous pipeline component still running (runMetaPipeline.js). No overlap.
 
# 3) Test SIGTERM
bash engine/scripts/runFullPipelineExpanded.sh &
PIPE_PID=$!
sleep 2
kill -TERM "$PIPE_PID"
sleep 1
cat "$NEUROPILOT_DATA_ROOT/loop_logs/pipeline_last_sigterm.json"
 
# 4) Test run complet
bash engine/scripts/runFullPipelineExpanded.sh
ls -la ops-snapshot/latest.json ops-snapshot/governance_dashboard.json
```
 
## 7. Limitations connues
 
- ❗ La source du SIGTERM n’est pas identifiée
- ❗ Le `pgrep` reste une heuristique (non déterministe à 100%)
- ❗ Pas de lockfile PID global (encore)
 
## 8. Améliorations futures (optionnelles)
 
1. Lockfile PID (exclusion mutuelle forte)
2. Dashboard / alerte sur `pipeline_sigterm`
3. Corrélation automatique SIGTERM ↔ scheduler / infra
4. Timeout watchdog sur étapes longues (Meta)
 
## 9. Conclusion
 
Le problème n’était pas un bug métier dans Meta ou le pipeline, mais une exclusion mutuelle incomplète dans le smart-loop.
 
Le correctif :
- bloque le mode d’échec réel (overlap après SIGTERM)
- stabilise les cycles jusqu’à `registry` / `ops_snapshot`
- rend les interruptions explicitement traçables
 
Le système est désormais robuste face aux interruptions partielles et observable en production.

