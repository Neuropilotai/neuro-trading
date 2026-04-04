'use strict';

/**
 * Read-only: is strategyId in strict promotable set from strategy_validation snapshot.
 * Does NOT alter validation; fail-closed if file missing (returns not promotable).
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function collectPromotableIds(root) {
  const j = readJsonSafe(root);
  if (!j || typeof j !== 'object') return new Set();
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const ids = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (r.promotable === true && r.excludedFromRanking !== true) {
      const sid = r.strategyId != null ? String(r.strategyId) : r.id != null ? String(r.id) : '';
      if (sid) ids.add(sid);
    }
  }
  return ids;
}

/**
 * @param {string} strategyId
 * @param {{ dataRoot?: string }} [opts]
 */
function isStrategyPromotable(strategyId, opts = {}) {
  const sid = strategyId != null ? String(strategyId).trim() : '';
  if (!sid) return false;

  const roots = [];
  if (opts.dataRoot) {
    roots.push(path.join(path.resolve(opts.dataRoot), 'governance', 'strategy_validation.json'));
  }
  roots.push(path.join(dataRoot.getPath('governance', false), 'strategy_validation.json'));
  const projectRoot = path.resolve(__dirname, '..', '..');
  roots.push(path.join(projectRoot, 'ops-snapshot', 'strategy_validation.json'));

  for (const p of roots) {
    const set = collectPromotableIds(p);
    if (set.size > 0 && set.has(sid)) return true;
  }
  return false;
}

module.exports = {
  isStrategyPromotable,
  collectPromotableIds,
};
