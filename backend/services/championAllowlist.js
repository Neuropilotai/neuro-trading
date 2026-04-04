'use strict';

/**
 * Champion Allowlist — Load setupIds from champion_registry.json.
 * Used by riskCheck to execute only champion-approved setups.
 *
 * Env: NEUROPILOT_DATA_ROOT (optional). If unset, uses fallback path.
 * Env: CHAMPION_ALLOWLIST_ENABLED (default '1') — set to '0' to disable filtering.
 */

const fs = require('fs');
const path = require('path');

const CHAMPION_REGISTRY_PATH =
  process.env.NEUROPILOT_DATA_ROOT
    ? path.join(process.env.NEUROPILOT_DATA_ROOT, 'champion_setups', 'champion_registry.json')
    : path.join(__dirname, '../../..', 'data_workspace', 'champion_setups', 'champion_registry.json');

const FALLBACK_PATH = '/Volumes/TradingDrive/NeuroPilotAI/champion_setups/champion_registry.json';

let _cachedSet = null;
let _cachedPath = null;

/**
 * Load champion setupIds from registry. Returns a Set for fast lookup.
 * On read error returns empty Set (fail-open: no filtering if file missing).
 * @returns {Set<string>}
 */
function loadChampionAllowlist() {
  const tryPath = fs.existsSync(CHAMPION_REGISTRY_PATH)
    ? CHAMPION_REGISTRY_PATH
    : fs.existsSync(FALLBACK_PATH)
      ? FALLBACK_PATH
      : CHAMPION_REGISTRY_PATH;

  if (_cachedSet !== null && _cachedPath === tryPath) {
    return _cachedSet;
  }

  try {
    const raw = fs.readFileSync(tryPath, 'utf8');
    const j = JSON.parse(raw);
    const champs = j.champions || [];
    _cachedSet = new Set(champs.map((c) => String(c.setupId || c.setup_id || '')).filter(Boolean));
    _cachedPath = tryPath;
    return _cachedSet;
  } catch (e) {
    console.error('Failed to load champion allowlist:', e && e.message);
    _cachedSet = new Set();
    _cachedPath = null;
    return _cachedSet;
  }
}

/**
 * Clear in-memory cache (e.g. after pipeline regenerates registry).
 */
function clearChampionAllowlistCache() {
  _cachedSet = null;
  _cachedPath = null;
}

function isChampionAllowlistEnabled() {
  const v = (process.env.CHAMPION_ALLOWLIST_ENABLED || '1').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

module.exports = {
  loadChampionAllowlist,
  clearChampionAllowlistCache,
  isChampionAllowlistEnabled,
  CHAMPION_REGISTRY_PATH,
};
