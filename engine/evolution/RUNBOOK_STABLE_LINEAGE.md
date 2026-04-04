# Runbook — Stable lineage root + vérification

Après le patch ultra propre (lineageKey + isPositiveNight legacy-safe), exécuter dans cet ordre.

## 1. Appliquer le fix stable root (déjà fait)

Priorité partout :

```text
lineageKey = row.lineageKey || row.parentFamilyId || row.familyKey || extractStableLineageRoot(setupId) || extractRootFamily(setupId) || setupId
```

Fonction (identique dans `backfillLineageHistory.js` et `strategyEvolution.js`) :

```js
function extractStableLineageRoot(setupId) {
  const root = extractRootFamily(setupId);
  if (!root) return null;
  return String(root).replace(/_[a-z0-9]{2,12}$/i, '');
}
```

## 2. Refaire le backfill

Comme le `lineageKey` a changé, régénérer les fichiers enrichis. Supprimer les `*_enriched.json` puis relancer le backfill.

```bash
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI

find "$NEUROPILOT_DATA_ROOT" -name "*_enriched.json" -delete

node neuropilot_trading_v2/engine/evolution/backfillLineageHistory.js
```

## 3. Relancer l’évolution

```bash
node neuropilot_trading_v2/engine/evolution/strategyEvolution.js
```

## 4. Vérifier le registry (script exact)

```bash
node - <<'NODE'
const fs = require('fs');
const p = '/Volumes/TradingDrive/NeuroPilotAI/champion_setups/champion_registry.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = j.setups || [];

console.log({
  source: j.source,
  nightsAnalyzed: j.nightsAnalyzed,
  setupsCount: j.setupsCount,
  candidatesCount: j.candidatesCount,
  validatedCount: j.validatedCount,
  championsCount: j.championsCount,
  maxNightsSurvived: Math.max(0, ...rows.map(r => Number(r.nightsSurvived) || 0)),
  with2PlusNights: rows.filter(r => (Number(r.nightsSurvived) || 0) >= 2).length,
  with3PlusNights: rows.filter(r => (Number(r.nightsSurvived) || 0) >= 3).length,
});

console.table(
  rows
    .slice()
    .sort((a,b) =>
      (Number(b.nightsSurvived)||0) - (Number(a.nightsSurvived)||0) ||
      (Number(b.survivalScore)||0) - (Number(a.survivalScore)||0)
    )
    .slice(0,20)
    .map(r => ({
      setupId: r.setupId,
      status: r.status,
      nightsSurvived: r.nightsSurvived,
      survivalScore: r.survivalScore,
      beatsParentRate: r.beatsParentRate,
      avgMetaScore: r.avgMetaScore,
      lineageDepth: r.lineageDepth
    }))
);
NODE
```

## 4b. Vérification alternative (si autre data root)

```bash
node - <<'NODE'
const fs = require('fs');
const p = process.env.NEUROPILOT_DATA_ROOT
  ? process.env.NEUROPILOT_DATA_ROOT + '/champion_setups/champion_registry.json'
  : require('path').join(__dirname, 'neuropilot_trading_v2/../data_workspace/champion_setups/champion_registry.json');
if (!require('fs').existsSync(p)) { console.error('Registry not found:', p); process.exit(1); }
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = j.setups || [];

console.log({
  nightsAnalyzed: j.nightsAnalyzed,
  setupsCount: rows.length,
  maxNightsSurvived: Math.max(0, ...rows.map(r => Number(r.nightsSurvived) || 0)),
  with2PlusNights: rows.filter(r => (Number(r.nightsSurvived) || 0) >= 2).length,
  with3PlusNights: rows.filter(r => (Number(r.nightsSurvived) || 0) >= 3).length,
  championsCount: rows.filter(r => r.status === 'champion').length,
});

console.table(
  rows
    .slice()
    .sort((a,b) =>
      (Number(b.nightsSurvived)||0) - (Number(a.nightsSurvived)||0) ||
      (Number(b.survivalScore)||0) - (Number(a.survivalScore)||0)
    )
    .slice(0, 20)
    .map(r => ({
      setupId: (r.setupId || '').slice(0, 36),
      status: r.status,
      nightsSurvived: r.nightsSurvived,
      survivalScore: r.survivalScore,
      beatsParentRate: r.beatsParentRate,
      avgMetaScore: r.avgMetaScore
    }))
);
NODE
```

Si tu utilises un data root fixe (ex. 5TB) :

```bash
NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI node -e "
const fs = require('fs');
const p = process.env.NEUROPILOT_DATA_ROOT + '/champion_setups/champion_registry.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = j.setups || [];
console.log({
  nightsAnalyzed: j.nightsAnalyzed,
  setupsCount: rows.length,
  maxNightsSurvived: Math.max(0, ...rows.map(r => Number(r.nightsSurvived) || 0)),
  with2PlusNights: rows.filter(r => (Number(r.nightsSurvived) || 0) >= 2).length,
  with3PlusNights: rows.filter(r => (Number(r.nightsSurvived) || 0) >= 3).length,
  championsCount: rows.filter(r => r.status === 'champion').length,
});
console.table(rows.slice().sort((a,b) => (Number(b.nightsSurvived)||0) - (Number(a.nightsSurvived)||0)).slice(0,20).map(r => ({ setupId: (r.setupId||'').slice(0,36), status: r.status, nightsSurvived: r.nightsSurvived, survivalScore: r.survivalScore })));
"
```

## Succès attendu

- `maxNightsSurvived` ≥ 2
- `with2PlusNights` > 0

Si `history.length` monte mais `nightsSurvived` reste bas, c’est le critère **isPositiveNight** (trades ≥ 20, expectancy > 0, bootstrap_risk ≤ 0.2) qui limite ; à ajuster seulement après avoir confirmé que le regroupement par lignée fonctionne.
