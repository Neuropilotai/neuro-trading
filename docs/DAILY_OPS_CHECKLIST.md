# Daily Ops Checklist (~2 min)

But : vérifier la **chaîne signal → ordre → fill → PnL corrélé** sans se perdre dans les dashboards.  
Sources typiques : `ops-snapshot/execution_status.json`, `ops-snapshot/latest.json`, `ops-dashboard`, et ton runbook evolution / `run_health` selon ton déploiement.

### Alerting (optionnel, sans ouvrir le dashboard)

Après `exportOpsSnapshot` (ou en cron) :

```bash
cd neuropilot_trading_v2
npm run ops:alerts
```

- Premier run : écrit seulement `governance/ops_alert_checkpoint.json` (baseline).
- Runs suivants : compare `execution_status.json` + `run_health.json` au checkpoint ; **stderr** sur incidents (degraded, nouveau drift, `staleDataHardFail`, hausse `unmatchedFillsCount`).
- Webhook optionnel : `NEUROPILOT_OPS_ALERT_WEBHOOK_URL` (corps JSON type Slack `{ "text": "..." }` ; Discord : `NEUROPILOT_OPS_ALERT_WEBHOOK_DISCORD=1`). **Ne jamais** commiter l’URL.
- Sortie non nulle optionnelle si alerte : `NEUROPILOT_OPS_ALERT_EXIT_ON_ALERT=1`.
- Messages : préfixe **`CRIT` / `WARN` / `INFO`**, code stable (`reconciliation_degraded`, `drift_flag_new`, `stale_data_hard_fail`, `unmatched_fills_increase`) — exploitable par grep / playbooks.
- Chaque alerte expose **`severity`** (`crit` \| `warn` \| `info`) et, pour compat, **`level`** (`critical` \| `warn` \| `info`). Préférer `severity` pour le nouveau code.

Détail : `engine/execution/opsAlerts.js`.

---

## 1. Reconciliation (vérité broker)

- `reconciliationHealthy` = true
- `reconciliationDegraded` = false
- `driftFlags` :
  - **nouveau** → investiguer
  - **récurrent** → documenter (et corriger ou accepter explicitement)

**Règle :** si `reconciliationDegraded` → **pas d’augmentation de taille** (size).

---

## 2. Corrélation (qualité du système)

- `periodPnlSource` = `correlated_fills` lorsqu’il y a de l’activité corrélée
- Ratio : `periodPnlMatchedCount` / `periodPnlFillsCount` (si `fillsCount` = 0, ratio N/A)
- `unmatchedFillsCount`

**Règle :** le ratio peut être &lt; 80 % **si la cause est comprise** (fills manuels, historique sans `clientExtensions`, etc.). Ce qui compte : **tendance à la hausse** dans le temps sur les **nouveaux** ordres tagués.

---

## 3. Data freshness

- `staleDataHardFail` = false (ou équivalent dans ton pipeline / `run_health`)
- Datasets critiques (ex. XAU, BTC selon ton manifest) : âge / dernière bougie connue

**Règle :** stale **acceptable** seulement si **cause connue** (ex. marché fermé, fenêtre attendue). Sinon → **incident**.

---

## 4. Execution state

- Mode : `paper` / `shadow` / `live`
- `NEUROPILOT_KILL_SWITCH` : état **consciemment** choisi (on ou off)
- Erreurs broker récentes (`lastError`, événements d’exécution)

**Règle :** erreur **répétée** → pas d’escalade (taille / stratégies) tant que la cause n’est pas traitée.

---

## 5. Log (le plus important)

**Une seule ligne par jour :**

- `RAS`  
**ou**
- `Incident : <quoi> → Action : <quoi>`

Exemples :

- `reconcile_failed → no size increase`
- `unmatched_fills ↑ → vérifier clientExtensions / ordres récents`
- `data stale XAU → refresh dataset / runbook`

C’est ce journal qui construit la **preuve** (audit, investisseur, toi-même dans 6 mois).

---

## Daily log

Copier le bloc ci-dessous chaque jour (fichier séparé, Notion, ou suite de ce document).

```text
YYYY-MM-DD:
- Status: RAS | INCIDENT
- Notes:
- Action:
```

### Exemple

```text
2026-03-23:
- Status: RAS
- Notes: reconciliationHealthy, periodPnlSource correlated_fills, 3/3 matched today
- Action: —
```

```text
2026-03-24:
- Status: INCIDENT
- Notes: reconciliationDegraded après timeout OANDA read
- Action: pas d’augmentation size; relancer runBrokerReconciliation; si répété, kill switch review
```

---

## Rappel

- **80 % matched** = objectif de process, **pas** un blocage absolu : expliquer l’écart + montrer l’amélioration.
- Ne pas confondre : **PnL période corrélé** (`periodPnlCorrelated`) vs **unrealized** broker (`livePnlApprox`) vs **PL lifetime compte** — trois vues distinctes.
