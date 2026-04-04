# Politique mutation « hotspots » (opt-in)

## But

Réduire le **thinly traded** amont (enfants rejetés par `filterChildrenByMinTrades` surtout en bucket **`far`**) **sans** toucher aux seuils meta, en **dampant** certaines mutations pour des **parents champions** identifiés par audit (`auditChildMinTradesByParent.js`).

## Activation

```bash
export NEUROPILOT_MUTATION_HOTSPOT_POLICY=1
# Optionnel : chemin explicite
export NEUROPILOT_MUTATION_HOTSPOT_POLICY_FILE=/path/to/mutation_hotspot_policy.json
```

Sans `NEUROPILOT_MUTATION_HOTSPOT_POLICY_FILE`, le chargeur cherche dans l’ordre :

1. `$NEUROPILOT_DATA_ROOT/governance/mutation_hotspot_policy.json`
2. `neuropilot_trading_v2/config/mutation_hotspot_policy.json`

**Défaut (flag absent)** : comportement inchangé — aucune lecture de fichier.

## Fichier de politique

Copier `config/mutation_hotspot_policy.example.json` vers un des emplacements ci-dessus et **éditer** (l’exemple inclut des règles indicatives issues d’un snapshot d’audit).

- **`rules`** : liste ordonnée — **première règle qui matche** le `parentSetupId` (= `champion.setupId`) s’applique, puis arrêt.
- **`match`** : un seul parmi `equals` | `prefix` | `includes` (sur l’id complet du champion).
- **`profilePatch`** (tous optionnels) :
  - `jitterScale` — remplace le `jitterScale` adaptatif.
  - `jitterScaleMultiply`, `jitterScaleMin`, `jitterScaleMax` — resserre le jitter numérique.
  - `sessionFlipWeight`, `regimeFlipWeight`, `forcedFamilyShiftWeight` — entiers **≥ 0** ; **0** supprime les entrées correspondantes dans la liste de mutations.

## Traçabilité

`discovery/next_generation_report.json` contient `mutationHotspotPolicy` (enabled, path, warning, `applications` par parent).

## Critères de succès (re-mesure)

**Contrôle rapide après next-gen** (même `NEUROPILOT_DATA_ROOT`) :

```bash
node engine/evolution/scripts/printMutationHotspotPolicy.js
```

Si le goulot observé est **`rejectedExistingSetupIdOnly`** massif avec **`runSaltEnabled: false`**, la suite logique est la **couche identité** (`NEXT_GEN_ID_RUN_SALT`), pas l’élargissement de la hotspot — voir **modèle en deux couches** dans le runbook.

**Runbook détaillé** (séquence, **5 checks premier run** dans l’ordre, GO/NO-GO mental sur 2 runs, stérilité / **variété étroite**, règle **`pattern_001`**) : [`HOTSPOT_POLICY_VALIDATION_RUNBOOK.md`](./HOTSPOT_POLICY_VALIDATION_RUNBOOK.md).

**Policy Phase 1 « sûre »** (sans `pattern_001_open_cf4dce`) : `config/mutation_hotspot_policy.phase1_safe.json`.

Après pipeline batch + meta :

- `AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation node engine/meta/auditChildMinTradesRejects.js`
- `AUDIT_SUMMARY_ONLY=1 ONLY_SOURCE_SUBSTRING=champion_mutation node engine/meta/auditChildMinTradesByParent.js`

Objectif : **moins de `far`** sur les parents ciblés et **plus d’enfants** qui passent `filterChildrenByMinTrades`, sans mandat de baisser `minTradesRatio` / `minTradesAbsolute`.

## Références code

- `engine/evolution/mutationHotspotPolicy.js`
- `buildMutationsConfig` / `buildMutationsConfigResult` — `buildNextGenerationFromChampions.js`
