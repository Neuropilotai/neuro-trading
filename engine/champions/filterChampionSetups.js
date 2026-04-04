'use strict';

/**
 * Champion Registry — Filter setups by status.
 *
 * Semantics:
 *   candidate  = idée intéressante
 *   validated  = mérite d'être surveillée
 *   champion   = assez robuste pour exécution (Live Bridge uses only these)
 *
 * Usage:
 *   const registry = loadChampionRegistrySync();
 *   const champions = getChampionsOnly(registry);
 *   const validated = getByStatus(registry, 'validated');
 */

const VALID_STATUSES = new Set(['candidate', 'validated', 'champion']);

/**
 * Get all setups with the given status.
 * @param {object|null} registry - From loadChampionRegistry (must have .champions array)
 * @param {'candidate'|'validated'|'champion'} status
 * @returns {Array<object>} Entries with that status
 */
function getByStatus(registry, status) {
  if (!registry || !Array.isArray(registry.champions)) return [];
  if (!VALID_STATUSES.has(status)) return [];
  return registry.champions.filter((e) => e.status === status);
}

/**
 * Get only champions. Use this in the Live Bridge so only robust setups are executable.
 * @param {object|null} registry
 * @returns {Array<object>} Entries with status === 'champion'
 */
function getChampionsOnly(registry) {
  return getByStatus(registry, 'champion');
}

/**
 * Get setupIds only (e.g. for allowlist).
 * @param {object|null} registry
 * @param {'candidate'|'validated'|'champion'} [status] - If omitted, returns champion ids only
 * @returns {string[]}
 */
function getSetupIds(registry, status = 'champion') {
  const list = status ? getByStatus(registry, status) : (registry && registry.champions) || [];
  return list.map((e) => e.setupId).filter(Boolean);
}

module.exports = { getByStatus, getChampionsOnly, getSetupIds, VALID_STATUSES };
