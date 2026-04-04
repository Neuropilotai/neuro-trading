# Snapshots d’audit (générés localement)

Fichiers JSON produits par redirection, ex. :

```bash
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation \
  node engine/meta/auditChildMinTradesByParent.js > engine/meta/audit_outputs_prod/run.json
```

**Ne pas committer** par défaut (données volumineuses / spécifiques machine). Le dossier est ignoré par git.
