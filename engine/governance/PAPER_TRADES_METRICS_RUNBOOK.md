# Paper trades metrics — runbook opérateur (~30 s)

**Objectif** : décider vite si un run alimente la couche paper et si les chiffres sont **exploitables** (pas “beau dashboard” sans données).

**Prérequis** : un build dashboard récent (`node engine/governance/buildGovernanceDashboard.js` ou export ops) pour que `ops-snapshot/governance_dashboard.json` et `governance/paper_trades_metrics.json` soient à jour.

**CRITIQUE** : utiliser le **même `NEUROPILOT_DATA_ROOT`** que le pipeline et Paper Execution — sinon `validTradeCount` reste à 0 alors que le JSONL est sur un autre disque. Voir `engine/governance/DATA_ROOT_ALIGNMENT.md`.

---

## 1. Trois commandes

```bash
tail -n 5 "${NEUROPILOT_DATA_ROOT:-./data_workspace}/governance/paper_trades.jsonl"
jq '.paperTradesMetrics' ops-snapshot/governance_dashboard.json
jq '.paperTradesMetricsV2 | {byDay: (.byDay|length), byCycle: (.byCycle|length), bestStrategy, worstStrategy}' ops-snapshot/governance_dashboard.json
cat "${NEUROPILOT_DATA_ROOT:-./data_workspace}/governance/paper_trades_metrics_by_day.json" | head -40
jq '.paperLearningInsights | {confidence, safety, suggestions}' ops-snapshot/governance_dashboard.json
./status-system.sh
```

Ligne **`LEARNING: suggestive …`** : insights **non appliqués** — lecture uniquement (`PAPER_LEARNING_INSIGHTS_SCHEMA.md`).

*(Adapter `NEUROPILOT_DATA_ROOT` si ton data root n’est pas le défaut.)*

### Volume & équilibre par stratégie (learning)

Cibles indicatives (multi-signaux actifs) : **50–100** trades JSONL = minimum pour regarder les agrégats ; **200+** = learning moins bruité.

```bash
wc -l "${NEUROPILOT_DATA_ROOT:-./data_workspace}/governance/paper_trades.jsonl"
```

**Dashboard** : `paperTradesMetricsV2.byStrategy` est un **tableau** d’objets (`strategyId`, `trades`, …). Ce n’est **pas** `byStrategy.buckets` (cette forme existe dans l’artefact séparé `governance/paper_trades_metrics_by_strategy.json` sous la clé `buckets`).

```bash
jq '.paperTradesMetricsV2.byStrategy[] | {strategyId, trades, totalPnl}' ops-snapshot/governance_dashboard.json
# équivalent depuis l’artefact V2 :
jq '.buckets[] | {strategyId, trades, totalPnl}' "${NEUROPILOT_DATA_ROOT:-./data_workspace}/governance/paper_trades_metrics_by_strategy.json"
```

**Red flag** : une stratégie avec beaucoup de `trades` et une autre avec très peu → comparaisons / `strategiesToBoost` **biaisées** (volume, pas seulement edge).

---

## 2. Lecture en 20 secondes

| Signal | Interprétation |
|--------|----------------|
| **`validTradeCount` = 0** | Paper exec pas activé, pas de `paper_execution_v1_signals.json`, ou pas encore de lignes valides dans le JSONL. **Normal** tant que V1 est optionnelle. |
| **`parseErrors` > 0** | **À traiter** : JSONL corrompu, lignes hors schéma V1, ou mélange de formats. Voir `governance/paper_trades_alerts.log` et corriger la source / le writer. |
| **`status` = `has_parse_errors`** | Même priorité que parseErrors : la lecture est **peu fiable** jusqu’à nettoyage. |
| **`winRate` / `totalPnl` / `avgPnl`** | Premiers indicateurs de **valeur** (notional 1 unité). Utiles **surtout** comparés run à run (même data root, même signaux). |
| **`byReason`** | `target` vs `stop` vs `time` / `max_bars` : profil de sortie (take-profit touché vs stop vs fin de chemin). |

---

## 3. Verdict rapide (faible / correct / prometteur)

