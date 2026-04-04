# evolutionSummary — dashboard contract

**Location**: `governance_dashboard.json` → `evolutionSummary`  
**Producer**: `engine/governance/computeEvolutionSummary.js`  
**Operator legend**: `engine/evolution/CHAMPION_SNAPSHOT_LEGEND.md`

## Purpose

Read-only, human-oriented labels summarizing the latest **champion registry** (+ optional **next generation report**).  
**Not** a profitability or edge claim — `labOnly` is always `true`.

**Deep dive (definitions, context)** → `engine/evolution/CHAMPION_SNAPSHOT_LEGEND.md`.

**Δ (`champion_registry.json` → `metadata.delta`)** — `avgChampionMomentum − avgValidatedMomentum` (6 décimales). Lecture opérateur stricte (lab uniquement, **pas** signal trading) → `engine/evolution/EVOLUTION_DELTA_OPERATOR.md`.

---

## Lecture en 30 secondes

Ordre de lecture opérateur recommandé :

1. **`evolutionSummaryLine`** — vue d’ensemble en une ligne (copier dans Slack / logs si besoin).
2. **`promotion`** — enfants qui battent le parent (`mutationsPromoted` agrégé) : `dormant` / `low` = peu de signal de progrès ; `active` / `high` = pression évolutive utile.
3. **`exploration`** — `on` = le rapport next-gen indique des enfants générés ; `off` = zéro dans le rapport ; `unknown` = pas de rapport / illisible. Recouper avec les logs si doute.
4. **`elite`** puis **`mutation`** — discipline de sélection (taille de l’élite vs population) et part mutation dans les champions.
5. **`diversity`** et **`pruning`** — protection anti-collapse et ménage des setups faibles.

**Garde-fou** — **`labOnly`** : pas de conclusion PnL / edge ; ces libellés décrivent uniquement le comportement interne observé sur le registry.

---

## Versioning

- `evolutionSummarySchemaVersion` — semver; bump on breaking renames.

## Fields (V1.0.0)

| Field | Description |
|-------|-------------|
| `labOnly` | Always `true` |
| `source` | Paths to JSON files read (audit) |
| `inputs` | Numeric snapshot used for labels (`null` if no registry) |
| `elite` | `strong` \| `moderate` \| `weak` \| `unknown` — champions vs total setups |
| `mutation` | `high` \| `moderate` \| `low` \| `unknown` — mutation share of champions |
| `promotion` | `dormant` \| `low` \| `active` \| `high` \| `unknown` — `metadata.mutationsPromoted` |
| `diversity` | `present` \| `absent` \| `unknown` — `championsProtectedByDiversity > 0` |
| `pruning` | `active` \| `moderate` \| `weak` \| `unknown` — extinction vs population |
| `exploration` | `on` \| `off` \| `unknown` — `next_generation_report.childrenGenerated` |
| `evolutionSummaryLine` | Compact pipe-separated copy for logs / Slack |

## Thresholds (V1 — fixed in code)

Documented in `computeEvolutionSummary.js` comments; adjust only with schema bump + smoke update.

- **elite**: `championsCount/setupsCount` ≤ 2% → `strong`; ≥ 12% → `weak`; else `moderate`.
- **mutation**: `mutationChampionRatio` ≥ 0.55 → `high`; ≤ 0.22 → `low`; else `moderate`. Fallback: count mutation-like champions in `setups` if ratio missing.
- **promotion**: `mutationsPromoted` 0 → `dormant`; 1–4 → `low`; 5–12 → `active`; ≥ 13 → `high`.
- **diversity**: `championsProtectedByDiversity > 0` → `present`, else `absent`.
- **pruning**: `extinctionCount ≥ 10` OR `extinctionCount/setupsCount ≥ 1.5%` → `active`; `extinctionCount === 0` and `setupsCount ≥ 200` → `weak`; else `moderate`.
- **exploration**: `childrenGenerated > 0` → `on`; `0` → `off`; missing report → `unknown`.

## Related: `metadata.delta` (registry, not `evolutionSummary` field)

| Key | Meaning |
|-----|--------|
| `delta` | `avgChampionMomentum − avgValidatedMomentum` (from `metadata` after registry build). |
| **operatorNote** | See `engine/evolution/EVOLUTION_DELTA_OPERATOR.md` — internal lab coherence; never decide from Δ alone. |

## Inputs

- `<dataRoot>/champion_setups/champion_registry.json` (required for non-unknown axes)
- `<dataRoot>/discovery/next_generation_report.json` (optional — exploration axis)
