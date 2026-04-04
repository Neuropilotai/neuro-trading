#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  STRATEGY_FOCUS_SCAN_CONTRACT_VERSION,
  STRATEGY_FOCUS_ROW_FIELD_ORDER,
  entryMatchesStrategy,
  takeStrategyFocusRows,
} = require('./strategyFocusScanGovernanceHistory');
const { LEARNING_SCAN_FIELD_ORDER } = require('./learningScanGovernanceHistory');

assert.strictEqual(STRATEGY_FOCUS_SCAN_CONTRACT_VERSION, '1.0.0');
assert.strictEqual(STRATEGY_FOCUS_ROW_FIELD_ORDER, LEARNING_SCAN_FIELD_ORDER);

assert.strictEqual(entryMatchesStrategy({ bestStrategyId: 'a', worstStrategyId: 'b' }, 'a'), true);
assert.strictEqual(entryMatchesStrategy({ bestStrategyId: 'a', worstStrategyId: 'b' }, 'b'), true);
assert.strictEqual(entryMatchesStrategy({ bestStrategyId: 'a', worstStrategyId: 'b' }, 'c'), false);
assert.strictEqual(entryMatchesStrategy({ bestStrategyId: null, worstStrategyId: 'b' }, 'b'), true);
assert.strictEqual(entryMatchesStrategy(null, 'a'), false);

const dir = path.join(__dirname, '..', '..', `.tmp-smoke-strategy-focus-${Date.now()}`);
const hist = path.join(dir, 'governance', 'history');
fs.mkdirSync(hist, { recursive: true });
const indexPath = path.join(hist, 'index.jsonl');

const e1 = {
  unixEpoch: 100,
  snapshotAtIso: '2026-01-01T00:00:00.000Z',
  confidence: 'low',
  bestStrategyId: 's_orb2',
  worstStrategyId: 's_meanrev',
  validTradeCount: 10,
};
const e2 = {
  unixEpoch: 200,
  snapshotAtIso: '2026-01-02T00:00:00.000Z',
  confidence: 'medium',
  bestStrategyId: 's_x',
  worstStrategyId: 's_y',
  validTradeCount: 20,
};
const e3 = {
  unixEpoch: 300,
  snapshotAtIso: '2026-01-03T00:00:00.000Z',
  confidence: 'high',
  bestStrategyId: 's_x',
  worstStrategyId: 's_orb2',
  validTradeCount: 30,
};
const rawIndex =
  JSON.stringify(e1) +
  '\n' +
  '{not json' +
  '\n' +
  JSON.stringify(e2) +
  '\n' +
  JSON.stringify(e3) +
  '\n';
fs.writeFileSync(indexPath, rawIndex, 'utf8');

process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX = indexPath;
const { readHistoryIndexEntries } = require('./reportGovernanceHistoryIndex');
const { entries, badLines } = readHistoryIndexEntries(indexPath);
assert.strictEqual(badLines, 1);
assert.strictEqual(entries.length, 3);

const focusAll = takeStrategyFocusRows(entries, 's_orb2', 100);
assert.strictEqual(focusAll.windowRows.length, 3);
assert.strictEqual(focusAll.rows.length, 2);

const focusHuge = takeStrategyFocusRows(entries, 's_orb2', 99999);
assert.strictEqual(focusHuge.windowRows.length, 3);
assert.strictEqual(focusHuge.rows.length, 2);
assert.strictEqual(focusHuge.rows[0].snapshotAtIso, e1.snapshotAtIso);
assert.strictEqual(focusAll.rows[0].snapshotAtIso, '2026-01-01T00:00:00.000Z');
assert.strictEqual(focusAll.rows[1].snapshotAtIso, '2026-01-03T00:00:00.000Z');

// Last index row only (e3): worstStrategyId === s_orb2 → one match
const focusTail1 = takeStrategyFocusRows(entries, 's_orb2', 1);
assert.strictEqual(focusTail1.windowRows.length, 1);
assert.strictEqual(focusTail1.rows.length, 1);
assert.strictEqual(focusTail1.rows[0].worstStrategyId, 's_orb2');

