#!/usr/bin/env node

/**
 * Backfill Historical Data
 * Fetches historical OHLCV for all symbols/timeframes
 */

require('dotenv').config();
const universeLoader = require('../services/universeLoader');
const providerFactory = require('../services/providerFactory');
const patternLearningEngine = require('../services/patternLearningEngine');
const ohlcvCache = require('../services/ohlcvCache');

async function backfill() {
  console.log('🔄 Starting historical backfill...\n');

  try {
    // Initialize
    await patternLearningEngine.initialize();
    await universeLoader.load();

    const pairs = universeLoader.getSymbolTimeframePairs();
    console.log(`📊 Processing ${pairs.length} symbol/timeframe pairs\n`);

    let totalProcessed = 0;
    let totalPatterns = 0;

    for (const pair of pairs) {
      const { symbol, timeframe } = pair;
      const metadata = universeLoader.getSymbolMetadata(symbol);
      const provider = providerFactory.getProvider(metadata);
      const maxBars = universeLoader.getMaxHistoryBars(timeframe);

      console.log(`📥 Backfilling ${symbol}/${timeframe} (max ${maxBars} bars)...`);

      try {
        const result = await patternLearningEngine.processSymbolTimeframe(
          symbol,
          timeframe,
          provider,
          maxBars
        );

        totalProcessed += result.processed;
        totalPatterns += result.patterns;

        if (result.error) {
          console.log(`   ⚠️  Error: ${result.error}`);
        } else {
          console.log(`   ✅ Processed ${result.processed} candles, found ${result.patterns} patterns`);
        }
      } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
      }
    }

    // Save all patterns
    console.log('\n💾 Saving patterns...');
    await patternLearningEngine.savePatterns();

    console.log('\n✅ Backfill complete!');
    console.log(`   Total candles: ${totalProcessed}`);
    console.log(`   Total patterns: ${totalPatterns}`);
    console.log(`   Patterns saved to Google Drive and local cache`);

  } catch (error) {
    console.error('❌ Backfill failed:', error.message);
    process.exit(1);
  }
}

backfill();


