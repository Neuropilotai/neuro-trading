# Runbook — couvrir les promus restants (fenêtre marché 7j)

**But.** Faire baisser **`promoted_not_seen_in_paper_last_7d`** (idéalement vers **0**) sans casser le paper engine, le strict mapping ni la logique de convergence actuelle.

**Principe.** Tant que `promoted_not_seen_in_paper_last_7d` baisse (ou que `promoted_and_paper_recent` tient / monte), la boucle est saine. Si ça stagne sur plusieurs cycles malgré replay + alignement, auditer les setups restants (signaux, données, mapping).

---

## 1. Métriques à suivre (prioritaires)

| Métrique | Où la lire |
|----------|------------|
| `promoted_and_paper_recent` (count) | Checkpoint `--json` → `metrics.promoted_and_paper_recent_count`, ou longueur du tableau dans `paper_trades_strict_mapping_report.json`. |
| `promoted_not_seen_in_paper_last_7d` (count) | Idem → `metrics.promoted_not_seen_in_paper_last_7d_count`. |
| `top_recent_promoted_setups` | Sortie analyse / snapshot ops (selon ton export). |

**Critères de succès**

- **Complet :** `promoted_and_paper_recent` = taille attendue de l’univers promu récent (ex. **8** si 8 promus cibles) **et** `promoted_not_seen_in_paper_last_7d` = **0**.
- **Partiel acceptable :** overlap stable ou en hausse **et** les restants **identifiés** comme non couverts pour une raison structurelle (pas de signal, pas de candles, mismatch durable documenté).

---

## 2. Préconditions (variables d’environnement)

Depuis `neuropilot_trading_v2`, définir au minimum (sauf si vous utilisez le script shell, qui applique des valeurs par défaut documentées dans son en-tête) :

```bash
export NEUROPILOT_DATA_ROOT="/path/to/data"   # ex. /Volumes/TradingDrive/NeuroPilotAI

export NEUROPILOT_PAPER_EXEC_V1=1
export NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY=1
export NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY=1
export NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D=1
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN=20
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN=5
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP=3
export NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN=1
```

Les détails des flags sont dans `engine/governance/runPaperExecutionV1.js` (en-tête).

---

## 3. Boucle canonique (une itération)

### Étape 1 — run paper réel

```bash
node engine/governance/runPaperExecutionV1.js
```

### Étape 2 — vérifier replay + alignement marché

```bash
jq '{writtenAt,effectiveAppended,promotedReplayBypassEnabled,promotedReplayBypassCount,promotedReplayRecentMarketAlignEnabled,promotedReplayRecentAlignmentCount}' \
  "${NEUROPILOT_DATA_ROOT}/governance/paper_exec_v1_last_run.json"
```

**Attendu (typique quand la config ci-dessus est active)**

- `promotedReplayBypassEnabled`: `true`
- `promotedReplayBypassCount` > `0`
- `promotedReplayRecentMarketAlignEnabled`: `true`
- `promotedReplayRecentAlignmentCount` > `0`

### Étape 3 — recalcul strict mapping

```bash
npm run analyze:paper-by-setup
```

*(Réécrit `governance/paper_trades_strict_mapping_report.json` et l’analyse JSON associée.)*

### Étape 4 — checkpoint

```bash
npm run governance:promoted-recent-checkpoint -- --json
```

**Champs à suivre :** `metrics.promoted_and_paper_recent_count`, `metrics.promoted_not_seen_in_paper_last_7d_count`, `verdict`, `strictMappingStaleVsLastRun`.

Si `strictMappingStaleVsLastRun` est `true`, les compteurs overlap peuvent être **périmés** tant que l’étape 3 n’a pas été rejouée après le paper run.

### Étape 5 — tendance

```bash
npm run governance:promoted-convergence-trend
```

### Étape 6 — propagation dashboard / ops

```bash
node engine/evolution/scripts/exportOpsSnapshot.js
```

---

## 4. Script exécutable (recommandé opérationnel)

Même logique que ci-dessous, avec `set -euo pipefail`, echo des variables effectives, et résumé `jq` final (overlap + `joinDiagnostics.recent_7d`).

```bash
chmod +x engine/governance/run_promoted_paper_7d_loop.sh
bash engine/governance/run_promoted_paper_7d_loop.sh
# ou
npm run governance:promoted-paper-7d-loop
```

**Data root :** le script définit par défaut `NEUROPILOT_DATA_ROOT` à `/Volumes/TradingDrive/NeuroPilotAI` si non défini. Sur une autre machine, **exportez** explicitement `NEUROPILOT_DATA_ROOT` avant de lancer.

Source : `engine/governance/run_promoted_paper_7d_loop.sh`.

---

## 5. Séquence complète (un bloc copier-coller)

Adapter `NEUROPILOT_DATA_ROOT` si besoin.