- **Faible** : `parseErrors > 0`, ou trades > 0 mais tout en `time` / `max_bars` avec PnL plat → signal ou fenêtre peu informatifs (ou marché sans mouvement utile).
- **Correct** : `parseErrors = 0`, quelques trades, `byReason` varié, PnL cohérent avec les raisons (ex. plus de `target` que de `stop` si la config est trend-friendly).
- **Prometteur** (à confirmer sur **plusieurs runs**) : série de trades avec `winRate` et `totalPnl` **stables ou en amélioration**, sans dégradation des parse errors — *sans encore* brancher l’apprentissage policy sur le PnL.

---

## 4. Ce que ce runbook ne fait pas

- Ne remplace pas une analyse statistique (taille d’échantillon, période, comparabilité des signaux).
- Ne déclenche **aucun** changement policy / governor (hors périmètre jusqu’à décision produit explicite).

---

## 5. Séquence audit-safe (resserrée) + signal vs bruit

**Source de vérité trades** : `$NEUROPILOT_DATA_ROOT/governance/paper_trades.jsonl` (pas `paper-trades/*.jsonl` dans ce repo).

```bash
wc -l "${NEUROPILOT_DATA_ROOT:-./data_workspace}/governance/paper_trades.jsonl"
jq '.paperTradesMetricsV2.byStrategy' ops-snapshot/governance_dashboard.json
jq '.paperLearningInsights' ops-snapshot/governance_dashboard.json
```

Ne pas masquer l’absence de fichier (`2>/dev/null` sur `wc`) : une **erreur** = signal immédiat (mauvais data root, pipeline, ou paper exec jamais écrit).

### Lecture opérationnelle

1. **Volume (N)**  
   - **Moins de 50** lignes → quasi full bruit pour conclure.  
   - **50–200** → pré-signal, fragile.  
   - **200+** → lecture plus sérieuse (toujours sous réserve d’équilibre par stratégie).

2. **`byStrategy[]`**  
   - Distribution des `trades` (équilibre inter-stratégies).  
   - Cohérence **PnL** vs **winRate** vs **taille d’échantillon**.  
   - **⚠️** Bon PnL + faible N = illusion fréquente.

3. **`paperLearningInsights`** (suggestif, non prescriptif)  
   - `confidence: low` → souvent **problème de données** (volume ou skew), pas forcément un bug de logique.  
   - **Suggestions** : OK si alignées avec les métriques + intuition marché ; **ignorer** si isolées ou contradictoires avec la distribution observée.

### Heuristique terrain (signal vs bruit)

| Condition | Lecture |
|-----------|---------|
| Faible N + forte perf | 🚫 bruit |
| N correct + déséquilibre fort entre stratégies | ⚠️ biais |
| N correct + équilibre + cohérence métriques | ✅ signal potentiel |
| Suggestions sans support métrique | 🚫 ignorer |
| Suggestions + métriques + logique marché alignées | 👀 watchlist (sans mutation tant que non décidé) |

### Règle stricte (audit / institutionnel)

**Aucune** suggestion issue de `paperLearningInsights` ne doit être **appliquée** (policy, mutation, live, changement de signaux) sans **les trois** conditions suivantes :

1. **Volume suffisant** — au minimum le seuil documenté ci-dessus (ex. **≥ 200** trades JSONL pour une lecture sérieuse du global ; par stratégie, exiger un **N par `strategyId`** non trivial avant de “croire” le classement).
2. **Cohérence avec les métriques** — la suggestion doit être **vérifiable** dans `paperTradesMetricsV2.byStrategy[]` (trades, PnL, winRate) ; sinon = **non actionnable**.
3. **Validation manuelle explicite** — **human-in-the-loop** : une personne confirme l’alignement données + intuition marché + risque, **hors** du pipeline automatisé.

Objectif : éviter l’**auto-optimisation silencieuse**, le **biais de confirmation**, et les dérives si d’autres agents ou scripts modifient le système. **Learning = input de décision, pas décision.**

---

## 6. Suite logique (hors ce document)

