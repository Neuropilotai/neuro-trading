'use strict';

const fs = require('fs');
const { normalizeMarketContext } = require('../schema');

/**
 * Read and parse a single JSON file; return normalized context or null.
 * @param {string} filePath
 * @param {string} sourceOk
 * @param {string} sourceBad
 */
function loadStaticMarketJson(filePath, sourceOk = 'static_stub') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeMarketContext(raw, sourceOk);
  } catch {
    return null;
  }
}

module.exports = {
  loadStaticMarketJson,
};