```bash
cd /path/to/neuro-pilot-ai/neuropilot_trading_v2

export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
export NEUROPILOT_PAPER_EXEC_V1=1
export NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY=1
export NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY=1
export NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D=1
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN=20
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN=5
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP=3
export NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN=1

node engine/governance/runPaperExecutionV1.js
jq '{writtenAt,effectiveAppended,promotedReplayBypassEnabled,promotedReplayBypassCount,promotedReplayRecentMarketAlignEnabled,promotedReplayRecentAlignmentCount}' \
  "${NEUROPILOT_DATA_ROOT}/governance/paper_exec_v1_last_run.json"
npm run analyze:paper-by-setup
npm run governance:promoted-recent-checkpoint -- --json
npm run governance:promoted-convergence-trend
node engine/evolution/scripts/exportOpsSnapshot.js
```

---

## 6. Règle de décision après chaque cycle

| Cas | Signes | Action |
|-----|--------|--------|
| **A — progrès** | `promoted_not_seen_in_paper_last_7d` baisse ; `promoted_and_paper_recent` stable ou monte | Continuer la même boucle. |
| **B — stagnation** | `promoted_not_seen` stable (ex. 4) sur **plusieurs** cycles ; replay + align > 0 mais pas de mouvement overlap | Auditer **chaque** setup restant (signaux, manifest, `paper_exec_seen_keys`, datasets). |
| **C — régression** | `promoted_and_paper_recent` redescend **ou** `verdict` sort de **OK** / tendance négative | Stopper l’escalade ; relire `paper_exec_v1_last_run.json` + strict mapping ; vérifier fraîcheur analyse vs last run. |

---

## 7. Contrôle rapide strict mapping (jq)

Les compteurs canoniques pour l’overlap **7j** sont dans le rapport strict :

```bash
jq '{
  promoted_and_paper_recent: (.promoted_and_paper_recent | length),
  promoted_not_seen_in_paper_last_7d: (.promoted_not_seen_in_paper_last_7d | length)
}' "${NEUROPILOT_DATA_ROOT}/governance/paper_trades_strict_mapping_report.json"
```

Diagnostics de jointure (promu ↔ paper) : fichier d’analyse complet :

```bash
jq '.joinDiagnostics' "${NEUROPILOT_DATA_ROOT}/governance/paper_trades_by_setup_analysis.json"
```

> **Note.** Le résumé console de `analyze:paper-by-setup` affiche aussi `strictMappingCounts` et `joinDiagnostics` ; ce bloc est sur **stdout**, pas nécessairement recopié tel quel dans un JSON fichier. Pour des requêtes reproductibles, préférer les fichiers ci-dessus.

---

## 8. Horizon raisonnable

Avec `MAX_PER_RUN=20`, `MAX_SETUPS_PER_RUN=5`, `MAX_BARS_PER_SETUP=3`, quelques cycles propres suffisent pour voir soit la **convergence**, soit le fait que des promus sont **structurellement** non couverts (pas de signal, pas d’historique, clés non joignables).

Ne monter les plafonds qu’après diagnostic (risque de bruit métrique).

---

## 9. Diagnostic ciblé (stagnation cas B)

Pour chaque entrée de `promoted_not_seen_in_paper_last_7d` :

1. Présence dans `paper_execution_v1_signals.json` (ou chemin équivalent).
2. `paper_trades_strict_mapping_report.json` : mismatch `setupId` / `strategyId`.
3. `governance/paper_exec_seen_keys.json` : throttle persistant légitime vs blocage.
4. Couverture dataset (symbole / timeframe) pour le simulateur.

---

## 10. Interdits (non-régression)

- Ne pas désactiver le promotion guard ni les validations WF pour « forcer » le paper.
- Ne pas utiliser `paper_learning_insights.json` comme politique moteur (observabilité seule).
- Ne pas augmenter les quotas replay sans borne ni sans cause identifiée.

---

## 11. Fichiers de référence

| Sujet | Fichier |
|-------|---------|
| Paper + replay promu | `engine/governance/runPaperExecutionV1.js` |
| Checkpoint | `engine/governance/checkPromotedRecentCheckpoint.js` |
| Boucle shell + jq fin de run | `engine/governance/run_promoted_paper_7d_loop.sh` · `npm run governance:promoted-paper-7d-loop` |
| Analyse / strict report | `engine/governance/analyzePaperTradesBySetup.js` |
| Tendance | `engine/governance/trackPromotedConvergenceTrend.js` |
| Chaîne refresh optionnelle | `engine/governance/runPaperDataRefreshChain.js` |

---

**Version.** 1.4 — fin de script : `OPERATOR_LOOP_STATUS` (`HEALTHY_PROGRESS` | `STABLE_OK` | `STAGNATING` | `REGRESSION`) dérivé du checkpoint relu après tendance + export, plus une ligne JSON compacte (`verdict`, compteurs, `delta`).