Agrégation **par jour / par cycle / par `strategyId`** dans les métriques ou un artefact dérivé — pour répondre : *tendance ou bruit isolé ?*

**Références** : `PAPER_EXECUTION_V1_SPEC.md`, `PAPER_TRADES_METRICS_SCHEMA.md`, `P8_GOVERNANCE_DASHBOARD.md`.

---

## 7. Architecture (lecture) — 3 couches

Découplage à préserver pour la stabilité :

| Couche | Rôle | Artefacts typiques |
|--------|------|---------------------|
| **Observation** | faits bruts + agrégats vérifiables | `paper_trades.jsonl`, métriques V1/V2, `byStrategy[]` |
| **Inference** | interprétation suggestive | `paperLearningInsights` (confidence, suggestions) |
| **Decision** | action — **protégée** | validation humaine ; **aucune** mutation / policy / live **sans** §5 « Règle stricte » |

Tant que l’**inférence** ne pilote pas directement l’exécution, le cycle *petite série gagnante → suggestion → mutation → overfit* reste **bloqué structurellement**.

---

## 8. Évolution recommandée — comparaison inter-runs *(pas encore implémentée)*

Quand **N** est solide (**200+**, puis **500+**), ajouter en pratique opérateur (voire outillage plus tard) :

- **Même `strategyId`** (ou même famille de signaux), **périodes / cycles différents**.
- **Conditions comparables** quand c’est traçable (même univers, même data root, même schéma paper).
- **Objectif** : distinguer signal **stable** vs performance **contextuelle** (régime, fenêtre chanceuse).

Sans cette étape, un bon run isolé reste **non prouvé** sur la robustesse temporelle.

### Critères de stabilité inter-runs *(à calibrer quand N le permet — pas d’outil auto requis)*

Repères objectifs à préciser ultérieurement (seuils numériques **TBD**) :

- **Direction du PnL** cohérente sur **fenêtres / cycles indépendants** (pas un seul run « porteur »).
- **Win rate** dans une **plage comparable** d’un run à l’autre — un pic isolé = suspect.
- **Absence de dépendance** à un **sous-échantillon** étroit (quelques trades, un seul symbole actif, une seule fenêtre de marché).

**Lecture cible** : *edge réel* (répété) **vs** *edge contextuel / variance* — sans confondre avec la gouvernance §5 (toute action reste **manuelle**).

**⚠️ Calibrage des seuils (quand tu passeras de TBD à des nombres)** : ne pas choisir des seuils **trop serrés** ni les **optimiser** sur les premières séries observées — sinon tu recrées de l’**overfit au niveau gouvernance**. Préférer des seuils **larges** au départ, puis un **resserrement progressif** avec davantage de données indépendantes dans le temps.

---

## 9. Suivi temporel du learning *(optionnel, recommandé)*

**Lecture opérateur (structure figée)** : pour chaque revue de snapshot, copier / compléter le template **`engine/governance/GOVERNANCE_OPERATOR_SUMMARY_TEMPLATE.md`** (qualitatif uniquement — pas de métriques codées dans le template ; les chiffres viennent du dashboard).

**Objectif** : observer la **stabilité** de `paperLearningInsights` dans le temps (pas seulement un instantané). **Aucune** automatisation ne modifie policy, mutation ou signaux — **observation enrichie** uniquement.

### Snapshot après chaque build (recommandé)

Les copies vivent sous **`$NEUROPILOT_DATA_ROOT/governance/history/`** (même data root que le reste de la gouvernance).

**Option A — script dédié** (après `buildGovernanceDashboard.js`, depuis la racine `neuropilot_trading_v2`) :

```bash
npm run governance:snapshot-history
```

Source par défaut : `ops-snapshot/governance_dashboard.json`. Surcharge : `NEUROPILOT_GOVERNANCE_DASHBOARD_JSON=/chemin/absolu/governance_dashboard.json`.

**Option B — copie shell** :

```bash
mkdir -p "$NEUROPILOT_DATA_ROOT/governance/history"
cp ops-snapshot/governance_dashboard.json \
  "$NEUROPILOT_DATA_ROOT/governance/history/governance_$(date +%s).json"
```

