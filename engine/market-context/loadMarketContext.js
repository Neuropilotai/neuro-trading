'use strict';

const path = require('path');
const { loadStaticMarketJson } = require('./providers/staticJson');

/**
 * P1 stub — file-based only, no network.
 * Returns null unless EVOLUTION_MARKET_CONTEXT_ENABLE=1.
 *
 * @param {object} [opts]
 * @param {{ getDataRoot: () => string }} [opts.dataRoot]
 */
function loadMarketContext(opts = {}) {
  if (process.env.EVOLUTION_MARKET_CONTEXT_ENABLE !== '1') {
    return null;
  }

  const dataRootMod = opts.dataRoot;
  let filePath = process.env.MARKET_CONTEXT_PATH;
  if (filePath && String(filePath).trim()) {
    filePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
  } else {
    const root =
      dataRootMod && typeof dataRootMod.getDataRoot === 'function'
        ? dataRootMod.getDataRoot()
        : process.env.NEUROPILOT_DATA_ROOT || '.';
    filePath = path.join(path.resolve(String(root)), 'market_context.json');
  }

  return loadStaticMarketJson(filePath, 'static_stub');
}

module.exports = {
  loadMarketContext,
};
