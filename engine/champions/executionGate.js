'use strict';

/**
 * Champion Execution Gate — Decides if a signal is allowed to be traded.
 *
 * Flow: TradingView alert → webhook → check registry → champion → trade; not champion → ignore.
 * Only setups with status === 'champion' are executable.
 *
 * Usage:
 *   const { isChampionAllowed, getChampionAllowlist } = require('./engine/champions/executionGate');
 *   if (!isChampionAllowed(incomingSetupId)) return rejectSignal();
 */

const { loadChampionRegistrySync } = require('./loadChampionRegistry');
const { getChampionsOnly } = require('./filterChampionSetups');

let _allowlistCache = null;
let _cacheTs = 0;
const CACHE_MS = 60 * 1000;

/**
 * Get the list of setupIds that are allowed for execution (champions only).
 * Cached for 1 minute to avoid reading the file on every webhook.
 * @returns {string[]}
 */
function getChampionAllowlist() {
  const now = Date.now();
  if (_allowlistCache !== null && now - _cacheTs < CACHE_MS) {
    return _allowlistCache;
  }
  const registry = loadChampionRegistrySync();
  const champions = getChampionsOnly(registry);
  _allowlistCache = champions.map((c) => c.setupId).filter(Boolean);
  _cacheTs = now;
  return _allowlistCache;
}

/**
 * Returns true if the given setupId is in the champion registry (status === 'champion').
 * If no registry exists or champions list is empty, returns true (backward compat: allow all).
 *
 * @param {string} setupId - Incoming setup_id or setup_name from the alert
 * @returns {boolean}
 */
function isChampionAllowed(setupId) {
  const id = (setupId ?? '').toString().trim();
  if (!id) return false;
  const allowlist = getChampionAllowlist();
  if (allowlist.length === 0) return true;
  return allowlist.some((c) => c === id);
}

/**
 * Clear the allowlist cache (e.g. after nightly run updates champion_registry.json).
 */
function clearCache() {
  _allowlistCache = null;
  _cacheTs = 0;
}

module.exports = { isChampionAllowed, getChampionAllowlist, clearCache };
