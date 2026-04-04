/**
 * Regime → Strategy family mapping for the selector.
 * The selector picks the best setup within the family that matches the current regime,
 * not the global best score.
 *
 * Mapping (regime conditions → strategy bias):
 * | Regime                | Condition                          | Strategy family   |
 * |-----------------------|------------------------------------|-------------------|
 * | strong_trend_high_vol | ADX > 25 + ATR% high               | ORB / breakout    |
 * | strong_trend_moderate_vol | ADX > 25 + ATR% moderate/low  | BOS/CHOCH         |
 * | weak_trend_low_vol    | ADX < 18–20 + ATR% low             | Mean reversion     |
 * | volatile_trend       | ADX high + ATR% high (volatile)   | Super AI Elite    |
 * | ny_session_strong    | London/NY overlap (14–18 UTC)     | ORB preferred     |
 * | unstable             | else                               | Super AI Elite    |
 */

// Volatility bands (ATR% of close): below = low, above = high, else moderate
const ATR_PCT_LOW = 0.08;
const ATR_PCT_HIGH = 0.25;

// London/NY overlap (UTC): prefer ORB
const NY_OVERLAP_START = 14;
const NY_OVERLAP_END = 18;

/**
 * Derive a single regime label from computeRegime() output.
 * @param {object} regime - { trendStrength, adx, atrPct, session, utcHour } from marketRegimeService.computeRegime
 * @returns {string} regime label
 */
function regimeToLabel(regime) {
  if (!regime || !regime.ok) return 'unknown';
  const strength = (regime.trendStrength || '').toLowerCase();
  const adx = regime.adx != null ? Number(regime.adx) : null;
  const atrPct = regime.atrPct != null ? Number(regime.atrPct) : null;
  const session = (regime.session || '').toString();
  const utcHour = regime.utcHour != null ? Number(regime.utcHour) : null;

  const strongTrend = strength === 'strong' || (adx != null && adx >= 25);
  const weakTrend = strength === 'weak' || (adx != null && adx < 20);
  const moderateTrend = !strongTrend && !weakTrend;

  let volBand = 'moderate';
  if (atrPct != null) {
    if (atrPct < ATR_PCT_LOW) volBand = 'low';
    else if (atrPct > ATR_PCT_HIGH) volBand = 'high';
  }

  // NY Session Strong: London/NY overlap → ORB preferred
  const inOverlap = utcHour != null && utcHour >= NY_OVERLAP_START && utcHour < NY_OVERLAP_END;
  if ((session === 'NY' || session === 'London') && inOverlap) {
    return 'ny_session_strong';
  }

  if (strongTrend && volBand === 'high') return 'strong_trend_high_vol';
  if (strongTrend && (volBand === 'moderate' || volBand === 'low')) return 'strong_trend_moderate_vol';
  if (weakTrend && volBand === 'low') return 'weak_trend_low_vol';
  if (weakTrend && (volBand === 'high' || volBand === 'moderate')) return 'unstable';
  if (moderateTrend && volBand === 'high') return 'volatile_trend';
  if (moderateTrend) return 'unstable';
  return 'unstable';
}

/**
 * Map regime label → strategy family (selector uses this to filter setups).
 */
const REGIME_TO_FAMILY = {
  strong_trend_high_vol: 'orb',
  strong_trend_moderate_vol: 'bos_choch',
  weak_trend_low_vol: 'mean_reversion',
  volatile_trend: 'super_ai_elite',
  ny_session_strong: 'orb',
  unstable: 'super_ai_elite',
  unknown: 'super_ai_elite',
};

/**
 * Map setup_id → strategy family. Used to filter rankings by regime.
 * ORB family: single PROD setup_id = fx_nyopen20_orb2_state; orb_v1 / opening_range_breakout_v1 are archived aliases.
 */
const SETUP_TO_FAMILY = {
  super_ai_elite_v2: 'super_ai_elite',
  super_ai_elite_v2_long: 'super_ai_elite',
  super_ai_elite_v2_short: 'super_ai_elite',
  fx_nyopen20_orb2_state: 'orb', // ORB family golden (PROD)
  orb_v1: 'orb', // archived alias
  opening_range_breakout_v1: 'orb', // archived alias
  bos_choch_v1: 'bos_choch',
  nas_meanrev_v1: 'mean_reversion',
};

/** Override by symbol: map setup_id → family only for that symbol (e.g. NAS100 → mean_reversion). */
const FAMILY_OVERRIDE_BY_SYMBOL = {
  NAS100: { super_ai_elite_v2: 'mean_reversion', super_ai_elite_v2_long: 'mean_reversion', super_ai_elite_v2_short: 'mean_reversion' },
};

/** Returns family only for setup_ids present in SETUP_TO_FAMILY (whitelist). Symbol-specific override first, else base mapping. No heuristics in prod. */
function getFamilyForSetup(setupId, symbol = null) {
  const id = String(setupId || '').trim();
  const sym = symbol ? String(symbol).trim().toUpperCase() : null;
  const symOverride = sym && FAMILY_OVERRIDE_BY_SYMBOL[sym];
  if (symOverride && symOverride[id]) return symOverride[id];
  return SETUP_TO_FAMILY[id] || null;
}

function getFamilyForRegime(regimeLabel) {
  return REGIME_TO_FAMILY[regimeLabel] || REGIME_TO_FAMILY.unknown;
}

module.exports = {
  ATR_PCT_LOW,
  ATR_PCT_HIGH,
  regimeToLabel,
  REGIME_TO_FAMILY,
  SETUP_TO_FAMILY,
  getFamilyForSetup,
  getFamilyForRegime,
};