**Option C — hook opt-in sur le build** :

```bash
export NEUROPILOT_GOVERNANCE_HISTORY_SNAPSHOT=1
node engine/governance/buildGovernanceDashboard.js
```

### Lecture delta (manuelle, sans outil lourd)

```bash
jq '.paperLearningInsights' governance_history_old.json > /tmp/pe_insights_old.json
jq '.paperLearningInsights' governance_history_new.json > /tmp/pe_insights_new.json
diff /tmp/pe_insights_old.json /tmp/pe_insights_new.json
```

Regarder : évolution des **suggestions**, du **`confidence`**, apparition / disparition de patterns.

### Interprétation

| Observation | Lecture indicative |
|-------------|-------------------|
| Suggestions **stables**, `confidence` qui **monte** progressivement (avec N suffisant) | Signal de **cohérence** dans le temps |
| Suggestions qui **changent souvent**, classements **flip-flop** entre stratégies | Souvent **bruit** ou instabilité de données — à traiter avant toute décision (§5) |

**Piège** : avec **N élevé** mais **sans** historique, une **instabilité** des insights peut rester **invisible** ; les snapshots rendent les oscillations **visibles**.

**Index léger** : chaque snapshot append une ligne dans **`$NEUROPILOT_DATA_ROOT/governance/history/index.jsonl`** (`governanceHistoryIndexVersion`, `unixEpoch`, chemin relatif depuis data root, **`dashboardVersion`**, **`snapshotSizeBytes`**, `validTradeCount`, `confidence`, `bestStrategyId`, `worstStrategyId`, `dashboardHash` SHA-256, `paperLearningInsightsPresent`, `parseError`). Lister sans ouvrir les gros JSON :

```bash
tail -n 10 "$NEUROPILOT_DATA_ROOT/governance/history/index.jsonl" | jq .
```

**Résumé opérateur** (compte, dernier snapshot, fréquences `bestStrategyId` / **`confidence`** / `dashboardVersion`, queue `validTradeCount`, dernier `snapshotSizeBytes` si présent ; `--json` inclut `meta.sourceJsonPathUsed`) :

```bash
npm run governance:history-index-report
# ou JSON : npm run governance:history-index-report -- --json  (`meta.quickSummaryContractVersion` = même semver que le diff `--json`, pour pipelines index + diff)
```

**Diff entre deux snapshots archivés** (lecture seule, extrait *paperLearningInsights* + métriques paper V1/V2) :

```bash
npm run governance:diff-dashboard-snapshots -- \
  "$NEUROPILOT_DATA_ROOT/governance/history/governance_OLD.json" \
  "$NEUROPILOT_DATA_ROOT/governance/history/governance_NEW.json"
# En-tête humain rapide — **ordre des lignes figé** : `dashboardVersion` → `confidence` → `validTradeCount` → `bestStrategyId` → `worstStrategyId` → `snapshotSizeBytes` (taille fichier, seulement si les deux `stat` OK, toujours en dernier). Puis JSON du slice ; `--no-summary` pour ne garder que les blocs JSON.
# --json : payload structuré + `quickSummaryLines` + `quickSummaryContractVersion` (semver du contrat d’ordre/ sémantique du quick summary) ; exit 2 si slice différent
```

Le rapport d’index inclut aussi **`confidence frequency`** (compte par `low` / `medium` / `high` / `(null)`).

**Vue condensée (derniers K lignes)** — mêmes chemins d’index que le report ; colonnes **fixes** (ordre stable) : `unixEpoch`, `snapshotAtIso`, `dashboardVersion`, `validTradeCount`, `confidence`, `bestStrategyId`, `worstStrategyId`, `snapshotSizeBytes`. **Lecture seule**, pas d’interprétation automatique.

```bash
npm run governance:history-index-condensed
npm run governance:history-index-condensed -- --tail 30
npm run governance:history-index-condensed -- --json --tail 10
# TSV sans ligne d’en-tête (pipes) : --no-header  (ignoré avec --json)
```

