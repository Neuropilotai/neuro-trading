'use strict';

/**
 * News signal provider — mock / JSON fixture; extensible to RSS/API later.
 * Deterministic keyword/theme mapping only in Phase 2 (no LLM).
 */

const fs = require('fs');
const path = require('path');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getNewsSignalConfig(overrides = {}) {
  const e = process.env;
  const maxAge = parseInt(e.DYNAMIC_UNIVERSE_NEWS_MAX_AGE_MINUTES || '360', 10);
  return {
    provider: String(e.DYNAMIC_UNIVERSE_NEWS_PROVIDER || 'mock').toLowerCase(),
    maxAgeMinutes: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 360,
    fixturePath:
      e.DYNAMIC_UNIVERSE_NEWS_FIXTURE_PATH || path.join(getDataDir(), 'mock_news_signals.json'),
    ...overrides,
  };
}

function normalizeNewsSignal(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: 'invalid',
      timestamp: new Date(0).toISOString(),
      headline: '',
      summary: '',
      source: 'invalid',
      categories: [],
      impactedAssets: [],
      sentimentBias: 'neutral',
      importance: 'low',
      confidence: 0,
    };
  }
  const imp = String(raw.importance || 'medium').toLowerCase();
  const importance = ['low', 'medium', 'high'].includes(imp) ? imp : 'medium';
  const sent = String(raw.sentimentBias || 'neutral').toLowerCase();
  const sentimentBias = ['bullish', 'bearish', 'mixed', 'neutral'].includes(sent) ? sent : 'neutral';
  const cats = Array.isArray(raw.categories) ? raw.categories.map((c) => String(c).toLowerCase()) : [];
  const assets = Array.isArray(raw.impactedAssets)
    ? raw.impactedAssets.map((s) => String(s).toUpperCase().trim()).filter(Boolean)
    : [];

  return {
    id: raw.id != null ? String(raw.id) : `news_${Date.now()}`,
    timestamp: raw.timestamp ? String(raw.timestamp) : new Date().toISOString(),
    headline: raw.headline != null ? String(raw.headline) : '',
    summary: raw.summary != null ? String(raw.summary) : '',
    source: raw.source != null ? String(raw.source) : 'unknown',
    categories: cats,
    impactedAssets: assets,
    sentimentBias,
    importance,
    confidence:
      raw.confidence != null && Number.isFinite(Number(raw.confidence))
        ? Math.max(0, Math.min(1, Number(raw.confidence)))
        : 0.5,
  };
}

function loadFixtureSignals(cfg) {
  const p = cfg.fixturePath;
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) return [];
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const list = Array.isArray(raw.signals) ? raw.signals : [];
  return list.map(normalizeNewsSignal);
}

/**
 * Map a signal to symbols using metadata keys (impactedAssets + category hints).
 */
function mapNewsSignalToSymbols(signal, symbolMetadata = {}) {
  const out = new Set(signal.impactedAssets || []);
  const cats = (signal.categories || []).join(' ');
  const text = `${cats} ${signal.headline} ${signal.summary}`.toLowerCase();

  const hint = (sym, keywords) => {
    if (symbolMetadata[sym]) {
      for (const k of keywords) {
        if (text.includes(k)) out.add(sym);
      }
    }
  };

  hint('BTCUSD', ['crypto', 'bitcoin', 'btc', 'digital']);
  hint('XAUUSD', ['gold', 'xau', 'safe haven', 'inflation']);
  hint('EURUSD', ['eur', 'euro', 'ecb']);
  hint('USDJPY', ['jpy', 'yen', 'boj']);
  hint('NAS100USD', ['nasdaq', 'tech', 'growth']);
  hint('SPX500USD', ['spx', 's&p', 'equity', 'broad']);

  return [...out].sort((a, b) => a.localeCompare(b));
}

function filterRelevantNewsSignals(signals, options = {}) {
  const cfg = { ...getNewsSignalConfig(), ...options };
  const nowMs = options.nowMs != null ? options.nowMs : Date.now();
  const maxAgeMs = cfg.maxAgeMinutes * 60000;

  return (signals || []).filter((s) => {
    const t = Date.parse(s.timestamp);
    if (!Number.isFinite(t)) return false;
    if (nowMs - t > maxAgeMs) return false;
    return true;
  });
}

/**
 * @returns {{ ok: boolean, signals: object[], source: string, warnings: string[] }}
 */
function getLatestNewsSignals(options = {}) {
  const cfg = { ...getNewsSignalConfig(), ...options };
  const warnings = [];
  let signals = [];

  try {
    if (cfg.provider === 'mock' || cfg.provider === 'fixture') {
      signals = loadFixtureSignals(cfg);
      if (!signals.length) warnings.push('news_fixture_empty');
    } else {
      warnings.push(`news_provider_unsupported:${cfg.provider}`);
    }
  } catch (e) {
    warnings.push(`news_load_error:${e && e.message}`);
  }

  const nowMs = options.now != null ? new Date(options.now).getTime() : Date.now();
  let filtered = filterRelevantNewsSignals(signals, { ...cfg, nowMs });
  if (filtered.length === 0 && signals.length > 0) {
    warnings.push('news_all_stale_using_fixture_fallback');
    filtered = signals.slice(0, 12);
  }
  return {
    ok: true,
    signals: filtered,
    source: cfg.provider,
    warnings,
  };
}

module.exports = {
  getNewsSignalConfig,
  getLatestNewsSignals,
  normalizeNewsSignal,
  mapNewsSignalToSymbols,
  filterRelevantNewsSignals,
};
