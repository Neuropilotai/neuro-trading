# Ops — lecture de 3 dashboards consécutifs

**Purpose** : détecter **progression**, **stagnation** ou **dégradation** sans sur-interpréter un seul snapshot.  
**Scope** : `governance_dashboard.json` / HTML embarqué — **lecture seule**.

---

## Principe

Comparer **au moins 3 builds** du dashboard (même `dataRoot`, même branche déployée idéalement), en notant les champs ci-dessous à chaque fois.

**Ne pas** inférer de causalité (ex. `fallback_frequent` → `childrenGenerated: 0`) sans vérifier pipeline, artefacts (`next_generation_report.json`, `mutation_policy.json`) et logs.

---

## Checklist par snapshot (à recopier 3×)

Pour chaque fichier / build, noter :

| # | Champ | Où le lire |
|---|--------|------------|
| 1 | `generatedAt` | Racine du payload |
| 2 | `evolutionSummaryLine` | `evolutionSummary.evolutionSummaryLine` |
| 3 | `governanceAlertDigest.status` + `recentTrend` | `governanceAlertDigest` |
| 4 | `policyHealth.source` + `lastAlertReason` | `policyHealth` |
| 5 | `p7Health.lastStatus` + `lastAlertReason` | `p7Health` |
| 6 | `p7GuardMetrics.lastAction` + `skipRate` / `attenuateRate` | `p7GuardMetrics` (si guard utilisé) |

**Option utile** : `governanceHealth.status` + `activeAlerts.length` pour vue consolidée.

---

## Règles de lecture (simples)

### Amélioration plausible

- Alertes consolidées qui **baissent** (moins de `activeAlerts`, `status` vers `healthy`, `recentTrend` = `improving` si comparable).
- **`evolutionSummary`** : `promotion` / `exploration` **restent vivants** (ex. `exploration: on` si le rapport next-gen est présent et non nul ; pas de collapse brutal des axes elite/mutation sans explication).

### Stagnation

- Champs **identiques** ou quasi identiques sur **3 builds** d’affilée (hors `generatedAt`).
- `recentTrend` = `stable` **et** aucun mouvement sur policy / P7 / digest.

### Dégradation

- `warning` / `critical` qui **montent** ou persistent avec **plus** d’entrées dans `activeAlerts`.
- **`exploration: off`** (ou `childrenGenerated: 0` dans `evolutionSummary.inputs`) **de façon durable** sur plusieurs builds — à recouper avec `next_generation_report.json` et l’ordonnancement du pipeline avant de conclure.

---

## Garde-fous (rappel)

- **`appliedFromTrendMemory: false`** peut être **normal** (env, mode conservative, guard P7, etc.).
- **`fallbackRate`** : toujours avec **fenêtre** et **définition** documentée dans la source (trend memory / métriques).
- **`labOnly`** sur `evolutionSummary` : **pas** de conclusion PnL / edge marché.

---

## Commandes utiles

Régénérer le dashboard :

```bash
cd neuropilot_trading_v2
node engine/governance/buildGovernanceDashboard.js
```

Extraire un résumé (avec `jq`) :

```bash
jq '{generatedAt, evolutionSummaryLine: .evolutionSummary.evolutionSummaryLine, digest: {status: .governanceAlertDigest.status, trend: .governanceAlertDigest.recentTrend, n: (.governanceAlertDigest.activeAlerts | length)}, policy: {source: .policyHealth.source, alert: .policyHealth.lastAlertReason}, p7: {status: .p7Health.lastStatus, alert: .p7Health.lastAlertReason}, guard: {last: .p7GuardMetrics.lastAction, skip: .p7GuardMetrics.skipRate, att: .p7GuardMetrics.attenuateRate}}' ops-snapshot/governance_dashboard.json
```

---

*Checklist ops — à utiliser avec `P8_GOVERNANCE_DASHBOARD.md` et `EVOLUTION_SUMMARY_SCHEMA.md`.*
