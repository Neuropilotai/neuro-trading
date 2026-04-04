/**
 * Paper universe: instruments + timeframes for the AI selector.
 * Used by paper_autopilot.js --universe default.
 *
 * Wave 1 scope:
 * - Market expansion only (no new timeframes, no new families, no filter relax).
 */

const PAPER_UNIVERSE_DEFAULT = [
  { symbol: 'XAUUSD', timeframe: '1', reason: 'Volatilité + scalping propre' },
  { symbol: 'NAS100', timeframe: '1', reason: 'Trend explosif session NY' },
  { symbol: 'EURUSD', timeframe: '1', reason: 'Forex liquide, sessions EU/US' },
  { symbol: 'GBPUSD', timeframe: '1', reason: 'Volatilité intraday élevée' },
  { symbol: 'USDJPY', timeframe: '1', reason: 'Flux macro FX stable' },
  { symbol: 'ADAUSDT', timeframe: '1', reason: 'Crypto alt liquide 24/7' },
  { symbol: 'XRPUSDT', timeframe: '1', reason: 'Crypto alt liquide 24/7' },
];

function getPaperUniverse(name) {
  const n = (name || 'default').toString().trim().toLowerCase();
  if (n === 'default') return PAPER_UNIVERSE_DEFAULT;
  return PAPER_UNIVERSE_DEFAULT;
}

module.exports = {
  PAPER_UNIVERSE_DEFAULT,
  getPaperUniverse,
};
