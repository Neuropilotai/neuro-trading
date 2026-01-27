/**
 * Pattern Recognition Service
 * Detects and learns repeating patterns in price action
 * 
 * Feature Flag: ENABLE_PATTERN_RECOGNITION (default: true)
 */

const fs = require('fs').promises;
const path = require('path');
const evaluationDb = require('../db/evaluationDb');
const patternAttributionService = require('./patternAttributionService');

class PatternRecognitionService {
  constructor() {
    this.enabled = process.env.ENABLE_PATTERN_RECOGNITION !== 'false';
    
    // Pattern filtering config (from env vars with safe defaults)
    this.filteringEnabled = process.env.ENABLE_PATTERN_FILTERING !== 'false';
    this.filterConfig = {
      minWinRate: parseFloat(process.env.PATTERN_MIN_WIN_RATE) || 0.50,
      minProfitFactor: parseFloat(process.env.PATTERN_MIN_PROFIT_FACTOR) || 1.0,
      minSampleSize: parseInt(process.env.PATTERN_MIN_SAMPLE_SIZE) || 10
    };
    
    // Pattern storage
    this.patterns = new Map(); // patternId -> pattern
    this.patternIndex = new Map(); // patternType -> [patternIds]
    
    // Price history for pattern detection (rolling window)
    this.priceHistory = new Map(); // symbol -> [{timestamp, price, volume, indicators}]
    this.maxHistorySize = 1000; // Keep last 1000 candles
    
    // Pattern detection config
    this.config = {
      minConfidence: 0.6,
      minSampleSize: 5,
      patternTypes: [
        'opening_range_breakout',
        'opening_gap',
        'opening_reversal',
        'double_top',
        'double_bottom',
        'support_bounce',
        'resistance_rejection'
      ]
    };
    
    // Load patterns from storage
    this.loadPatterns();
  }

  /**
   * Analyze price action and detect patterns
   * @param {string} symbol - Trading symbol
   * @param {object} marketData - Current market data
   * @param {string} timeframe - Timeframe (5min, 15min, etc.)
   * @returns {Array} - Detected patterns
   */
  async detectPatterns(symbol, marketData, timeframe = '5min') {
    if (!this.enabled) {
      return [];
    }

    try {
      // Add to price history
      this.addToHistory(symbol, marketData);
      
      // Get recent price history
      const history = this.getHistory(symbol, 50); // Last 50 candles
      if (history.length < 10) {
        return []; // Need at least 10 candles
      }

      const detectedPatterns = [];

      // Detect opening patterns (first 5-15 minutes)
      if (timeframe === '5min' || timeframe === '15min') {
        const openingPatterns = this.detectOpeningPatterns(symbol, history, timeframe);
        detectedPatterns.push(...openingPatterns);
      }

      // Detect price action patterns
      const priceActionPatterns = this.detectPriceActionPatterns(symbol, history);
      detectedPatterns.push(...priceActionPatterns);

      // Match against known patterns
      const matchedPatterns = await this.matchKnownPatterns(symbol, history, detectedPatterns);
      
      // Filter patterns by performance if enabled
      const validatedPatterns = await this.filterByPerformance(matchedPatterns);
      
      return validatedPatterns;
    } catch (error) {
      console.error(`❌ Pattern detection error for ${symbol}:`, error.message);
      return [];
    }
  }

