# Alignement `NEUROPILOT_DATA_ROOT` (critique)

## Problème typique

- **Paper Execution** / pipeline écrivent `governance/paper_trades.jsonl` sous **`$NEUROPILOT_DATA_ROOT`**.
- **`buildGovernanceDashboard.js`** lit le **même** `governance/paper_trades.jsonl` via `dataRoot.getDataRoot()`.

Si tu lances le dashboard **sans** la même variable que le pipeline (ex. trades sur `/Volumes/TradingDrive/...` mais dashboard sur `data_workspace/`), tu obtiens **`validTradeCount: 0`**, métriques V2 vides, **learning insights non fiables**.

## Règle

**Une seule source de vérité** : exporte explicitement avant pipeline, paper exec, et dashboard :

```bash
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI   # ou ton chemin
```

Puis :

```bash
node engine/governance/buildGovernanceDashboard.js
jq '.paperTradesMetrics.validTradeCount' ops-snapshot/governance_dashboard.json
```

## Script `run-10-cycles.sh`

Si `NEUROPILOT_DATA_ROOT` n’est pas défini, le script choisit **le volume externe** s’il est monté, sinon `data_workspace/` local — toujours avec un message `[INFO]` pour savoir quel root est utilisé.

## Vérification rapide

```bash
# Où sont les trades ?
wc -l "${NEUROPILOT_DATA_ROOT:-$PWD/data_workspace}/governance/paper_trades.jsonl"
```

Doit correspondre au répertoire que le dashboard utilise au moment du build.
