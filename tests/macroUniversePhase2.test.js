#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const macroCalendarProvider = require('../backend/services/macroCalendarProvider');
const newsSignalProvider = require('../backend/services/newsSignalProvider');
const macroScoringService = require('../backend/services/macroScoringService');
const dynamicUniverseManager = require('../backend/services/dynamicUniverseManager');

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'macro-uni-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function run() {
  console.log('macroUniversePhase2 tests…');

  const ev = macroCalendarProvider.normalizeMacroEvent({
    id: 't',
    timestamp: new Date().toISOString(),
    currency: 'USD',
    country: 'US',
    title: 'Test',
    importance: 'HIGH',
    category: 'inflation',
    source: 'unit',
  });
  assert.strictEqual(ev.importance, 'high');

  const cal = macroCalendarProvider.getUpcomingMacroEvents({ lookaheadHours: 168 });
  assert.ok(Array.isArray(cal.events));
  assert.ok(cal.ok);

  const news = newsSignalProvider.getLatestNewsSignals({ maxAgeMinutes: 999999 });
  assert.ok(news.signals.length >= 0);

  const sens = macroScoringService.getSymbolMacroSensitivityMap();
  assert.ok(sens.XAUUSD.usd > 0);

  await withTempDataDir(async () => {
    process.env.DYNAMIC_UNIVERSE_MACRO_ENABLED = 'true';
    process.env.DYNAMIC_UNIVERSE_NEWS_ENABLED = 'true';
    process.env.DYNAMIC_UNIVERSE_CALENDAR_ENABLED = 'true';
    process.env.DYNAMIC_UNIVERSE_WRITE_SNAPSHOT = 'false';
    process.env.DYNAMIC_UNIVERSE_MACRO_WRITE_SNAPSHOT = 'false';
    const r = dynamicUniverseManager.buildDynamicUniverse({
      config: {
        maxActiveSymbols: 4,
        maxWatchlistSymbols: 2,
        macroEnabled: true,
        newsEnabled: true,
        calendarEnabled: true,
        writeSnapshot: false,
        macroWriteSnapshot: false,
      },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.version, dynamicUniverseManager.MODULE_VERSION_MACRO);
    assert.ok(r.macroContext);
    assert.ok(r.diagnostics.newsSignalCount >= 0);
    assert.ok(Array.isArray(r.scores));
    const xau = r.scores.find((s) => s.symbol === 'XAUUSD');
    assert.ok(xau);
    assert.ok(xau.components.baseUniverseScore != null || xau.components.enabledByDefault != null);
    delete process.env.DYNAMIC_UNIVERSE_MACRO_ENABLED;
    delete process.env.DYNAMIC_UNIVERSE_NEWS_ENABLED;
    delete process.env.DYNAMIC_UNIVERSE_CALENDAR_ENABLED;
  });

  console.log('✅ macroUniversePhase2 tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
