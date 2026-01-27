#!/usr/bin/env node

/**
 * Smoke Test: Pattern Pipeline End-to-End
 * Validates: pattern detection, filtering, attribution, SQLite writes
 * Usage: npm run smoke
 */

const path = require('path');
const fs = require('fs').promises;

// Set environment variables BEFORE requiring services
process.env.ENABLE_PATTERN_RECOGNITION = 'true';
process.env.ENABLE_PATTERN_FILTERING = 'true';
process.env.PATTERN_MIN_WIN_RATE = '0.50';
process.env.PATTERN_MIN_PROFIT_FACTOR = '1.0';
process.env.PATTERN_MIN_SAMPLE_SIZE = '10';

// Clear require cache to ensure services pick up env vars
delete require.cache[require.resolve('../backend/services/patternRecognitionService')];

const evaluationDb = require('../backend/db/evaluationDb');
const patternRecognitionService = require('../backend/services/patternRecognitionService');
const patternAttributionService = require('../backend/services/patternAttributionService');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SMOKE: pattern pipeline');
  console.log('═══════════════════════════════════════════════════════════\n');

  let exitCode = 0;

  try {
    // 1. Ensure ./data directory exists
    const dataDir = path.join(__dirname, '../data');
    await fs.mkdir(dataDir, { recursive: true });
    console.log('✓ Data directory ready');

    // 2. Initialize evaluationDb
    await evaluationDb.initialize();
    console.log('✓ Evaluation DB initialized\n');

    // 3. Prepare controlled test data (25 candles for pattern detection)
    const symbol = 'QQQ';
    const timeframe = '5min';
    const basePrice = 100.0;
    const baseTime = Date.now() - (25 * 5 * 60 * 1000); // 25 candles * 5 min * 60 sec * 1000 ms ago

    // Create candle sequence that will trigger opening gap pattern
    const candles = [];
    const previousClose = basePrice * 0.995; // Previous day close (slightly lower)
    
    for (let i = 0; i < 25; i++) {
      const timestamp = new Date(baseTime + (i * 5 * 60 * 1000)).toISOString();
      const price = basePrice + (i * 0.1) + (Math.random() * 0.2 - 0.1); // Slight uptrend with noise
      const high = price + Math.random() * 0.3;
      const low = price - Math.random() * 0.3;
      const volume = 1000000 + Math.random() * 500000;

      candles.push({
        timestamp: timestamp,
        price: price,
        close: price, // Alias for price
        high: high,
        low: low,
        volume: volume,
        previousClose: i === 0 ? previousClose : undefined // Only first candle has previousClose
      });
    }

    // First candle has gap up (triggers opening_gap_up pattern)
    candles[0].price = basePrice * 1.01; // 1% gap up
    candles[0].high = candles[0].price * 1.005;
    candles[0].low = candles[0].price * 0.995;

    console.log(`✓ Generated ${candles.length} test candles for ${symbol} (${timeframe})`);

    // 4. Run detection (simulate streaming - call for each candle)
    console.log('\n→ Running pattern detection...');
    let patternsDetected = [];

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const detected = await patternRecognitionService.detectPatterns(symbol, candle, timeframe);
      
      // Only capture patterns on last candle (after enough history)
      if (i === candles.length - 1) {
        patternsDetected = detected;
      }
    }

    if (patternsDetected.length === 0) {
      console.log('⚠️  No patterns detected (ok - may need more history or different data)');
    } else {
      console.log(`✓ Detected ${patternsDetected.length} pattern(s):`);
      patternsDetected.forEach((p, idx) => {
        const patternId = p.patternId || p.matchedPattern || 'NEW';
        console.log(`  ${idx + 1}. ${p.patternType} (id: ${patternId}, confidence: ${p.confidence?.toFixed(2) || 'N/A'})`);
      });
    }

    // 5. Seed DB with test patterns for filtering validation
    console.log('\n→ Seeding test patterns for filtering...');
    
    await evaluationDb.updatePatternPerformance('SMOKE_BAD', {
      patternType: 'double_top',
      symbol: symbol,
      timeframe: timeframe,
      totalTrades: 20,
      winningTrades: 8,
      losingTrades: 12,
      winRate: 0.40, // Below threshold
      avgReturnPct: -0.1,
      totalReturnPct: -2.0,
      profitFactor: 0.8, // Below threshold
      firstSeenDate: new Date().toISOString()
    });

    await evaluationDb.updatePatternPerformance('SMOKE_GOOD', {
      patternType: 'opening_range_breakout_up',
      symbol: symbol,
      timeframe: timeframe,
      totalTrades: 20,
      winningTrades: 12,
      losingTrades: 8,
      winRate: 0.60, // Above threshold
      avgReturnPct: 0.5,
      totalReturnPct: 10.0,
      profitFactor: 1.5, // Above threshold
      firstSeenDate: new Date().toISOString()
    });

    console.log('✓ Seeded SMOKE_BAD (win_rate=0.40, profit_factor=0.8)');
    console.log('✓ Seeded SMOKE_GOOD (win_rate=0.60, profit_factor=1.5)');

    // 6. Validate filtering behavior
    console.log('\n→ Testing pattern filtering...');
    
    const patternsForFilter = [
      { patternId: 'SMOKE_BAD', patternType: 'double_top', confidence: 0.8 },
      { patternId: 'SMOKE_GOOD', patternType: 'opening_range_breakout_up', confidence: 0.8 }
    ];

    const filtered = await patternRecognitionService.filterByPerformance(patternsForFilter);
    const filteredIds = filtered.map(p => p.patternId || p.matchedPattern).filter(Boolean);

    if (filtered.length !== 1 || !filteredIds.includes('SMOKE_GOOD')) {
      console.error('❌ FILTER FAIL: Expected only SMOKE_GOOD, got:', filteredIds);
      exitCode = 1;
    } else {
      console.log('✓ FILTER OK: Only SMOKE_GOOD passed (SMOKE_BAD filtered out)');
      console.log(`  Remaining patternIds: ${filteredIds.join(', ')}`);
    }

    // 7. Validate attribution + idempotency
    console.log('\n→ Testing trade attribution (idempotent)...');
    
    const tradeId = 'SMOKE_TRADE_1';
    const patternForAttribution = { patternId: 'SMOKE_GOOD', confidence: 0.9, patternType: 'opening_range_breakout_up' };
    const tradeResult = { pnl: 10, pnlPct: 0.2 };

    // First attribution
    await patternAttributionService.attributeTrade(tradeId, [patternForAttribution], tradeResult);
    console.log('✓ First attribution call completed');

    // Second attribution (should be idempotent - no duplicate)
    await patternAttributionService.attributeTrade(tradeId, [patternForAttribution], tradeResult);
    console.log('✓ Second attribution call completed (idempotent)');

    // Query attribution count
    const attributionRows = await evaluationDb.allAsync(
      'SELECT COUNT(*) as count FROM trade_pattern_attribution WHERE trade_id = ? AND pattern_id = ?',
      [tradeId, 'SMOKE_GOOD']
    );
    const attributionCount = attributionRows[0].count;

    if (attributionCount !== 1) {
      console.error(`❌ ATTRIBUTION FAIL: Expected 1 row, got ${attributionCount}`);
      exitCode = 1;
    } else {
      console.log(`✓ ATTRIBUTION OK: Idempotent count = ${attributionCount}`);

      // Fetch pattern performance
      const perf = await evaluationDb.getAsync(
        'SELECT total_trades, winning_trades, win_rate, profit_factor FROM pattern_performance WHERE pattern_id = ?',
        ['SMOKE_GOOD']
      );

      if (perf) {
        console.log(`  Pattern performance: total_trades=${perf.total_trades}, win_rate=${perf.win_rate?.toFixed(2) || 'N/A'}, profit_factor=${perf.profit_factor !== null ? perf.profit_factor.toFixed(2) : 'NULL'}`);
      }
    }

    // 8. Close DB if method exists
    if (typeof evaluationDb.close === 'function') {
      await evaluationDb.close();
      console.log('\n✓ Database closed');
    }

    // 9. Final status
    console.log('\n═══════════════════════════════════════════════════════════');
    if (exitCode === 0) {
      console.log('✅ SMOKE TEST PASSED');
    } else {
      console.log('❌ SMOKE TEST FAILED');
    }
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ SMOKE TEST ERROR:', error.message);
    console.error(error.stack);
    exitCode = 1;
  }

  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = { main };

