# Portfolio (P6)

## `portfolioGovernor.js`

- **Entrées** (sous `discovery/`) : `governance_mini_report.json` (optionnel), `supervisor_config.json`, `meta_ranking.json`, `strategy_portfolio.json`, `mutation_policy.json` (optionnel, tracé dans `decisionInputs`).
- **Sorties** : `portfolio_governor.json`, `portfolio_governor_history.json` (append).
- **Observabilité** : une ligne `[Governor metrics]` par run (`console.log` + append `governance/governor_metrics_events.log`) — agrégation `governor_metrics.json` / alertes `governor_alerts.log` via `engine/observability/governorMetrics.js` (rafraîchi au build dashboard P8).
- **CLI** : `node engine/portfolio/portfolioGovernor.js`
- **Smoke** : `node engine/scripts/smokePortfolioGovernor.js`
- **E2E DATA_ROOT** : `node engine/scripts/validateP6EndToEnd.js` (option `--relax-supervisor` pour chemin normal si le cycle est invalide côté seuils prod)

### DEGRADED sans mini rapport

Si `governance_mini_report.json` est absent ou sans `governanceStatus`, le governor peut passer en **DEGRADED** dès qu’au moins **N** signaux sont présents (`PORTFOLIO_GOVERNOR_DEGRADED_MIN_SIGNALS`, défaut `1`) :

- `invalidResultRatio >= SUPERVISOR_MAX_INVALID_RATIO * PORTFOLIO_GOVERNOR_DEGRADED_IR_FRACTION` (fraction défaut `0.55`)
- `supervisor.fallbackApplied === true`
- `family_expansion_report.json` : `files_written === 0` et `leaders_selected > 0`

Si le mini rapport indique explicitement `governanceStatus: OK`, ces heuristiques ne **remplacent** pas le mini (statut OK conservé).

Ordre pipeline : **supervisor → portfolio governor → `buildPromotedChildren`** (`runFullPipelineExpanded.sh`).
