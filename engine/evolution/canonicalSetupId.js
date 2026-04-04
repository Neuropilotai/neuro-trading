'use strict';

const crypto = require('crypto');

/**
 * Strategy Evolution Engine — Stable canonical setupId from rules.
 *
 * Same rules → same id across nights. Output is a short readable prefix + 6-char
 * SHA1 hash so ids stay compact (e.g. pattern_001_mid_9fa34c).
 *
 * Input: { name: string, rules: object }
 * Output: e.g. pattern_breakout_mid_6fa23b
 */
function shortHash(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex').slice(0, 6);
}

/**
 * Normalize a value for stable stringify (numbers, booleans, strings).
 * @param {*} v
 * @returns {string}
 */
function normalizeValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.-]/g, '');
}

/**
 * Build a stable canonical setupId: short readable prefix + 6-char hash of full slug.
 *
 * @param {{ name?: string, rules: object }} opts - name (e.g. pattern_001 or trend_breakout), rules (e.g. body_pct_min, close_strength_min, session_phase, regime)
 * @returns {string} Stable short id, e.g. pattern_001_mid_9fa34c
 */
function computeCanonicalSetupId(opts) {
  const name = (opts && opts.name) ? String(opts.name).trim() : 'setup';
  const rules = (opts && opts.rules && typeof opts.rules === 'object') ? opts.rules : {};
  const keys = Object.keys(rules).sort();
  const parts = [name.replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '').toLowerCase()];
  for (const k of keys) {
    const v = rules[k];
    const keySlug = String(k).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    parts.push(keySlug);
    parts.push(normalizeValue(v));
  }
  const fullSlug = parts.join('_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'setup_unknown';
  const hash = shortHash(fullSlug);
  const prefixParts = [name.replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '').toLowerCase()];
  if (rules.session_phase != null) prefixParts.push(normalizeValue(rules.session_phase));
  else if (rules.regime != null) prefixParts.push(normalizeValue(rules.regime));
  const shortPrefix = prefixParts.join('_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'setup';
  return `${shortPrefix}_${hash}`;
}

module.exports = { computeCanonicalSetupId, normalizeValue, shortHash };