  /**
   * Detect opening patterns (5min/15min)
   */
  detectOpeningPatterns(symbol, history, timeframe) {
    const patterns = [];
    
    // Need at least 3 candles for opening patterns
    if (history.length < 3) return patterns;

    const firstCandle = history[0];
    const secondCandle = history[1];
    const thirdCandle = history[2];
    const currentCandle = history[history.length - 1];

    // 1. Opening Gap
    if (firstCandle.previousClose && firstCandle.price) {
      const gapPercent = ((firstCandle.price - firstCandle.previousClose) / firstCandle.previousClose) * 100;
      
      if (Math.abs(gapPercent) > 0.5) { // 0.5% gap threshold
        patterns.push({
          patternType: gapPercent > 0 ? 'opening_gap_up' : 'opening_gap_down',
          timeframe: timeframe,
          confidence: Math.min(0.9, 0.6 + Math.abs(gapPercent) / 10),
          patternData: {
            gapPercent: gapPercent,
            openPrice: firstCandle.price,
            previousClose: firstCandle.previousClose
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    // 2. Opening Range Breakout
    if (history.length >= 3) {
      const openingRange = {
        high: Math.max(firstCandle.high, secondCandle.high, thirdCandle.high),
        low: Math.min(firstCandle.low, secondCandle.low, thirdCandle.low)
      };

      const rangeSize = openingRange.high - openingRange.low;
      const currentPrice = currentCandle.price;

      // Breakout above range
      if (currentPrice > openingRange.high && rangeSize > 0) {
        const breakoutStrength = (currentPrice - openingRange.high) / rangeSize;
        patterns.push({
          patternType: 'opening_range_breakout_up',
          timeframe: timeframe,
          confidence: Math.min(0.95, 0.7 + breakoutStrength),
          patternData: {
            openingRange: openingRange,
            breakoutPrice: currentPrice,
            breakoutStrength: breakoutStrength
          },
          detectedAt: new Date().toISOString()
        });
      }

      // Breakout below range
      if (currentPrice < openingRange.low && rangeSize > 0) {
        const breakoutStrength = (openingRange.low - currentPrice) / rangeSize;
        patterns.push({
          patternType: 'opening_range_breakout_down',
          timeframe: timeframe,
          confidence: Math.min(0.95, 0.7 + breakoutStrength),
          patternData: {
            openingRange: openingRange,
            breakoutPrice: currentPrice,
            breakoutStrength: breakoutStrength
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    // 3. Opening Reversal
    if (history.length >= 4) {
      const initialDirection = secondCandle.price > firstCandle.price ? 'up' : 'down';
      const currentDirection = currentCandle.price > history[history.length - 2].price ? 'up' : 'down';

      if (initialDirection !== currentDirection) {
        const reversalStrength = Math.abs(currentCandle.price - firstCandle.price) / firstCandle.price;
        patterns.push({
          patternType: `opening_reversal_${initialDirection}_to_${currentDirection}`,
          timeframe: timeframe,
          confidence: Math.min(0.85, 0.65 + reversalStrength * 10),
          patternData: {
            initialDirection: initialDirection,
            currentDirection: currentDirection,
            reversalStrength: reversalStrength
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    return patterns;
  }

  /**
   * Detect price action patterns
   */
  detectPriceActionPatterns(symbol, history) {
    const patterns = [];
    
    if (history.length < 10) return patterns;

    // Double Top/Bottom detection
    const doublePattern = this.detectDoubleTopBottom(history);
    if (doublePattern) {
      patterns.push(doublePattern);
    }

    // Support/Resistance bounce
    const srPattern = this.detectSupportResistanceBounce(history);
    if (srPattern) {
      patterns.push(srPattern);
    }

    return patterns;
  }

  /**
   * Detect double top or double bottom
   */
  detectDoubleTopBottom(history) {
    if (history.length < 20) return null;

    // Find local highs and lows
    const highs = [];
    const lows = [];

    for (let i = 1; i < history.length - 1; i++) {
      if (history[i].high > history[i - 1].high && history[i].high > history[i + 1].high) {
        highs.push({ index: i, price: history[i].high });
      }
      if (history[i].low < history[i - 1].low && history[i].low < history[i + 1].low) {
        lows.push({ index: i, price: history[i].low });
      }
    }

    // Check for double top (two similar highs)
    if (highs.length >= 2) {
      const lastTwoHighs = highs.slice(-2);
      const priceDiff = Math.abs(lastTwoHighs[0].price - lastTwoHighs[1].price) / lastTwoHighs[0].price;
      
      if (priceDiff < 0.02) { // Within 2%
        return {
          patternType: 'double_top',
          confidence: 0.75,
          patternData: {
            firstTop: lastTwoHighs[0],
            secondTop: lastTwoHighs[1],
            priceDiff: priceDiff
          },
          detectedAt: new Date().toISOString()
        };
      }
    }

    // Check for double bottom (two similar lows)
    if (lows.length >= 2) {
      const lastTwoLows = lows.slice(-2);
      const priceDiff = Math.abs(lastTwoLows[0].price - lastTwoLows[1].price) / lastTwoLows[0].price;
      
      if (priceDiff < 0.02) { // Within 2%
        return {
          patternType: 'double_bottom',
          confidence: 0.75,
          patternData: {
            firstBottom: lastTwoLows[0],
            secondBottom: lastTwoLows[1],
            priceDiff: priceDiff
          },
          detectedAt: new Date().toISOString()
        };
      }
    }

    return null;
  }

  /**
   * Detect support/resistance bounce
   */
  detectSupportResistanceBounce(history) {
    if (history.length < 10) return null;

    const currentPrice = history[history.length - 1].price;
    
    // Find recent support/resistance levels
    const recentHighs = history.slice(-20).map(h => h.high).sort((a, b) => b - a);
    const recentLows = history.slice(-20).map(h => h.low).sort((a, b) => a - b);
    
    const resistance = recentHighs[0];
    const support = recentLows[0];

    // Check if price is bouncing off support
    if (currentPrice <= support * 1.01 && currentPrice >= support * 0.99) {
      return {
        patternType: 'support_bounce',
        confidence: 0.7,
        patternData: {
          supportLevel: support,
          currentPrice: currentPrice,
          bounceStrength: (currentPrice - support) / support
        },
        detectedAt: new Date().toISOString()
      };
    }

    // Check if price is rejecting resistance
    if (currentPrice >= resistance * 0.99 && currentPrice <= resistance * 1.01) {
      return {
        patternType: 'resistance_rejection',
        confidence: 0.7,
        patternData: {
          resistanceLevel: resistance,
          currentPrice: currentPrice,
          rejectionStrength: (resistance - currentPrice) / resistance
        },
        detectedAt: new Date().toISOString()
      };
    }

    return null;
  }

  /**
   * Match detected patterns against known patterns
   */
  async matchKnownPatterns(symbol, history, detectedPatterns) {
    const matchedPatterns = [];

    for (const detected of detectedPatterns) {
      // Find similar patterns in our pattern bank
      const similarPatterns = this.findSimilarPatterns(detected, symbol);
      
      if (similarPatterns.length > 0) {
        // Use historical performance to boost confidence
        const bestMatch = similarPatterns[0];
        const boostedConfidence = Math.min(0.95, 
          detected.confidence * 0.6 + bestMatch.winRate * 0.4
        );

        matchedPatterns.push({
          ...detected,
          confidence: boostedConfidence,
          matchedPattern: bestMatch.patternId,
          patternId: bestMatch.patternId, // Add patternId for filtering
          historicalWinRate: bestMatch.winRate,
          historicalAvgPnL: bestMatch.avgPnL
        });
      } else {
        // New pattern - add with base confidence (no patternId yet)
        matchedPatterns.push(detected);
      }
    }

    return matchedPatterns;
  }

  /**
   * Filter patterns by performance metrics
   * Only returns patterns that meet minimum thresholds
   */
  async filterByPerformance(patterns) {
    // If filtering is disabled, return all patterns (backward compatible)
    if (!this.filteringEnabled) {
      return patterns;
    }

    // Collect pattern IDs from matched patterns
    const patternIds = patterns
      .map(p => p.patternId || p.matchedPattern)
      .filter(id => id !== undefined && id !== null);

    if (patternIds.length === 0) {
      // No pattern IDs means new patterns - return all (they'll be validated after first trade)
      return patterns;
    }

    try {
      // Get validated pattern IDs from database
      const validatedIds = await evaluationDb.getValidatedPatterns(this.filterConfig);
      const validatedSet = new Set(validatedIds);

      // Filter patterns - keep only validated ones
      const filtered = [];
      const filteredOut = [];

      for (const pattern of patterns) {
        const patternId = pattern.patternId || pattern.matchedPattern;
        
        // If pattern has no ID yet (new pattern), include it
        // It will be validated after first trade
        if (!patternId) {
          filtered.push(pattern);
          continue;
        }

        // Check if pattern is validated
        if (validatedSet.has(patternId)) {
          filtered.push(pattern);
        } else {
          filteredOut.push(patternId);
        }
      }

      // Log filtered patterns at debug level only
      if (filteredOut.length > 0) {
        console.debug(`🔍 Pattern filtering: ${filteredOut.length} pattern(s) filtered out (insufficient performance)`);
      }

      return filtered;
    } catch (error) {
      console.error('❌ Error filtering patterns by performance:', error.message);
      // On error, return all patterns (fail-safe)
      return patterns;
    }
  }

  /**
   * Find similar patterns in pattern bank
   */
  findSimilarPatterns(detectedPattern, symbol) {
    const similar = [];
    const patternType = detectedPattern.patternType;

    // Get patterns of same type
    const typePatterns = this.patternIndex.get(patternType) || [];
    
    for (const patternId of typePatterns) {
      const pattern = this.patterns.get(patternId);
      if (!pattern || pattern.symbol !== symbol) continue;

      // Calculate similarity
      const similarity = this.calculateSimilarity(detectedPattern, pattern);
      
      if (similarity > 0.7) { // 70% similarity threshold
        similar.push({
          patternId: pattern.patternId,
          similarity: similarity,
          winRate: pattern.outcome?.success ? pattern.winRate : 0,
          avgPnL: pattern.avgPnL || 0
        });
      }
    }

    // Sort by similarity
    return similar.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Calculate similarity between two patterns
   */
  calculateSimilarity(pattern1, pattern2) {
    let similarity = 0;
    let factors = 0;

    // Pattern type match
    if (pattern1.patternType === pattern2.patternType) {
      similarity += 0.3;
    }
    factors += 0.3;

    // Timeframe match
    if (pattern1.timeframe === pattern2.timeframe) {
      similarity += 0.2;
    }
    factors += 0.2;

    // Price action similarity (if available)
    if (pattern1.patternData && pattern2.patternData) {
      const priceSim = this.comparePriceSequences(
        pattern1.patternData.priceSequence,
        pattern2.patternData.priceSequence
      );
      similarity += priceSim * 0.5;
      factors += 0.5;
    }

    return factors > 0 ? similarity / factors : 0;
  }

  /**
   * Compare price sequences
   */
  comparePriceSequences(seq1, seq2) {
    if (!seq1 || !seq2 || seq1.length !== seq2.length) return 0;

    let diff = 0;
    for (let i = 0; i < seq1.length; i++) {
      diff += Math.abs(seq1[i] - seq2[i]) / Math.max(seq1[i], seq2[i]);
    }

    return Math.max(0, 1 - diff / seq1.length);
  }

  /**
   * Learn from a completed trade (store pattern)
   */
  async learnFromTrade(trade, marketData, detectedPatterns) {
    if (!this.enabled) return;

    try {
      // Store successful patterns
      for (const pattern of detectedPatterns) {
        if (trade.pnl > 0 && pattern.confidence > this.config.minConfidence) {
          await this.storePattern(trade.symbol, pattern, trade);
        }
      }
    } catch (error) {
      console.error('❌ Error learning from trade:', error.message);
    }
  }

  /**
   * Store a pattern
   */
  async storePattern(symbol, pattern, trade) {
    const patternId = `PATTERN_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    const storedPattern = {
      patternId: patternId,
      patternType: pattern.patternType,
      timeframe: pattern.timeframe || '5min',
      symbol: symbol,
      confidence: pattern.confidence,
      winRate: trade.pnl > 0 ? 1.0 : 0.0,
      avgPnL: trade.pnl,
      sampleSize: 1,
      patternData: pattern.patternData || {},
      outcome: {
        direction: trade.action,
        pnl: trade.pnl,
        duration: 0,
        success: trade.pnl > 0
      },
      metadata: {
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        occurrences: 1,
        tags: [pattern.patternType, pattern.timeframe]
      }
    };

    // Store in memory
    this.patterns.set(patternId, storedPattern);
    
    // Add to index
    if (!this.patternIndex.has(pattern.patternType)) {
      this.patternIndex.set(pattern.patternType, []);
    }
    this.patternIndex.get(pattern.patternType).push(patternId);

    // Save to storage
    await this.savePatterns();

    console.log(`📊 Pattern stored: ${pattern.patternType} (${symbol}) - Confidence: ${pattern.confidence.toFixed(2)}`);
    
    return patternId;
  }

  /**
   * Add market data to history
   */
  addToHistory(symbol, marketData) {
    if (!this.priceHistory.has(symbol)) {
      this.priceHistory.set(symbol, []);
    }

    const history = this.priceHistory.get(symbol);
    history.push({
      timestamp: marketData.timestamp || new Date().toISOString(),
      price: marketData.price || marketData.close,
      high: marketData.high,
      low: marketData.low,
      volume: marketData.volume,
      previousClose: marketData.previousClose,
      indicators: marketData.indicators || {}
    });

    // Keep only last N candles
    if (history.length > this.maxHistorySize) {
      history.shift();
    }
  }

  /**
   * Get price history
   */
  getHistory(symbol, limit = 50) {
    const history = this.priceHistory.get(symbol) || [];
    return history.slice(-limit);
  }

  /**
   * Load patterns from storage (Google Drive primary, local cache backup)
   */
  async loadPatterns() {
    try {
      const googleDriveStorage = require('./googleDrivePatternStorage');
      let patternsData = null;
      let loadedFrom = null;

      // Try Google Drive first (primary storage)
      if (googleDriveStorage.enabled) {
        try {
          const driveResult = await googleDriveStorage.syncFromDrive();
          if (driveResult.success && driveResult.patterns && driveResult.patterns.length > 0) {
            patternsData = { patterns: driveResult.patterns };
            loadedFrom = 'Google Drive';
            console.log(`📥 Loaded ${driveResult.count} patterns from Google Drive`);
          }
        } catch (error) {
          console.warn('⚠️  Google Drive load failed, trying local cache:', error.message);
        }
      }

      // Fallback to local cache if Google Drive unavailable or empty
      if (!patternsData || !patternsData.patterns || patternsData.patterns.length === 0) {
        try {
          const localPatternsPath = path.join(__dirname, '../../data/patterns.json');
          const data = await fs.readFile(localPatternsPath, 'utf8');
          patternsData = JSON.parse(data);
          loadedFrom = 'local cache';
          console.log(`📂 Loaded ${patternsData.patterns?.length || 0} patterns from local cache`);
        } catch (error) {
          // Try legacy TradingDrive location as last resort
          try {
            const tradingDrivePath = path.join(__dirname, '../../TradingDrive');
            const tradingDrivePatternsPath = path.join(tradingDrivePath, 'patterns', 'pattern_bank.json');
            const data = await fs.readFile(tradingDrivePatternsPath, 'utf8');
            patternsData = JSON.parse(data);
            loadedFrom = 'TradingDrive (legacy)';
            console.log(`📂 Loaded ${patternsData.patterns?.length || 0} patterns from legacy TradingDrive`);
          } catch (error2) {
            console.log('📊 Starting with empty pattern bank (will sync to Google Drive when patterns are created)');
            return;
          }
        }
      }

      if (patternsData && patternsData.patterns) {
        for (const pattern of patternsData.patterns) {
          this.patterns.set(pattern.patternId, pattern);
          
          if (!this.patternIndex.has(pattern.patternType)) {
            this.patternIndex.set(pattern.patternType, []);
          }
          this.patternIndex.get(pattern.patternType).push(pattern.patternId);
        }

        console.log(`✅ Loaded ${this.patterns.size} patterns from ${loadedFrom}`);
      }
    } catch (error) {
      console.log('📊 Starting with empty pattern bank');
    }
  }

  /**
   * Save patterns to storage (Google Drive primary, local cache backup)
   */
  async savePatterns() {
    try {
      const googleDriveStorage = require('./googleDrivePatternStorage');
      const patterns = Array.from(this.patterns.values());
      
      const patternsData = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        totalPatterns: this.patterns.size,
        storage: 'Google Drive (primary) + local cache',
        patterns: patterns
      };

      // Save to Google Drive first (primary storage)
      if (googleDriveStorage.enabled) {
        try {
          const syncResult = await googleDriveStorage.syncToDrive(patterns);
          if (syncResult.success) {
            console.log(`☁️  Synced ${syncResult.uploaded} patterns to Google Drive`);
          } else {
            console.warn('⚠️  Google Drive sync failed, using local cache only');
          }
        } catch (error) {
          console.warn('⚠️  Google Drive sync error:', error.message);
        }
      } else {
        console.log('ℹ️  Google Drive sync disabled, saving to local cache only');
      }

      // Always save to local cache as backup (even if Google Drive succeeds)
      try {
        const localPatternsPath = path.join(__dirname, '../../data/patterns.json');
        const localPatternsDir = path.dirname(localPatternsPath);
        await fs.mkdir(localPatternsDir, { recursive: true });
        await fs.writeFile(localPatternsPath, JSON.stringify(patternsData, null, 2));
        console.log(`💾 Cached ${this.patterns.size} patterns locally`);
      } catch (error) {
        console.error('❌ Error saving local cache:', error.message);
      }
    } catch (error) {
      console.error('❌ Error saving patterns:', error.message);
    }
  }

  /**
   * Get pattern statistics
   */
  getStats() {
    const stats = {
      totalPatterns: this.patterns.size,
      patternsByType: {},
      avgConfidence: 0,
      avgWinRate: 0,
      topPatterns: []
    };

    let totalConfidence = 0;
    let totalWinRate = 0;
    let count = 0;

    for (const pattern of this.patterns.values()) {
      // Count by type
      if (!stats.patternsByType[pattern.patternType]) {
        stats.patternsByType[pattern.patternType] = 0;
      }
      stats.patternsByType[pattern.patternType]++;

      totalConfidence += pattern.confidence;
      totalWinRate += pattern.winRate;
      count++;
    }

    if (count > 0) {
      stats.avgConfidence = totalConfidence / count;
      stats.avgWinRate = totalWinRate / count;
    }

    // Top patterns by win rate
    stats.topPatterns = Array.from(this.patterns.values())
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 10)
      .map(p => ({
        patternId: p.patternId,
        patternType: p.patternType,
        winRate: p.winRate,
        avgPnL: p.avgPnL
      }));

    return stats;
  }
}

module.exports = new PatternRecognitionService();