Sortie texte : **TSV** (en-tête + lignes par défaut ; `--no-header` = données seules). Sortie `--json` : `condensedIndexContractVersion`, **`columns`** (= même ordre que `CONDENSED_ROW_FIELD_ORDER`), `meta`, `rows` (contrat distinct du quick summary diff ; `columns` = ajout rétrocompatible, pas de bump).

**Vue learning (scan — opérateur)** — même `index.jsonl`, **derniers K** enregistrements ; champs **dénormalisés** au snapshot (cohérents avec le résumé learning : `confidence`, `bestStrategyId`, `worstStrategyId`, `validTradeCount`, `snapshotAtIso`). **Lecture seule** : pas de tendance, score, alerte ni décision automatique.

```bash
npm run governance:learning-scan
npm run governance:learning-scan -- --tail 30
npm run --silent governance:learning-scan -- --json --tail 10
# TSV sans en-tête (pipes) : --no-header  (ignoré avec --json)
```

Sortie TSV : ordre figé `snapshotAtIso`, `confidence`, `bestStrategyId`, `worstStrategyId`, `validTradeCount`. Sortie `--json` : `learningScanContractVersion` (semver), **`columns`**, `meta` (`badLines` si lignes JSONL invalides ignorées), `rows`.

**Vue focus stratégie (scan)** — parmi les **derniers `tail`** enregistrements d’index, ne garder les lignes où **`bestStrategyId` ou `worstStrategyId`** est **strictement égal** à `--strategy` (même projection TSV / `rows` que le learning-scan ; contrat JSON distinct : `strategyFocusScanContractVersion`). **Obligatoire** : `--strategy <id>`. Aucune interprétation automatique.

```bash
npm run governance:strategy-focus-scan -- --strategy s_orb2
npm run governance:strategy-focus-scan -- --strategy s_orb2 --tail 50
npm run --silent governance:strategy-focus-scan -- --strategy s_orb2 --json --tail 30
# TSV sans en-tête : --no-header  (ignoré avec --json)
```

`meta` inclut notamment `strategyId`, `windowRowCount` (taille de la fenêtre `tail`), `rowCount` (lignes après filtre).

**Vue learning (window stats)** — sur les **derniers `tail`** enregistrements d’index : **compteurs bruts** pour `confidence`, `bestStrategyId`, `worstStrategyId` (aucun score, seuil ni tendance). En JSON, chaque map est triée par **effectif décroissant**, puis **clé ascendante** (`localeCompare` `en`). `counts.confidence` inclut toujours `low`, `medium`, `high`, `(null)` (0 si aucune occurrence). Contrat : `learningWindowStatsContractVersion`.

```bash
npm run governance:learning-window-stats
npm run governance:learning-window-stats -- --tail 50
npm run --silent governance:learning-window-stats -- --json --tail 30
```

**Rétention** : pas d’outil de purge automatique — voir `engine/governance/GOVERNANCE_HISTORY_RETENTION.md`.

**Pipe `jq` / scripts** : `npm run` écrit des lignes banner sur **stdout** avant le JSON → `| jq` casse. Utiliser **`npm run --silent governance:… -- --json`** ou **`node engine/governance/<script>.js --json`** pour une sortie JSON seule. Les scripts Node en `--json` n’ajoutent pas de bannière ; le bruit vient surtout de **npm** sans `--silent`. Smoke : `npm run test:governance-history-json-pipe-smoke`.

**Références code** : `snapshotGovernanceDashboardHistory.js`, `reportGovernanceHistoryIndex.js`, `condenseGovernanceHistoryIndex.js`, `learningScanGovernanceHistory.js`, `strategyFocusScanGovernanceHistory.js`, `learningWindowStatsGovernanceHistory.js`, `diffGovernanceDashboardSnapshots.js` ; smokes `test:governance-snapshot-history-smoke`, `test:governance-history-index-report-smoke`, `test:governance-history-index-condensed-smoke`, `test:governance-learning-scan-smoke`, `test:governance-strategy-focus-scan-smoke`, `test:governance-learning-window-stats-smoke`, `test:governance-history-json-pipe-smoke`, `test:governance-diff-dashboard-smoke`.
