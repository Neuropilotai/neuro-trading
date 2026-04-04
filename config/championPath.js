/**
 * Champion path vs archived datasets.
 * - Champion path: setups used for learning/selector (recent data, fast & clean).
 * - Archived: importable for reference but excluded from rankings and from champion selection.
 *
 * Recommendation:
 * - Champion: super_ai_elite_v2 with recent data (2025–2026).
 * - Archive: TF=5 long history (2006→2022) → import under ultrascalp_v4_history; not on champion path.
 */

/** Setup IDs that are allowed for import but excluded from setup_rankings and champion selection */
const CHAMPION_EXCLUDED_SETUP_IDS = [
  'ultrascalp_v4_history',
  'orb_v1',
  'opening_range_breakout_v1',
];

/** All setup IDs allowed for import (champion + archive). Deduplicated via Set. ORB family: single PROD = fx_nyopen20_orb2_state. */
const ALLOWED_SETUP_IDS = Array.from(new Set([
  'super_ai_elite_v2',
  'super_ai_elite_v2_long',
  'super_ai_elite_v2_short',
  'fx_nyopen20_orb2_state', // ORB golden (PROD)
  'bos_choch_v1',
  // legacy allowed for import (but excluded from champion path)
  ...CHAMPION_EXCLUDED_SETUP_IDS,
]));

/** When true, accept any setup_id matching ALLOWED_SETUP_ID_REGEX. Otherwise only whitelist. */
const ALLOW_ANY_SETUP_ID = process.env.ALLOW_ANY_SETUP_ID === 'true';

/** Regex for setup_id when ALLOW_ANY_SETUP_ID=true: 3–64 chars, lowercase letters, digits, underscore. */
const ALLOWED_SETUP_ID_REGEX = /^[a-z0-9_]{3,64}$/;

/**
 * Whether setup_id is allowed for import.
 * If ALLOW_ANY_SETUP_ID=true → must match ^[a-z0-9_]{3,64}$.
 * Otherwise → must be in ALLOWED_SETUP_IDS.
 */
function isSetupIdAllowedForImport(setupId) {
  const id = (setupId || '').toString().trim();
  if (ALLOW_ANY_SETUP_ID) {
    return ALLOWED_SETUP_ID_REGEX.test(id);
  }
  return ALLOWED_SETUP_IDS.includes(id);
}

/** Map alias setup_id → canonical setup_id. Used at import so research_backtests stores only canonical IDs. */
const SETUP_ALIAS_OF = {
  orb_v1: 'fx_nyopen20_orb2_state',
  opening_range_breakout_v1: 'fx_nyopen20_orb2_state',
};

/**
 * Per-setup options (config/ranking). Default for missing key: true.
 * ALLOW_SHORTS=false → shorts are filtered at import and rejected at single-trade POST.
 */
const SETUP_ALLOW_SHORTS = {
  fx_nyopen20_orb2_state: false,
};

function canonicalSetupId(setupId) {
  const id = (setupId || '').toString().trim();
  return SETUP_ALIAS_OF[id] || id;
}

/** Whether this setup allows short trades. Uses canonical setup_id; default true. */
function allowShortsForSetup(setupId) {
  const canonical = canonicalSetupId(setupId);
  if (SETUP_ALLOW_SHORTS.hasOwnProperty(canonical)) {
    return SETUP_ALLOW_SHORTS[canonical] === true;
  }
  return true;
}

function isExcludedFromChampion(setupId) {
  return CHAMPION_EXCLUDED_SETUP_IDS.includes(String(setupId || '').trim());
}

module.exports = {
  CHAMPION_EXCLUDED_SETUP_IDS,
  ALLOWED_SETUP_IDS,
  ALLOW_ANY_SETUP_ID,
  ALLOWED_SETUP_ID_REGEX,
  SETUP_ALIAS_OF,
  SETUP_ALLOW_SHORTS,
  canonicalSetupId,
  allowShortsForSetup,
  isExcludedFromChampion,
  isSetupIdAllowedForImport,
};
