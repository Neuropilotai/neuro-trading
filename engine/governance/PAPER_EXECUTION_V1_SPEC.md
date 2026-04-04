# Paper Execution V1 — Spec

**Statut** : **implémenté** (schéma `paperExecutionSchemaVersion` **1.0.0**).  
**Objectif** : exécution paper **déterministe**, **auditable**, **sans live**, base d’une boucle apprentissage (signal → paper → JSONL → évaluation).

**Code** : `engine/governance/paperExecutionV1Simulator.js`, `engine/governance/runPaperExecutionV1.js` · **Activation** : `NEUROPILOT_PAPER_EXEC_V1=1` (sinon aucun effet) · **Entrée** : `governance/paper_execution_v1_signals.json` (ex. `fixtures/paper_execution_v1_signals.example.json` ou **`fixtures/paper_execution_v1_signals_multi_strategy.example.json`** pour diversité `strategyId`) · **Sortie** : `governance/paper_trades.jsonl` (append-only) · **Smoke** : `node engine/governance/smokePaperExecutionV1.js` · **Pipeline** : étape **8.8** de `runFullPipelineExpanded.sh` (optionnelle) · **Guide multi** : `fixtures/README_PAPER_SIGNALS_MULTI.md`.

---

## 1. Ordre de simulation (non négociable)

- Exécution **bar par bar** (séquentielle).
- **Aucune** agrégation globale type `min(prices)` / `max(prices)` sur toute la fenêtre pour décider du sortie.
- Chaque bar est traitée dans l’ordre chronologique :

```text
for each bar:
  evaluate entry / exit conditions
```

---

## 2. Modèle intrabar (déterministe, V1 unique)

**Chemin OHLC conservateur : OPEN → LOW → HIGH → CLOSE**

Identifiant contrat : `intrabarModel: "OHLC_LOW_FIRST"` (alias sémantique : low avant high dans la barre).

Conséquences (ex. position long, stop sous prix, target au-dessus) :

- Si stop et target sont tous deux franchissables dans la **même** bougie, le parcours low-then-high fait généralement **toucher le stop en premier** si le low atteint le stop avant que le high n’atteigne la target — conformément au chemin figé.

---

## 3. Tie-break explicite (même bougie, stop + target)

Si dans une même bougie on a à la fois :

- `low <= stop` (touch stop côté baisse)
- et `high >= target` (touch target côté hausse)

**alors V1** :

- sortie au **stop**
- `reason = "stop_intrabar_priority"` (ou équivalent stable documenté)

Propriétés :

- déterministe  
- pessimiste (réduit le risque d’overfitting optimiste)  
- traçable  

*(À aligner exactement avec le chemin OPEN → LOW → HIGH → CLOSE : si le modèle mathématique donne déjà stop d’abord, ce tie-break formalise le cas limite.)*

---

## 4. Ordre d’évaluation dans chaque bar

- Ordre des tests **explicite** dans la spec + code (pas de comportement implicite).
- Documenter : entrée (si applicable) puis sorties (stop / target / time).

---

## 5. Fermeture fallback

Si aucune condition de sortie n’est touchée jusqu’à la fin du chemin de bars fourni :

- `exit` = dernier prix de référence (ex. **close** de la dernière bar)
- `reason = "time"` (ou `end_of_path`)

---

## 6. Sortie — `paper_trades.jsonl`

- **1 ligne JSON par trade** (append-only).
- Schéma stable minimal (champs obligatoires à figer à l’implémentation) :

| Champ | Rôle |
|-------|------|
| `ts` | ISO8601 (ex. sortie ou dernier update) |
| `cycleId` | Chaîne cycle |
| `experimentId` | Run / expérience |
| `strategyId` | Stratégie (comportement historique : premier non vide parmi strategyId / setupId du signal, sinon `unknown`) |
| `setupId` | **Optionnel** : id canonique (ex. `mut_…`) seulement si le signal définit `setupId` et qu’il diffère de `strategyId` — enrichissement non destructif pour le learning |
| `entry` / `exit` | Prix simulés |
| `reason` | `target` \| `stop` \| `stop_intrabar_priority` \| `time` \| `max_bars` \| `skip` (non appendé) |
| `pnl` | Notional 1 unité : long `exit - entry`, short `entry - exit` |
| `entryTs` / `exitTs` | ISO8601 depuis le timestamp OHLC des barres (si présent) |
| `barsHeld` | Nombre de bars tenus |
| `governorDecision` | V1 : `null` (réservé) |
| `policyRef` | V1 : `null` (réservé) |
| `intrabarModel` | `OHLC_LOW_FIRST` |
| `paperExecutionSchemaVersion` | ex. `1.0.0` |

---

## 7. Invariants critiques (audit)

- **Même input → même output** (déterminisme 100 %).
- Pas de dépendance **temps réel** horloge pour la logique de prix (horodatages log OK).
- **Aucune** randomness.
- **Aucun** accès réseau / API marché en V1.

---

## 8. Hors périmètre V1 (explicite)

- Slippage  
- Spread  
- Latence  
- Partial fills  
- Multi-leg / multi-exit  

Volontairement simple pour garder un système **prouvable**.

---

## 9. Checkpoint implémentation

1. ✅ Schéma `paperExecutionSchemaVersion: "1.0.0"`.  
2. ✅ Modules + flag `NEUROPILOT_PAPER_EXEC_V1`.  
3. ✅ Smoke : target, stop, tie-break intrabar, runner vide + flag off.  
4. ✅ Hors flag : aucune lecture/écriture paper V1 ; mutation / policy / governor non modifiés.

---

*Document aligné sur le cadrage produit — exécution paper avant apprentissage sur PnL simulé.*
