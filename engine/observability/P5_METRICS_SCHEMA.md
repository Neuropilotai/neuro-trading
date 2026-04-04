# p5_metrics.json — contrat de schéma

**Fichier** : `<dataRoot>/governance/p5_metrics.json`  
**Producteur** : `engine/observability/p5Metrics.js` (`refreshP5Metrics`)

## Versionnement

- **`p5MetricsSchemaVersion`** (semver) : incrémenter **minor** pour nouveaux champs optionnels rétrocompatibles ; **major** pour renommages / sémantique cassante.
- Ne pas renommer les clés existantes sans bump **major** et note de migration.

## Champs (V1.1)

| Clé | Type | Description |
|-----|------|-------------|
| `p5MetricsSchemaVersion` | string | Ex. `1.1.0` |
| `generatedAt` | string (ISO) | Fin du dernier refresh |
| `source` | string | Chemin absolu du fichier d’événements lu |
| `totalLines` | number | Lignes non vides dans le log |
| `parseErrorCount` | number | Lignes non parsées / assert inconnu |
| `unexpectedAssertCount` | number | Sous-ensemble : `chainAssert` hors whitelist |
| `okCount` / `skipCount` / `mismatchCount` | number | Compteurs par statut |
| `okRate` / `skipRate` | number | Sur lignes parsées avec succès |
| `lastStatus` | string \| null | `chainAssert` de la **dernière** ligne valide |
| `cycleAlignment` | `aligned` \| `unknown` \| `mismatch` | `miniCycleId_prior` vs `lastCompletedCycleId` (pas de lag numérique) |
| `lastObserved` | string (ISO) | Timestamp de la dernière ligne valide (préfixe log) ou `generatedAt` si vide |
| `lastMismatchAt` | string \| null | ISO du **dernier** événement `mismatch_will_throw` (préfixe ligne) |
| `lastParseErrorAt` | string \| null | ISO du **dernier** événement en erreur de parse si préfixe présent |
| `lastAlertReason` | string \| null | Synthèse ops : `chain_mismatch` > `parse_errors` > `no_p5_cycle_events` > null |

Les alertes détaillées restent dans `governance/p5_alerts.log` (append-only).
