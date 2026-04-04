'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Load generated strategy files from generated_strategies.
 * Supports both:
 * - setup_*.js   (CommonJS module exporting a strategy object)
 * - setup_*.json (plain JSON strategy object)
 *
 * Options:
 * - dir: directory to scan
 * - includePrefixes: array of allowed file prefixes, e.g. ['setup_familyexp_', 'setup_mut_']
 *
 * Returns:
 * - array of normalized strategy objects
 */
function loadGeneratedStrategyFiles(opts = {}) {
  const dir = opts.dir;
  const includePrefixes = Array.isArray(opts.includePrefixes) ? opts.includePrefixes : [];
  if (!dir || !fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((name) => {
      if (!/^setup_.*\.(js|json)$/i.test(name)) return false;
      if (!includePrefixes.length) return true;
      return includePrefixes.some((prefix) => name.startsWith(prefix));
    })
    .sort();

  const out = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);

    try {
      let raw = null;

      if (/\.json$/i.test(file)) {
        raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } else if (/\.js$/i.test(file)) {
        delete require.cache[require.resolve(fullPath)];
        raw = require(fullPath);
        if (raw && raw.default && typeof raw.default === 'object') {
          raw = raw.default;
        }
      }

      if (!raw || typeof raw !== 'object') continue;

      const setupId =
        raw.setupId != null
          ? String(raw.setupId)
          : path.basename(file, path.extname(file));

      out.push({
        ...raw,
        setupId,
        _loadedFrom: fullPath,
        _loadedFromType: /\.json$/i.test(file) ? 'json' : 'js',
      });
    } catch (err) {
      console.error(
        `[loadGeneratedStrategyFiles] Failed to load ${fullPath}:`,
        err && err.message ? err.message : err
      );
    }
  }

  return out;
}

/**
 * Merge grid + generated setups: last occurrence wins per setupId (or name+rules key for grid rows).
 */
function dedupeSetups(setups) {
  if (!Array.isArray(setups) || setups.length === 0) return [];
  const byKey = new Map();
  for (let i = setups.length - 1; i >= 0; i--) {
    const s = setups[i];
    if (!s || typeof s !== 'object') continue;
    const key =
      s.setupId != null && String(s.setupId).length
        ? String(s.setupId)
        : `n:${String(s.name ?? '')}:${JSON.stringify(s.rules ?? {})}`;
    if (!byKey.has(key)) byKey.set(key, s);
  }
  return Array.from(byKey.values()).reverse();
}

loadGeneratedStrategyFiles.loadGeneratedStrategyFiles = loadGeneratedStrategyFiles;
loadGeneratedStrategyFiles.dedupeSetups = dedupeSetups;
module.exports = loadGeneratedStrategyFiles;
