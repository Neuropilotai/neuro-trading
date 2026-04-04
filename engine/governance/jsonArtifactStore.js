'use strict';

/**
 * Fail-fast reads for small governance JSON stores (registry, dataset versions).
 *
 * - Missing file → caller-provided empty factory (not an error).
 * - Empty file, invalid JSON, or invalid shape → quarantine rename + throw (strict).
 * - Set NEUROPILOT_LENIENT_JSON_STORES=true to restore legacy silent empty fallback (recovery only).
 */

const fs = require('fs');

function isLenient() {
  return String(process.env.NEUROPILOT_LENIENT_JSON_STORES || '').toLowerCase() === 'true';
}

function quarantine(filePath) {
  const ts = Date.now();
  let dest = `${filePath}.corrupt.${ts}`;
  let i = 0;
  while (fs.existsSync(dest)) {
    i += 1;
    dest = `${filePath}.corrupt.${ts}.${i}`;
  }
  fs.renameSync(filePath, dest);
  return dest;
}

/**
 * @param {string} filePath
 * @param {{ label: string, empty: () => object, isValidShape: (obj: object) => boolean }} opts
 */
function readJsonStore(filePath, opts) {
  const { label, empty, isValidShape } = opts;
  const lenient = isLenient();

  if (!fs.existsSync(filePath)) {
    return empty();
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const err = new Error(`[${label}] cannot read file: ${filePath}`);
    err.cause = e;
    console.error(err.message);
    throw err;
  }

  if (!raw.trim()) {
    if (lenient) return empty();
    const q = quarantine(filePath);
    const msg = `[${label}] empty file; quarantined to ${q}`;
    console.error(msg);
    throw new Error(msg);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    if (lenient) return empty();
    const q = quarantine(filePath);
    const msg = `[${label}] invalid JSON; quarantined to ${q}`;
    console.error(msg);
    throw new Error(msg);
  }

  if (!isValidShape(json)) {
    if (lenient) return empty();
    const q = quarantine(filePath);
    const msg = `[${label}] invalid schema (expected shape); quarantined to ${q}`;
    console.error(msg);
    throw new Error(msg);
  }

  return json;
}

module.exports = {
  readJsonStore,
  quarantineCorruptFile: quarantine,
  isLenientJsonStores: isLenient,
};
