'use strict';

/**
 * OANDA V2 execution mode — strict opt-in (paper-first, fail-closed).
 *
 * Live ONLY when:
 *   NEUROPILOT_EXECUTION_MODE=live (case-insensitive)
 *   AND ENABLE_LIVE_TRADING=1 (string "1" only — strictest)
 *
 * Default: paper
 * Disabled: NEUROPILOT_EXECUTION_MODE=disabled OR NEUROPILOT_EXECUTION_DISABLED=1
 */

function normalizeMode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'live') return 'live';
  if (s === 'disabled' || s === 'off' || s === 'none') return 'disabled';
  if (s === 'paper' || s === 'sim' || s === 'simulation') return 'paper';
  return null;
}

function envDisabled(env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.NEUROPILOT_EXECUTION_DISABLED || '').trim().toLowerCase());
}

/**
 * @returns {{ mode: 'disabled'|'paper'|'live'|'blocked', reasons: string[], liveArmed: boolean }}
 */
function resolveOandaExecutionMode(env = process.env) {
  const reasons = [];

  if (envDisabled(env)) {
    return { mode: 'disabled', reasons: ['NEUROPILOT_EXECUTION_DISABLED'], liveArmed: false };
  }

  const np = normalizeMode(env.NEUROPILOT_EXECUTION_MODE);
  if (np === 'disabled') {
    return { mode: 'disabled', reasons: ['NEUROPILOT_EXECUTION_MODE=disabled'], liveArmed: false };
  }

  const enableStrict = String(env.ENABLE_LIVE_TRADING || '').trim() === '1';

  if (np === 'live') {
    if (!enableStrict) {
      return {
        mode: 'blocked',
        reasons: ['live_requires_ENABLE_LIVE_TRADING_1'],
        liveArmed: false,
      };
    }
    return { mode: 'live', reasons: ['live_armed'], liveArmed: true };
  }

  if (env.NEUROPILOT_EXECUTION_MODE && np == null) {
    reasons.push(`unknown_NEUROPILOT_EXECUTION_MODE_treated_as_paper:${String(env.NEUROPILOT_EXECUTION_MODE).slice(0, 24)}`);
  }

  return { mode: 'paper', reasons: reasons.length ? reasons : ['paper_default'], liveArmed: false };
}

module.exports = {
  resolveOandaExecutionMode,
};
