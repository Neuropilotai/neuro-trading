/**
 * Learning Daemon
 * Always-on learning service that processes symbols/timeframes continuously
 */

const { Worker, isMainThread, parentPort } = require('worker_threads');
const universeLoader = require('./universeLoader');
const providerFactory = require('./providerFactory');
const patternLearningEngine = require('./patternLearningEngine');
const indicatorGenerator = require('./indicatorGenerator');
const fs = require('fs').promises;
const path = require('path');

class LearningDaemon {
  constructor() {
    this.enabled = process.env.ENABLE_PATTERN_LEARNING !== 'false';
    // Scalping: Faster intervals (1-2 minutes for 1min/5min timeframes)
    this.intervalMinutes = parseInt(process.env.LEARN_INTERVAL_MINUTES || '1', 10);
    this.concurrency = parseInt(process.env.LEARN_CONCURRENCY || '4', 10);
    this.isRunning = false;
    this.intervalId = null;
    this.queue = [];
    this.processing = new Set();
    this.logPath = path.join(__dirname, '../../data/logs/learning.log');
  }

  /**
   * Initialize daemon
   */
  async initialize() {
    if (!this.enabled) {
      console.log('⚠️  Learning daemon is DISABLED');
      return;
    }

    try {
      // Ensure log directory exists
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });

      // Initialize engine
      await patternLearningEngine.initialize();

      // Initialize indicator generator
      await indicatorGenerator.initialize();

      // Load universe
      await universeLoader.load();

      console.log(`✅ Learning daemon initialized (interval: ${this.intervalMinutes}min, concurrency: ${this.concurrency})`);
    } catch (error) {
      console.error('❌ Error initializing learning daemon:', error.message);
      throw error;
    }
  }

  /**
   * Start daemon
   */
  async start() {
    if (!this.enabled) {
      console.log('⚠️  Learning daemon is DISABLED');
      return;
    }

    if (this.isRunning) {
      console.log('⚠️  Learning daemon is already running');
      return;
    }

    this.isRunning = true;
    this.log('INFO', 'Learning daemon started');

    // Run immediately
    await this.runCycle();

    // Then run on interval
    this.intervalId = setInterval(async () => {
      await this.runCycle();
    }, this.intervalMinutes * 60 * 1000);

    console.log(`✅ Learning daemon started (runs every ${this.intervalMinutes} minutes)`);
  }

  /**
   * Stop daemon
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.log('INFO', 'Learning daemon stopped');
    console.log('🛑 Learning daemon stopped');
  }

  /**
   * Run one learning cycle
   */
  async runCycle() {
    if (!this.isRunning) return;

    try {
      this.log('INFO', 'Starting learning cycle');
      const startTime = Date.now();

      // Get all symbol/timeframe pairs
      const pairs = universeLoader.getSymbolTimeframePairs();
      
      // Process with concurrency limit
      const results = await this.processWithConcurrency(pairs, this.concurrency);

      // Save patterns
      await patternLearningEngine.savePatterns();

      // Update stats
      patternLearningEngine.stats.lastRun = new Date().toISOString();
      patternLearningEngine.stats.symbolsProcessed = results.length;

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
      const totalPatterns = results.reduce((sum, r) => sum + r.patterns, 0);

      this.log('INFO', `Cycle complete: ${totalProcessed} candles, ${totalPatterns} patterns in ${duration}s`);
      console.log(`✅ Learning cycle complete: ${totalProcessed} candles, ${totalPatterns} patterns`);

      return results;
    } catch (error) {
      this.log('ERROR', `Cycle failed: ${error.message}`);
      console.error('❌ Learning cycle error:', error.message);
      throw error;
    }
  }

  /**
   * Process pairs with concurrency limit
   */
  async processWithConcurrency(pairs, concurrency) {
    const results = [];
    const queue = [...pairs];
    const workers = [];

    // Process in batches
    while (queue.length > 0 || workers.length > 0) {
      // Start new workers up to concurrency limit
      while (workers.length < concurrency && queue.length > 0) {
        const pair = queue.shift();
        const worker = this.processPair(pair);
        workers.push(worker);
      }

      // Wait for one worker to complete
      if (workers.length > 0) {
        const result = await Promise.race(workers);
        results.push(result);
        workers.splice(workers.indexOf(result), 1);
      }
    }

    return results;
  }

  /**
   * Process single symbol/timeframe pair
   */
  async processPair(pair) {
    const { symbol, timeframe } = pair;
    
    try {
      const metadata = universeLoader.getSymbolMetadata(symbol);
      const provider = providerFactory.getProvider(metadata);
      const maxBars = universeLoader.getMaxHistoryBars(timeframe);

      const result = await patternLearningEngine.processSymbolTimeframe(
        symbol,
        timeframe,
        provider,
        maxBars
      );

      return { symbol, timeframe, ...result };
    } catch (error) {
      this.log('ERROR', `${symbol}/${timeframe}: ${error.message}`);
      return { symbol, timeframe, processed: 0, patterns: 0, error: error.message };
    }
  }

  /**
   * Log message
   */
  async log(level, message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;

    try {
      await fs.appendFile(this.logPath, logLine, 'utf8');
    } catch (error) {
      console.error('❌ Error writing to log:', error.message);
    }

    // Also log to console for important messages
    if (level === 'ERROR' || level === 'WARN') {
      console.log(logLine.trim());
    }
  }

  /**
   * Get daemon status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      intervalMinutes: this.intervalMinutes,
      concurrency: this.concurrency,
      queueDepth: this.queue.length,
      processing: Array.from(this.processing),
      lastRun: patternLearningEngine.stats.lastRun,
      stats: patternLearningEngine.getStats()
    };
  }
}

// If running as main module, start daemon
if (require.main === module) {
  const daemon = new LearningDaemon();
  
  daemon.initialize().then(() => {
    daemon.start();
  }).catch(error => {
    console.error('❌ Failed to start daemon:', error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down learning daemon...');
    daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down...');
    daemon.stop();
    process.exit(0);
  });
}

module.exports = LearningDaemon;

