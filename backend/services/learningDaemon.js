/**
 * Learning Daemon
 * Always-on learning service that processes symbols/timeframes continuously
 */

// Load environment variables first
require('dotenv').config();

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
    this.lastError = null;
    this.pidFile = path.join(__dirname, '../../data/pids/learning.pid');
    this.heartbeatPath = path.join(__dirname, '../../data/learning/heartbeat.json');
    this.startedAt = new Date().toISOString();
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
      // Ensure heartbeat directory exists
      await fs.mkdir(path.dirname(this.heartbeatPath), { recursive: true });

      // Initialize engine
      await patternLearningEngine.initialize();

      // Initialize indicator generator
      await indicatorGenerator.initialize();

      // Load universe
      await universeLoader.load();

      // Write initial heartbeat on startup
      await this.writeHeartbeat({ candlesProcessed: 0, patterns: 0 });

      console.log(`✅ Learning daemon initialized (interval: ${this.intervalMinutes}min, concurrency: ${this.concurrency})`);
    } catch (error) {
      console.error('❌ Error initializing learning daemon:', error.message);
      // Write heartbeat even on initialization error
      this.lastError = {
        timestamp: new Date().toISOString(),
        message: error.message,
        stack: error.stack
      };
      await this.writeHeartbeat({ candlesProcessed: 0, patterns: 0 });
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
    
    // Write heartbeat on start
    await this.writeHeartbeat({ candlesProcessed: 0, patterns: 0 });

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
   * Write heartbeat file (atomic write via temp file)
   */
  async writeHeartbeat(cycleData = {}) {
    try {
      const googleDriveStorage = require('./googleDrivePatternStorage');
      const engineStats = patternLearningEngine.getStats();
      
      const heartbeat = {
        pid: process.pid,
        startedAt: this.startedAt,
        lastCycleAt: patternLearningEngine.stats.lastRun || new Date().toISOString(),
        candlesProcessed: cycleData.candlesProcessed || 0,
        patternsFound: cycleData.patterns || 0,
        patternsTotal: patternLearningEngine.patterns.size || 0,
        patternsExtracted: engineStats.patternsExtracted || 0,
        patternsDeduped: engineStats.patternsDeduped || 0,
        storageMode: googleDriveStorage.enabled && googleDriveStorage.connected ? 'GOOGLE_DRIVE_PRIMARY' : 'LOCAL_CACHE',
        googleDriveEnabled: googleDriveStorage.enabled && googleDriveStorage.connected,
        errorCount: engineStats.errors ? engineStats.errors.length : 0,
        lastError: this.lastError,
        timestamp: new Date().toISOString()
      };
      
      // Atomic write: write to temp file then rename
      const tempPath = `${this.heartbeatPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(heartbeat, null, 2), 'utf8');
      await fs.rename(tempPath, this.heartbeatPath);
    } catch (error) {
      // Don't fail cycle if heartbeat write fails
      console.warn('⚠️  Failed to write heartbeat:', error.message);
    }
  }

  /**
   * Run one learning cycle
   */
  async runCycle() {
    if (!this.isRunning) return;

    let cycleData = { candlesProcessed: 0, patterns: 0, missingCsvs: [] };
    
    try {
      this.log('INFO', 'Starting learning cycle');
      const startTime = Date.now();

      // Get all symbol/timeframe pairs
      const allPairs = universeLoader.getSymbolTimeframePairs();
      
      // Filter to only Binance symbols for scanning (if autotrader enabled)
      const symbolRouter = require('./symbolRouter');
      const enableAutotrader = process.env.ENABLE_AUTOTRADER !== 'false';
      
      const pairs = enableAutotrader 
        ? allPairs.filter(p => symbolRouter.shouldScanSymbol(p.symbol))
        : [];
      
      // Process with concurrency limit
      const results = await this.processWithConcurrency(pairs, this.concurrency);
      
      // Collect missing CSV files (summarize once per cycle)
      const missingCsvs = results
        .filter(r => r.reason === 'no_data_available' && r.provider === 'local_csv')
        .map(r => `${r.symbol}_${r.timeframe}.csv`);
      
      if (missingCsvs.length > 0) {
        cycleData.missingCsvs = missingCsvs;
        const uniqueMissing = [...new Set(missingCsvs)];
        this.log('WARN', `Missing CSV files (${uniqueMissing.length}): ${uniqueMissing.slice(0, 5).join(', ')}${uniqueMissing.length > 5 ? '...' : ''}`);
      }

      // Save patterns
      await patternLearningEngine.savePatterns();

      // Update stats
      patternLearningEngine.stats.lastRun = new Date().toISOString();
      patternLearningEngine.stats.symbolsProcessed = results.length;

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
      const totalPatterns = results.reduce((sum, r) => sum + r.patterns, 0);
      
      cycleData = { candlesProcessed: totalProcessed, patterns: totalPatterns, missingCsvs: cycleData.missingCsvs };

      this.log('INFO', `Cycle complete: ${totalProcessed} candles, ${totalPatterns} patterns in ${duration}s`);
      console.log(`✅ Learning cycle complete: ${totalProcessed} candles, ${totalPatterns} patterns`);
      
      // Write heartbeat on success
      await this.writeHeartbeat(cycleData);
      this.lastError = null; // Clear error on success

      return results;
    } catch (error) {
      const errorMsg = `Cycle failed: ${error.message}`;
      this.log('ERROR', errorMsg);
      this.lastError = {
        timestamp: new Date().toISOString(),
        message: error.message,
        stack: error.stack
      };
      console.error('❌ Learning cycle error:', error.message);
      
      // Write heartbeat even on error
      await this.writeHeartbeat(cycleData);
      
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
      // Add symbol to metadata for routing
      metadata.symbol = symbol;
      const provider = providerFactory.getProvider(metadata);
      const maxBars = universeLoader.getMaxHistoryBars(timeframe);

      const result = await patternLearningEngine.processSymbolTimeframe(
        symbol,
        timeframe,
        provider,
        maxBars
      );

      return { symbol, timeframe, provider: metadata.provider || 'unknown', ...result };
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
   * Checks PID file to determine if daemon process is actually running
   */
  async getStatus() {
    // Check if daemon process is actually running by checking PID file
    let processRunning = false;
    try {
      const pidContent = await fs.readFile(this.pidFile, 'utf8');
      const pid = parseInt(pidContent.trim(), 10);
      if (pid) {
        // Check if process exists
        try {
          const { execSync } = require('child_process');
          execSync(`ps -p ${pid} > /dev/null 2>&1`, { timeout: 500 });
          processRunning = true;
        } catch (e) {
          // Process not running - stale PID file
          processRunning = false;
        }
      }
    } catch (e) {
      // PID file doesn't exist or can't be read
      processRunning = false;
    }
    
    // If PID file says running but isRunning is false, update it
    if (processRunning && !this.isRunning) {
      this.isRunning = true;
    } else if (!processRunning && this.isRunning) {
      this.isRunning = false;
    }
    
    return {
      enabled: this.enabled,
      isRunning: this.isRunning || processRunning,
      intervalMinutes: this.intervalMinutes,
      concurrency: this.concurrency,
      queueDepth: this.queue.length,
      processing: Array.from(this.processing),
      lastRun: patternLearningEngine.stats.lastRun,
      lastError: this.lastError,
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

