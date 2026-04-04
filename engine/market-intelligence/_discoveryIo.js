'use strict';

/**
 * Local I/O for discovery artefacts under DATA_ROOT/discovery/.
 * No live trading; additive V1 only.
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function resolveDiscoveryDir(opts = {}) {
  if (opts.dataRoot) {
    const d = path.join(path.resolve(opts.dataRoot), 'discovery');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  return dataRoot.getPath('discovery', true);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonPretty(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

module.exports = {
  resolveDiscoveryDir,
  readJsonSafe,
  writeJsonPretty,
};
