'use strict';

/**
 * Economic calendar provider — mock / JSON fixture first; swappable for live APIs later.
 * No network required for default mock mode.
 */

const fs = require('fs');
const path = require('path');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function parseBool(v, defaultValue = true) {
  if (v === undefined || v === null || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function getMacroCalendarConfig(overrides = {}) {
  const e = process.env;
  return {
    provider: String(e.DYNAMIC_UNIVERSE_CALENDAR_PROVIDER || 'mock').toLowerCase(),
    lookaheadHours: Math.max(1, parseInt(e.DYNAMIC_UNIVERSE_CALENDAR_LOOKAHEAD_HOURS || '24', 10) || 24),
    fixturePath:
      e.DYNAMIC_UNIVERSE_CALENDAR_FIXTURE_PATH ||
      path.join(getDataDir(), 'mock_macro_calendar.json'),
    ...overrides,
  };
}

/**
 * @returns {object} normalized event
 */
function normalizeMacroEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: 'invalid',
      timestamp: new Date(0).toISOString(),
      currency: '',
      country: '',
      title: '',
      importance: 'low',
      category: 'unknown',
      actual: null,
      forecast: null,
      previous: null,
      source: 'invalid',
    };
  }
  const imp = String(raw.importance || 'medium').toLowerCase();
  const importance = ['low', 'medium', 'high'].includes(imp) ? imp : 'medium';
  const cat = String(raw.category || 'unknown').toLowerCase();
  return {
    id: raw.id != null ? String(raw.id) : `evt_${Date.now()}`,
    timestamp: raw.timestamp ? String(raw.timestamp) : new Date().toISOString(),
    currency: raw.currency != null ? String(raw.currency).toUpperCase() : '',
    country: raw.country != null ? String(raw.country) : '',
    title: raw.title != null ? String(raw.title) : '',
    importance,
    category: cat,
    actual: raw.actual != null ? raw.actual : null,
    forecast: raw.forecast != null ? raw.forecast : null,
    previous: raw.previous != null ? raw.previous : null,
    source: raw.source != null ? String(raw.source) : 'unknown',
  };
}

function loadFixtureEvents(cfg) {
  const p = cfg.fixturePath;
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const list = Array.isArray(raw.events) ? raw.events : [];
  return list.map(normalizeMacroEvent);
}

function embeddedMockEvents() {
  const now = Date.now();
  return [
    normalizeMacroEvent({
      id: 'embedded_usd_placeholder',
      timestamp: new Date(now + 2 * 3600000).toISOString(),
      currency: 'USD',
      country: 'US',
      title: 'Placeholder USD event',
      importance: 'high',
      category: 'rates',
      source: 'embedded_mock',
    }),
  ];
}

/**
 * @param {object} options - merged with getMacroCalendarConfig()
 * @returns {{ ok: boolean, events: object[], source: string, warnings: string[] }}
 */
function getUpcomingMacroEvents(options = {}) {
  const cfg = { ...getMacroCalendarConfig(), ...options };
  const warnings = [];
  const now = options.now != null ? new Date(options.now).getTime() : Date.now();
  const horizon = now + cfg.lookaheadHours * 3600000;

  let events = [];
  try {
    if (cfg.provider === 'mock' || cfg.provider === 'fixture') {
      events = loadFixtureEvents(cfg);
      if (!events.length) {
        events = embeddedMockEvents();
        warnings.push('calendar_fixture_empty_using_embedded');
      }
    } else {
      warnings.push(`calendar_provider_unsupported:${cfg.provider}`);
      events = embeddedMockEvents();
    }
  } catch (e) {
    warnings.push(`calendar_load_error:${e && e.message}`);
    events = embeddedMockEvents();
  }

  let filtered = filterRelevantMacroEvents(events, { nowMs: now, horizonMs: horizon, ...options });
  if (filtered.length === 0 && events.length > 0) {
    warnings.push('calendar_no_events_in_window_using_fixture_fallback');
    filtered = events.slice(0, 12);
  }
  return {
    ok: true,
    events: filtered,
    source: cfg.provider,
    warnings,
  };
}

/**
 * Keep events in [now, now+lookahead] and optional currency/importance filters.
 */
function filterRelevantMacroEvents(events, options = {}) {
  const nowMs = options.nowMs != null ? options.nowMs : Date.now();
  const horizonMs = options.horizonMs != null ? options.horizonMs : nowMs + 24 * 3600000;
  const minImp = options.minImportance || null;

  const rank = { low: 1, medium: 2, high: 3 };
  const minR = minImp && rank[String(minImp).toLowerCase()] ? rank[String(minImp).toLowerCase()] : 0;

  return (events || [])
    .filter((ev) => {
      const t = Date.parse(ev.timestamp);
      if (!Number.isFinite(t)) return false;
      if (t < nowMs - 60000 || t > horizonMs) return false;
      if (minR > 0) {
        const r = rank[ev.importance] || 0;
        if (r < minR) return false;
      }
      return true;
    })
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

module.exports = {
  getMacroCalendarConfig,
  getUpcomingMacroEvents,
  normalizeMacroEvent,
  filterRelevantMacroEvents,
};