// Window [e2] only: no s_orb2 → zero matches
const focusTail1OnlyE2 = takeStrategyFocusRows(
  [e1, e2],
  's_orb2',
  1
);
assert.strictEqual(focusTail1OnlyE2.windowRows.length, 1);
assert.strictEqual(focusTail1OnlyE2.rows.length, 0);

const jsonPayload = JSON.parse(
  JSON.stringify({
    strategyFocusScanContractVersion: STRATEGY_FOCUS_SCAN_CONTRACT_VERSION,
    columns: [...STRATEGY_FOCUS_ROW_FIELD_ORDER],
    meta: {
      strategyId: 's_orb2',
      tail: 100,
      windowRowCount: 3,
      rowCount: 2,
      badLines: 1,
      missing: false,
    },
    rows: focusAll.rows,
  })
);
assert.strictEqual(jsonPayload.strategyFocusScanContractVersion, '1.0.0');
assert.deepStrictEqual(jsonPayload.columns, [...LEARNING_SCAN_FIELD_ORDER]);

const scriptPath = path.join(__dirname, 'strategyFocusScanGovernanceHistory.js');
const noStrat = spawnSync(process.execPath, [scriptPath], {
  encoding: 'utf8',
  env: { ...process.env, NEUROPILOT_GOVERNANCE_HISTORY_INDEX: indexPath },
});
assert.strictEqual(noStrat.status, 1, 'exit 1 when --strategy missing');

const ghostMissing = path.join(os.tmpdir(), `neuropilot-focus-missing-${Date.now()}.jsonl`);
const envFor = (p) => ({ ...process.env, NEUROPILOT_GOVERNANCE_HISTORY_INDEX: p });

const rMiss = spawnSync(
  process.execPath,
  [scriptPath, '--strategy', 's_orb2', '--json', '--tail', '5'],
  { encoding: 'utf8', env: envFor(ghostMissing) }
);
assert.strictEqual(rMiss.status, 0, rMiss.stderr || '');
const jMiss = JSON.parse(rMiss.stdout.trim());
assert.strictEqual(jMiss.meta.missing, true);
assert.strictEqual(jMiss.meta.badLines, 0);
assert.strictEqual(jMiss.meta.windowRowCount, 0);
assert.strictEqual(jMiss.meta.rowCount, 0);
assert.strictEqual(jMiss.rows.length, 0);
assert.strictEqual(jMiss.meta.sourceJsonPathUsed, path.resolve(ghostMissing));

const emptyIdx = path.join(hist, 'empty.jsonl');
fs.writeFileSync(emptyIdx, '', 'utf8');
const rEmp = spawnSync(
  process.execPath,
  [scriptPath, '--strategy', 'x', '--json', '--tail', '5'],
  { encoding: 'utf8', env: envFor(emptyIdx) }
);
assert.strictEqual(rEmp.status, 0, rEmp.stderr || '');
const jEmp = JSON.parse(rEmp.stdout.trim());
assert.strictEqual(jEmp.meta.missing, false);
assert.strictEqual(jEmp.meta.windowRowCount, 0);
assert.strictEqual(jEmp.rows.length, 0);

const rOk = spawnSync(
  process.execPath,
  [scriptPath, '--strategy', 's_orb2', '--json', '--tail', '999'],
  { encoding: 'utf8', env: envFor(indexPath) }
);
assert.strictEqual(rOk.status, 0, rOk.stderr || '');
const jOk = JSON.parse(rOk.stdout.trim());
assert.strictEqual(jOk.meta.sourceJsonPathUsed, path.resolve(indexPath));
assert.strictEqual(jOk.meta.windowRowCount, 3);
assert.strictEqual(jOk.rows.length, 2);

delete process.env.NEUROPILOT_GOVERNANCE_HISTORY_INDEX;
fs.rmSync(dir, { recursive: true, force: true });

console.log('smokeStrategyFocusScanGovernanceHistory: ok');
