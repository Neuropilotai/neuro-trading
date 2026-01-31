/**
 * Pattern Filtering Unit Tests
 * Tests for pattern performance validation and filtering
 */

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;
const EvaluationDatabase = require('../backend/db/evaluationDb');
const PatternAttributionService = require('../backend/services/patternAttributionService');

describe('Pattern Performance Filtering', () => {
  let testDb;
  let testDbPath;
  let evaluationDb;
  let patternAttributionService;

  before(async () => {
    // Create in-memory database for testing
    testDbPath = path.join(__dirname, '../data/test_evaluation.db');
    
    // Ensure data directory exists
    const dataDir = path.dirname(testDbPath);
    await fs.mkdir(dataDir, { recursive: true });

    // Remove test DB if exists
    try {
      await fs.unlink(testDbPath);
    } catch (e) {
      // Ignore if doesn't exist
    }

    // Create test database
    testDb = new sqlite3.Database(testDbPath);
    
    // Initialize schema
    const schemaPath = path.join(__dirname, '../backend/db/evaluationSchema.sql');
    const schema = await fs.readFile(schemaPath, 'utf8');
    
    await new Promise((resolve, reject) => {
      testDb.exec(schema, (err) => {
        if (err) reject(err);
        else {
          // Add profit_factor column
          testDb.run('ALTER TABLE pattern_performance ADD COLUMN profit_factor REAL', () => {
            resolve();
          });
        }
      });
    });

    // Create evaluationDb instance and override db connection
    evaluationDb = require('../backend/db/evaluationDb');
    evaluationDb.db = testDb;
    evaluationDb.dbPath = testDbPath;

    patternAttributionService = require('../backend/services/patternAttributionService');
  });

  after(async () => {
    if (testDb) {
      await new Promise((resolve, reject) => {
        testDb.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    
    // Clean up test database
    try {
      await fs.unlink(testDbPath);
    } catch (e) {
      // Ignore
    }
  });

  beforeEach(async () => {
    // Clear tables before each test
    await evaluationDb.runAsync('DELETE FROM trade_pattern_attribution');
    await evaluationDb.runAsync('DELETE FROM pattern_performance');
  });

  describe('Pattern Performance Storage', () => {
    it('should calculate and store profit_factor correctly', async () => {
      const patternId = 'TEST_PATTERN_1';
      
      // Create pattern performance record
      await evaluationDb.updatePatternPerformance(patternId, {
        patternType: 'double_top',
        symbol: 'AAPL',
        timeframe: '5min',
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        avgReturnPct: 0,
        totalReturnPct: 0,
        profitFactor: null,
        firstSeenDate: new Date().toISOString()
      });

      // Update pattern performance via attributeTrade (idempotent - can be called multiple times)
      await patternAttributionService.attributeTrade('TRADE_1', [{ patternId, confidence: 0.8, patternType: 'double_top' }], { pnl: 100, pnlPct: 1.0 });
      await patternAttributionService.attributeTrade('TRADE_2', [{ patternId, confidence: 0.8, patternType: 'double_top' }], { pnl: 50, pnlPct: 0.5 });
      await patternAttributionService.attributeTrade('TRADE_3', [{ patternId, confidence: 0.8, patternType: 'double_top' }], { pnl: -30, pnlPct: -0.3 });
      await patternAttributionService.attributeTrade('TRADE_4', [{ patternId, confidence: 0.8, patternType: 'double_top' }], { pnl: -20, pnlPct: -0.2 });

      // Get pattern performance using async helper
      const perf = await evaluationDb.getAsync(
        'SELECT profit_factor FROM pattern_performance WHERE pattern_id = ?',
        [patternId]
      );

      // Profit factor = (100 + 50) / (30 + 20) = 150 / 50 = 3.0
      assert.strictEqual(perf.profit_factor, 3.0, 'Profit factor should be 3.0');
    });

    it('should handle profit_factor when there are no losses', async () => {
      const patternId = 'TEST_PATTERN_2';
      
      await evaluationDb.updatePatternPerformance(patternId, {
        patternType: 'double_bottom',
        symbol: 'TSLA',
        timeframe: '5min',
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        avgReturnPct: 0,
        totalReturnPct: 0,
        profitFactor: null,
        firstSeenDate: new Date().toISOString()
      });

      // Add only winning trades
      await patternAttributionService.attributeTrade('TRADE_5', [{ patternId, confidence: 0.8, patternType: 'double_bottom' }], { pnl: 100, pnlPct: 1.0 });
      await patternAttributionService.attributeTrade('TRADE_6', [{ patternId, confidence: 0.8, patternType: 'double_bottom' }], { pnl: 50, pnlPct: 0.5 });

      // Get pattern performance using async helper
      const perf = await evaluationDb.getAsync(
        'SELECT profit_factor FROM pattern_performance WHERE pattern_id = ?',
        [patternId]
      );

      // Should be NULL when no losses (Infinity is not reliably stored in SQLite)
      assert.strictEqual(perf.profit_factor, null, 'Profit factor should be NULL when no losses (not Infinity)');
    });
  });

  describe('Pattern Filtering', () => {
    it('should filter out pattern with insufficient sample size', async () => {
      const patternId = 'PATTERN_LOW_SAMPLE';
      
      // Create pattern with only 5 trades (below minimum of 10)
      await evaluationDb.updatePatternPerformance(patternId, {
        patternType: 'opening_gap',
        symbol: 'AAPL',
        timeframe: '5min',
        totalTrades: 5,
        winningTrades: 3,
        losingTrades: 2,
        winRate: 0.6,
        avgReturnPct: 0.5,
        totalReturnPct: 2.5,
        profitFactor: 1.5,
        firstSeenDate: new Date().toISOString()
      });

      const validated = await evaluationDb.getValidatedPatterns({
        minWinRate: 0.50,
        minProfitFactor: 1.0,
        minSampleSize: 10
      });

      assert.strictEqual(validated.includes(patternId), false, 'Pattern with insufficient sample size should be filtered out');
    });

    it('should filter out pattern with win_rate below threshold', async () => {
      const patternId = 'PATTERN_LOW_WINRATE';
      
      // Create pattern with win_rate 0.4 (below minimum of 0.50)
      await evaluationDb.updatePatternPerformance(patternId, {
        patternType: 'double_top',
        symbol: 'TSLA',
        timeframe: '5min',
        totalTrades: 20,
        winningTrades: 8,
        losingTrades: 12,
        winRate: 0.4,
        avgReturnPct: -0.2,
        totalReturnPct: -4.0,
        profitFactor: 0.8,
        firstSeenDate: new Date().toISOString()
      });

      const validated = await evaluationDb.getValidatedPatterns({
        minWinRate: 0.50,
        minProfitFactor: 1.0,
        minSampleSize: 10
      });

      assert.strictEqual(validated.includes(patternId), false, 'Pattern with low win_rate should be filtered out');
    });

    it('should filter out pattern with profit_factor below threshold', async () => {
      const patternId = 'PATTERN_LOW_PROFIT_FACTOR';
      
      // Create pattern with profit_factor 0.8 (below minimum of 1.0)
      await evaluationDb.updatePatternPerformance(patternId, {
        patternType: 'support_bounce',
        symbol: 'MSFT',
        timeframe: '5min',
        totalTrades: 15,
        winningTrades: 9,
        losingTrades: 6,
        winRate: 0.6,
        avgReturnPct: 0.1,
        totalReturnPct: 1.5,
        profitFactor: 0.8,
        firstSeenDate: new Date().toISOString()
      });

      const validated = await evaluationDb.getValidatedPatterns({
        minWinRate: 0.50,
        minProfitFactor: 1.0,
        minSampleSize: 10
      });

      assert.strictEqual(validated.includes(patternId), false, 'Pattern with low profit_factor should be filtered out');
    });

    it('should return pattern meeting all thresholds', async () => {
      const patternId = 'PATTERN_VALID';
      
      // Create pattern meeting all thresholds
      await evaluationDb.updatePatternPerformance(patternId, {
        patternType: 'opening_range_breakout',
        symbol: 'AAPL',
        timeframe: '5min',
        totalTrades: 20,
        winningTrades: 12,
        losingTrades: 8,
        winRate: 0.6,
        avgReturnPct: 0.5,
        totalReturnPct: 10.0,
        profitFactor: 1.5,
        firstSeenDate: new Date().toISOString()
      });

      const validated = await evaluationDb.getValidatedPatterns({
        minWinRate: 0.50,
        minProfitFactor: 1.0,
        minSampleSize: 10
      });

      assert.strictEqual(validated.includes(patternId), true, 'Pattern meeting all thresholds should be returned');
    });

    it('should handle NULL profit_factor correctly', async () => {
      const patternId1 = 'PATTERN_NULL_PF_1';
      const patternId2 = 'PATTERN_NULL_PF_2';
      
      // Pattern with NULL profit_factor and minProfitFactor = 0 (should pass)
      await evaluationDb.updatePatternPerformance(patternId1, {
        patternType: 'opening_gap',
        symbol: 'AAPL',
        timeframe: '5min',
        totalTrades: 15,
        winningTrades: 10,
        losingTrades: 5,
        winRate: 0.67,
        avgReturnPct: 0.3,
        totalReturnPct: 4.5,
        profitFactor: null,
        firstSeenDate: new Date().toISOString()
      });

      // Pattern with NULL profit_factor and minProfitFactor = 1.0 (should pass — NULL treated as infinite PF)
      await evaluationDb.updatePatternPerformance(patternId2, {
        patternType: 'double_bottom',
        symbol: 'TSLA',
        timeframe: '5min',
        totalTrades: 15,
        winningTrades: 10,
        losingTrades: 5,
        winRate: 0.67,
        avgReturnPct: 0.3,
        totalReturnPct: 4.5,
        profitFactor: null,
        firstSeenDate: new Date().toISOString()
      });

      // With minProfitFactor = 0, NULL should pass
      const validated1 = await evaluationDb.getValidatedPatterns({
        minWinRate: 0.50,
        minProfitFactor: 0,
        minSampleSize: 10
      });
      assert.strictEqual(validated1.includes(patternId1), true, 'NULL profit_factor should pass when threshold is 0');

      // With minProfitFactor = 1.0, NULL should FAIL (conservative: no data = reject)
      const validated2 = await evaluationDb.getValidatedPatterns({
        minWinRate: 0.50,
        minProfitFactor: 1.0,
        minSampleSize: 10
      });
      assert.strictEqual(
        validated2.includes(patternId2),
        false,
        'NULL profit_factor should fail when threshold > 0 (conservative: no data = reject)'
      );
    });
  });

  describe('Pattern Recognition Service Integration', () => {
    it('should filter patterns when ENABLE_PATTERN_FILTERING=true', async () => {
      // Set environment variables
      process.env.ENABLE_PATTERN_FILTERING = 'true';
      process.env.PATTERN_MIN_WIN_RATE = '0.50';
      process.env.PATTERN_MIN_PROFIT_FACTOR = '1.0';
      process.env.PATTERN_MIN_SAMPLE_SIZE = '10';

      // Reload pattern recognition service to pick up env vars
      delete require.cache[require.resolve('../backend/services/patternRecognitionService')];
      const patternRecognitionService = require('../backend/services/patternRecognitionService');

      // Create invalid pattern (low profit_factor)
      const invalidPatternId = 'INVALID_PATTERN';
      await evaluationDb.updatePatternPerformance(invalidPatternId, {
        patternType: 'double_top',
        symbol: 'AAPL',
        timeframe: '5min',
        totalTrades: 15,
        winningTrades: 8,
        losingTrades: 7,
        winRate: 0.53,
        avgReturnPct: 0.1,
        totalReturnPct: 1.5,
        profitFactor: 0.8, // Below threshold
        firstSeenDate: new Date().toISOString()
      });

      // Create valid pattern
      const validPatternId = 'VALID_PATTERN';
      await evaluationDb.updatePatternPerformance(validPatternId, {
        patternType: 'opening_range_breakout',
        symbol: 'AAPL',
        timeframe: '5min',
        totalTrades: 20,
        winningTrades: 12,
        losingTrades: 8,
        winRate: 0.6,
        avgReturnPct: 0.5,
        totalReturnPct: 10.0,
        profitFactor: 1.5,
        firstSeenDate: new Date().toISOString()
      });

      // Simulate patterns with patternIds
      const patterns = [
        { patternId: invalidPatternId, patternType: 'double_top', confidence: 0.7 },
        { patternId: validPatternId, patternType: 'opening_range_breakout', confidence: 0.8 }
      ];

      // Filter patterns
      const filtered = await patternRecognitionService.filterByPerformance(patterns);

      // Should only return valid pattern
      assert.strictEqual(filtered.length, 1, 'Should filter out invalid pattern');
      assert.strictEqual(filtered[0].patternId, validPatternId, 'Should return only valid pattern');

      // Clean up
      delete process.env.ENABLE_PATTERN_FILTERING;
      delete process.env.PATTERN_MIN_WIN_RATE;
      delete process.env.PATTERN_MIN_PROFIT_FACTOR;
      delete process.env.PATTERN_MIN_SAMPLE_SIZE;
    });

    it('should return all patterns when ENABLE_PATTERN_FILTERING=false', async () => {
      // Set environment variable
      process.env.ENABLE_PATTERN_FILTERING = 'false';

      // Reload pattern recognition service
      delete require.cache[require.resolve('../backend/services/patternRecognitionService')];
      const patternRecognitionService = require('../backend/services/patternRecognitionService');

      const patterns = [
        { patternId: 'PATTERN_1', patternType: 'double_top', confidence: 0.7 },
        { patternId: 'PATTERN_2', patternType: 'opening_gap', confidence: 0.8 }
      ];

      // Filter patterns
      const filtered = await patternRecognitionService.filterByPerformance(patterns);

      // Should return all patterns (backward compatible)
      assert.strictEqual(filtered.length, 2, 'Should return all patterns when filtering disabled');

      // Clean up
      delete process.env.ENABLE_PATTERN_FILTERING;
    });
  });

  describe('getPatternPerformance Helper', () => {
    it('should return pattern performance for multiple pattern IDs', async () => {
      const patternId1 = 'PERF_PATTERN_1';
      const patternId2 = 'PERF_PATTERN_2';
      
      await evaluationDb.updatePatternPerformance(patternId1, {
        patternType: 'double_top',
        symbol: 'AAPL',
        timeframe: '5min',
        totalTrades: 10,
        winningTrades: 6,
        losingTrades: 4,
        winRate: 0.6,
        avgReturnPct: 0.5,
        totalReturnPct: 5.0,
        profitFactor: 1.2,
        firstSeenDate: new Date().toISOString()
      });

      await evaluationDb.updatePatternPerformance(patternId2, {
        patternType: 'opening_gap',
        symbol: 'TSLA',
        timeframe: '5min',
        totalTrades: 15,
        winningTrades: 9,
        losingTrades: 6,
        winRate: 0.6,
        avgReturnPct: 0.4,
        totalReturnPct: 6.0,
        profitFactor: 1.5,
        firstSeenDate: new Date().toISOString()
      });

      const perfMap = await evaluationDb.getPatternPerformance([patternId1, patternId2]);

      assert.strictEqual(perfMap.size, 2, 'Should return performance for both patterns');
      assert.strictEqual(perfMap.get(patternId1).winRate, 0.6, 'Should return correct win_rate');
      assert.strictEqual(perfMap.get(patternId2).profitFactor, 1.5, 'Should return correct profit_factor');
    });
  });
});

