'use strict';

/**
 * Champion Registry — Load champion_registry.json from the data root.
 *
 * Live Bridge must only use setups with status === 'champion'.
 * Use filterChampionSetups.getChampionsOnly(registry) to get that list.
 *
 * Usage:
 *   const { loadChampionRegistry } = require('./engine/champions/loadChampionRegistry');
 *   const registry = await loadChampionRegistry();
 *   if (registry) { ... }
 */

const path = require('path');
const fs = require('fs');
const dataRoot = require('../dataRoot');

const REGISTRY_FILENAME = 'champion_registry.json';

/**
 * Load champion_registry.json from champion_setups/.
 * @param {string} [championDir] - Override path to champion_setups
 * @returns {Promise<object|null>} Registry object or null if missing/invalid
 */
async function loadChampionRegistry(championDir) {
  const dir = championDir || dataRoot.getPath('champion_setups', false);
  const filePath = path.join(dir, REGISTRY_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Sync version for callers that don't need async.
 * @param {string} [championDir]
 * @returns {object|null}
 */
function loadChampionRegistrySync(championDir) {
  const dir = championDir || dataRoot.getPath('champion_setups', false);
  const filePath = path.join(dir, REGISTRY_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { loadChampionRegistry, loadChampionRegistrySync, REGISTRY_FILENAME };
