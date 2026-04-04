'use strict';

/**
 * UTC-day counters for Wave 1 paper trades (Paper Execution V1).
 * Enable with NEUROPILOT_WAVE1_PAPER_ENABLED=1 and NEUROPILOT_WAVE1_SYMBOLS (CSV).
 * Caps: NEUROPILOT_WAVE1_MAX_TRADES_PER_SYMBOL_PER_DAY (default 3, 0=off),
 *       NEUROPILOT_WAVE1_MAX_TRADES_TOTAL_PER_DAY (default 15, 0=off).
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function envBool(name) {
  const v = (process.env[name] || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function capStatePath() {
  return path.join(dataRoot.getPath('governance', true), 'wave1_paper_cap_state.json');
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function readCapState() {
  const p = capStatePath();
  const base = { dayUtc: null, bySymbol: {}, total: 0 };
  if (!fs.existsSync(p)) return { ...base };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      dayUtc: j.dayUtc != null ? String(j.dayUtc).slice(0, 10) : null,
      bySymbol:
        j.bySymbol && typeof j.bySymbol === 'object' && !Array.isArray(j.bySymbol) ? { ...j.bySymbol } : {},
      total: Number.isFinite(Number(j.total)) ? Math.floor(Number(j.total)) : 0,
    };
  } catch (_) {
    return { ...base };
  }
}

function writeCapState(s) {
  const p = capStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function maxPerSymbol() {
  const raw = process.env.NEUROPILOT_WAVE1_MAX_TRADES_PER_SYMBOL_PER_DAY;
  if (raw === undefined || String(raw).trim() === '') return 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3;
  if (n === 0) return null;
  return Math.floor(n);
}

function maxTotal() {
  const raw = process.env.NEUROPILOT_WAVE1_MAX_TRADES_TOTAL_PER_DAY;
  if (raw === undefined || String(raw).trim() === '') return 15;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 15;
  if (n === 0) return null;
  return Math.floor(n);
}

/**
 * @param {string} symbolUpper
 * @returns {{ ok: boolean, reason?: string }}
 */
function canAppendWave1Paper(symbolUpper) {
  const sym = String(symbolUpper || '').toUpperCase().trim();
  if (!sym) return { ok: false, reason: 'missing_symbol' };
  const s = readCapState();
  const today = utcDay();
  if (s.dayUtc !== today) {
    s.dayUtc = today;
    s.bySymbol = {};
    s.total = 0;
    writeCapState(s);
  }

  const per = maxPerSymbol();
  const tot = maxTotal();
  const nSym = Number(s.bySymbol[sym]) || 0;
  if (per != null && nSym >= per) return { ok: false, reason: 'wave1_paper_symbol_cap' };
  if (tot != null && s.total >= tot) return { ok: false, reason: 'wave1_paper_total_cap' };
  return { ok: true };
}

/**
 * @param {string} symbolUpper
 */
function recordWave1PaperAppend(symbolUpper) {
  const sym = String(symbolUpper || '').toUpperCase().trim();
  if (!sym) return;
  const s = readCapState();
  const today = utcDay();
  if (s.dayUtc !== today) {
    s.dayUtc = today;
    s.bySymbol = {};
    s.total = 0;
  }
  s.bySymbol[sym] = (Number(s.bySymbol[sym]) || 0) + 1;
  s.total = (Number(s.total) || 0) + 1;
  writeCapState(s);
}

function isWave1PaperPolicyEnabled() {
  return envBool('NEUROPILOT_WAVE1_PAPER_ENABLED');
}

module.exports = {
  isWave1PaperPolicyEnabled,
  canAppendWave1Paper,
  recordWave1PaperAppend,
};
