#!/usr/bin/env node

/**
 * Run One Learning Cycle
 * Processes all symbols/timeframes incrementally
 */

require('dotenv').config();
const LearningDaemon = require('../services/learningDaemon');

async function runOnce() {
  console.log('🔄 Running single learning cycle...\n');

  try {
    const daemon = new LearningDaemon();
    await daemon.initialize();
    
    const results = await daemon.runCycle();
    
    const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
    const totalPatterns = results.reduce((sum, r) => sum + r.patterns, 0);
    const errors = results.filter(r => r.error).length;

    console.log('\n✅ Learning cycle complete!');
    console.log(`   Candles processed: ${totalProcessed}`);
    console.log(`   Patterns found: ${totalPatterns}`);
    if (errors > 0) {
      console.log(`   Errors: ${errors}`);
    }

  } catch (error) {
    console.error('❌ Learning cycle failed:', error.message);
    process.exit(1);
  }
}

runOnce();


