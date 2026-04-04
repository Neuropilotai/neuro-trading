'use strict';

/**
 * Single helper for execution mode (paper-first, live explicit opt-in, fail-closed).
 *
 * Live requires ALL of:
 * - NEUROPILOT_EXECUTION_MODE=live (case-insensitive)
 * - ENABLE_LIVE_TRADING truthy (1/true/yes/on)
 *
 * Optional alignment: TRADING_MODE=live should match for broker live routing (checked at admission).
 *
 * Disabled:
 * - NEUROPILOT_EXECUTION_MODE=disabled OR NEUROPILOT_EXECUTION_DISABLED=1
 */

function envTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function normalizeMode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'live') return 'live';
  if (s === 'disabled' || s === 'off' || s === 'none') return 'disabled';
  if (s === 'paper' || s === 'sim' || s === 'simulation') return 'paper';
  return null;
}

/**
 * @returns {{
 *   mode: 'disabled'|'paper'|'live',
 *   liveArmed: boolean,
 *   reasons: string[],
 *   raw: { neuropilotMode: string|null, enableLiveTrading: boolean, tradingMode: string }
 * }}
 */
function resolveExecutionMode(env = process.env) {
  const reasons = [];
  const neuropilotRaw = env.NEUROPILOT_EXECUTION_MODE;
  const np = normalizeMode(neuropilotRaw);

  if (envTruthy(env.NEUROPILOT_EXECUTION_DISABLED)) {
    return {
      mode: 'disabled',
      liveArmed: false,
      reasons: ['NEUROPILOT_EXECUTION_DISABLED'],
      raw: { neuropilotMode: np, enableLiveTrading: envTruthy(env.ENABLE_LIVE_TRADING), tradingMode: String(env.TRADING_MODE || 'paper').toLowerCase() },
    };
  }

  if (np === 'disabled') {
    return {
      mode: 'disabled',
      liveArmed: false,
      reasons: ['NEUROPILOT_EXECUTION_MODE=disabled'],
      raw: { neuropilotMode: np, enableLiveTrading: envTruthy(env.ENABLE_LIVE_TRADING), tradingMode: String(env.TRADING_MODE || 'paper').toLowerCase() },
    };
  }

  const enableLive = envTruthy(env.ENABLE_LIVE_TRADING);
  const tradingMode = String(env.TRADING_MODE || 'paper').toLowerCase();

  if (np === 'live') {
    if (!enableLive) {
      reasons.push('NEUROPILOT_EXECUTION_MODE=live but ENABLE_LIVE_TRADING not set (fail-closed)');
      return {
        mode: 'paper',
        liveArmed: false,
        reasons,
        raw: { neuropilotMode: np, enableLiveTrading: enableLive, tradingMode },
      };
    }
    if (tradingMode !== 'live') {
      reasons.push('NEUROPILOT_EXECUTION_MODE=live but TRADING_MODE is not live (broker routing stays non-live)');
    }
    return {
      mode: 'live',
      liveArmed: true,
      reasons: reasons.length ? reasons : ['live_fully_armed'],
      raw: { neuropilotMode: np, enableLiveTrading: enableLive, tradingMode },
    };
  }

  // NEUROPILOT_EXECUTION_MODE unset or paper (or unknown → treat as paper + note)
  if (neuropilotRaw && np == null) {
    reasons.push(`unknown_NEUROPILOT_EXECUTION_MODE_treated_as_paper:${String(neuropilotRaw).slice(0, 32)}`);
  }

  return {
    mode: 'paper',
    liveArmed: false,
    reasons: reasons.length ? reasons : ['paper_default'],
    raw: { neuropilotMode: np, enableLiveTrading: enableLive, tradingMode },
  };
}

/**
 * True only if broker may send real orders (pipeline + gate must still verify TRADING_MODE and health).
 */
function isLiveExecutionArmed(env = process.env) {
  const r = resolveExecutionMode(env);
  return r.mode === 'live' && r.liveArmed === true;
}

module.exports = {
  resolveExecutionMode,
  isLiveExecutionArmed,
  envTruthy,
};
