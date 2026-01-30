/**
 * Pattern Learning Engine
 * Extracts patterns from OHLCV data and scores them
 */

const crypto = require('crypto');
const patternRecognitionService = require('./patternRecognitionService');
const googleDriveStorage = require('./googleDrivePatternStorage');
const checkpointManager = require('./checkpointManager');
const ohlcvCache = require('./ohlcvCache');

class PatternLearningEngine {
  constructor() {
    this.enabled = process.env.ENABLE_PATTERN_LEARNING !== 'false';
    this.patterns = new Map(); // pattern signature -> pattern object
    this.stats = {
      patternsExtracted: 0,
      patternsDeduped: 0,
      lastRun: null,
      symbolsProcessed: 0,
      errors: []
    };
  }

  /**
   * Initialize engine (load patterns from Google Drive)
   */
  async initialize() {
    if (!this.enabled) {
      console.log('⚠️  Pattern learning engine is DISABLED');
      return;
    }

    try {
      // Load existing patterns
      await patternRecognitionService.loadPatterns();
      this.patterns = patternRecognitionService.patterns;
      console.log(`✅ Pattern learning engine initialized with ${this.patterns.size} existing patterns`);
    } catch (error) {
      console.error('❌ Error initializing pattern learning engine:', error.message);
      this.stats.errors.push({ timestamp: new Date().toISOString(), error: error.message });
    }
  }

  /**
   * Process symbol/timeframe incrementally
   */
  async processSymbolTimeframe(symbol, timeframe, provider, maxBars = null) {
    if (!this.enabled) return { processed: 0, patterns: 0 };

    try {
      // Skip TradingView-only symbols early (provider returns empty array anyway, but skip processing)
      const symbolRouter = require('./symbolRouter');
      if (!symbolRouter.shouldFetchFromBinance(symbol)) {
        return { processed: 0, patterns: 0, reason: 'tradingview_only' };
      }
      
      // Get last processed timestamp
      const lastProcessed = await checkpointManager.getLastProcessed(symbol, timeframe);
      
      // Load cached candles
      let candles = await ohlcvCache.readCandles(symbol, timeframe);
      
      // Fetch new candles if needed
      let newCandles = [];
      if (lastProcessed) {
        // Incremental: fetch since last processed
        newCandles = await provider.fetchCandlesSince(symbol, timeframe, lastProcessed);
      } else {
        // Backfill: fetch max history
        const limit = maxBars || 1000;
        newCandles = await provider.fetchCandles(symbol, timeframe, limit);
      }

      // Merge and cache
      if (newCandles.length > 0) {
        candles = ohlcvCache.mergeCandles(candles, newCandles);
        await ohlcvCache.replaceCache(symbol, timeframe, candles);
      }

      if (candles.length < 20) {
        if (candles.length === 0) {
          return { processed: 0, patterns: 0, reason: 'no_data_available' };
        }
        return { processed: 0, patterns: 0, reason: 'insufficient_data' };
      }

      // Extract patterns from candles
      const patterns = await this.extractPatterns(symbol, timeframe, candles, lastProcessed);
      
      // Update checkpoint
      if (candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        await checkpointManager.updateCheckpoint(symbol, timeframe, lastCandle.ts, {
          candlesProcessed: candles.length,
          patternsFound: patterns.length
        });
      }

      return {
        processed: candles.length,
        patterns: patterns.length,
        newCandles: newCandles.length
      };
    } catch (error) {
      console.error(`❌ Error processing ${symbol}/${timeframe}:`, error.message);
      this.stats.errors.push({
        timestamp: new Date().toISOString(),
        symbol,
        timeframe,
        error: error.message
      });
      return { processed: 0, patterns: 0, error: error.message };
    }
  }

  /**
   * Extract patterns from candles (scalping-optimized)
   */
  async extractPatterns(symbol, timeframe, candles, sinceTimestamp = null) {
    const patterns = [];
    
    // Scalping: Use smaller windows for faster pattern detection
    // 1min: 5-10 candles, 5min: 10-20 candles
    const isScalping = timeframe === '1' || timeframe === '5';
    const minWindow = isScalping ? 5 : 10;
    const maxWindow = isScalping ? 20 : 30;
    const windowStep = isScalping ? 2 : 5; // Check every 2 candles for scalping

    // Only process new candles if sinceTimestamp is provided
    const startIdx = sinceTimestamp 
      ? candles.findIndex(c => c.ts > sinceTimestamp)
      : 0;

    if (startIdx === -1) return patterns;

    // Slide window through candles (smaller steps for scalping)
    for (let i = Math.max(startIdx, minWindow - 1); i < candles.length; i += windowStep) {
      // Try multiple window sizes for scalping
      const windowSizes = isScalping ? [5, 10, 15, 20] : [minWindow, maxWindow];
      
      for (const windowSize of windowSizes) {
        if (i - windowSize + 1 < 0) continue;
        
        const window = candles.slice(i - windowSize + 1, i + 1);
        if (window.length < minWindow) continue;
        
        // Compute features
        const features = this.computeFeatures(window);
        
        // Detect scalping patterns (prioritize fast patterns)
        const detectedPatterns = this.detectScalpingPatterns(window, features, symbol, timeframe, isScalping);
        
        for (const pattern of detectedPatterns) {
          // Generate pattern signature for deduplication
          const signature = this.generatePatternSignature(pattern);
          
          // Check if pattern exists
          if (this.patterns.has(signature)) {
            // Update existing pattern
            const existing = this.patterns.get(signature);
            existing.occurrences++;
            existing.lastSeen = new Date().toISOString();
            this.stats.patternsDeduped++;
          } else {
            // New pattern
            pattern.patternId = `PATTERN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            pattern.signature = signature;
            pattern.occurrences = 1;
            pattern.createdAt = new Date().toISOString();
            pattern.lastSeen = new Date().toISOString();
            pattern.scalping = isScalping; // Mark as scalping pattern
            
            this.patterns.set(signature, pattern);
            patterns.push(pattern);
            this.stats.patternsExtracted++;
          }
        }
      }
    }

    return patterns;
  }

  /**
   * Compute features from candle window
   */
  computeFeatures(candles) {
    if (candles.length < 2) return {};

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    // Returns
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i-1]) / closes[i-1]);
    }

    // Volatility (std of returns)
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);

    // ATR (simplified)
    const atrValues = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i-1]),
        Math.abs(lows[i] - closes[i-1])
      );
      atrValues.push(tr);
    }
    const atr = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;

    // Trend slope (linear regression on closes)
    const n = closes.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = closes.reduce((a, b) => a + b, 0);
    const sumXY = closes.reduce((sum, y, i) => sum + i * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Volume trend
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const volumeRatio = recentVolume / avgVolume;

    // Regime classification
    let regime = 'NEUTRAL';
    if (volatility > 0.02 && Math.abs(slope) > 0.001) {
      regime = 'TRENDING';
    } else if (volatility < 0.01) {
      regime = 'SIDEWAYS';
    } else if (volatility > 0.03) {
      regime = 'VOLATILE';
    }

    return {
      returns: returns.slice(-5), // Last 5 returns
      volatility,
      atr,
      atrPercent: atr / closes[closes.length - 1],
      trendSlope: slope,
      volumeRatio,
      regime,
      priceChange: (closes[closes.length - 1] - closes[0]) / closes[0],
      highLowRange: (Math.max(...highs) - Math.min(...lows)) / closes[0]
    };
  }

  /**
   * Detect scalping-optimized patterns in candle window
   * Uses tighter thresholds for 1min/5min timeframes
   */
  detectScalpingPatterns(candles, features, symbol, timeframe, isScalping = false) {
    const patterns = [];
    const lastCandle = candles[candles.length - 1];
    const firstCandle = candles[0];

    // Scalping thresholds (tighter for fast patterns)
    const volatilityThreshold = isScalping ? 0.003 : 0.015;
    const priceChangeThreshold = isScalping ? 0.002 : 0.02;
    const volumeRatioThreshold = isScalping ? 1.2 : 1.5;

    // Breakout pattern (up or down)
    if (features.volatility > volatilityThreshold && Math.abs(features.priceChange) > priceChangeThreshold) {
      const direction = features.priceChange > 0 ? 'up' : 'down';
      patterns.push({
        patternType: `breakout_${direction}`,
        symbol,
        timeframe,
        confidence: Math.min(0.9, 0.6 + Math.abs(features.priceChange) * (isScalping ? 50 : 10)),
        window: candles.length,
        features: {
          volatility: features.volatility,
          priceChange: features.priceChange,
          volumeRatio: features.volumeRatio
        },
        patternData: {
          direction,
          startPrice: firstCandle.close,
          endPrice: lastCandle.close,
          high: Math.max(...candles.map(c => c.high)),
          low: Math.min(...candles.map(c => c.low))
        },
        scalping: isScalping
      });
    }

    // Mean reversion pattern (tighter for scalping)
    const meanReversionVolatility = isScalping ? 0.002 : 0.01;
    const meanReversionPriceChange = isScalping ? 0.001 : 0.005;
    if (features.volatility < meanReversionVolatility && Math.abs(features.priceChange) < meanReversionPriceChange) {
      patterns.push({
        patternType: 'mean_reversion',
        symbol,
        timeframe,
        confidence: isScalping ? 0.75 : 0.7,
        window: candles.length,
        features: {
          volatility: features.volatility,
          priceChange: features.priceChange
        },
        patternData: {
          range: features.highLowRange,
          avgPrice: candles.reduce((sum, c) => sum + c.close, 0) / candles.length
        },
        scalping: isScalping
      });
    }

    // Momentum burst (scalping: lower volume threshold)
    const momentumPriceChange = isScalping ? 0.005 : 0.01;
    if (features.volumeRatio > volumeRatioThreshold && Math.abs(features.priceChange) > momentumPriceChange) {
      patterns.push({
        patternType: 'momentum_burst',
        symbol,
        timeframe,
        confidence: Math.min(0.85, 0.65 + features.volumeRatio * (isScalping ? 0.15 : 0.1)),
        window: candles.length,
        features: {
          volumeRatio: features.volumeRatio,
          priceChange: features.priceChange,
          trendSlope: features.trendSlope
        },
        patternData: {
          direction: features.priceChange > 0 ? 'up' : 'down',
          volumeSpike: features.volumeRatio
        },
        scalping: isScalping
      });
    }

    // Volatility expansion (scalping: tighter threshold)
    const volatilityExpansionThreshold = isScalping ? 0.01 : 0.02;
    if (features.volatility > volatilityExpansionThreshold && features.atrPercent > (isScalping ? 0.01 : 0.02)) {
      patterns.push({
        patternType: 'volatility_expansion',
        symbol,
        timeframe,
        confidence: isScalping ? 0.8 : 0.75,
        window: candles.length,
        features: {
          volatility: features.volatility,
          atrPercent: features.atrPercent
        },
        patternData: {
          expansionRatio: features.volatility / (isScalping ? 0.002 : 0.01)
        },
        scalping: isScalping
      });
    }

    // Support/resistance touch
    const support = Math.min(...candles.map(c => c.low));
    const resistance = Math.max(...candles.map(c => c.high));
    const currentPrice = lastCandle.close;
    const range = resistance - support;
    
    if (range > 0) {
      const supportDistance = (currentPrice - support) / range;
      const resistanceDistance = (resistance - currentPrice) / range;
      const touchThreshold = isScalping ? 0.05 : 0.1; // Tighter for scalping

      if (supportDistance < touchThreshold) {
        patterns.push({
          patternType: 'support_touch',
          symbol,
          timeframe,
          confidence: isScalping ? 0.75 : 0.7,
          window: candles.length,
          features: {
            supportDistance,
            volatility: features.volatility
          },
          patternData: {
            supportLevel: support,
            currentPrice
          },
          scalping: isScalping
        });
      }

      if (resistanceDistance < touchThreshold) {
        patterns.push({
          patternType: 'resistance_touch',
          symbol,
          timeframe,
          confidence: isScalping ? 0.75 : 0.7,
          window: candles.length,
          features: {
            resistanceDistance,
            volatility: features.volatility
          },
          patternData: {
            resistanceLevel: resistance,
            currentPrice
          },
          scalping: isScalping
        });
      }
    }

    return patterns;
  }

  /**
   * Detect patterns in candle window (legacy - use detectScalpingPatterns)
   * @deprecated Use detectScalpingPatterns instead
   */
  detectPatterns(candles, features, symbol, timeframe) {
    // Delegate to scalping-optimized detection
    const isScalping = timeframe === '1' || timeframe === '5';
    return this.detectScalpingPatterns(candles, features, symbol, timeframe, isScalping);
  }
  
  /**
   * Legacy detectPatterns implementation (kept for backward compatibility)
   */
  detectPatternsLegacy(candles, features, symbol, timeframe) {
    const patterns = [];
    const lastCandle = candles[candles.length - 1];
    const firstCandle = candles[0];

    // Breakout pattern
    if (features.volatility > 0.015 && features.priceChange > 0.02) {
      patterns.push({
        patternType: 'breakout_up',
        symbol,
        timeframe,
        confidence: Math.min(0.9, 0.6 + features.priceChange * 10),
        window: candles.length,
        features: {
          volatility: features.volatility,
          priceChange: features.priceChange,
          volumeRatio: features.volumeRatio
        },
        patternData: {
          startPrice: firstCandle.close,
          endPrice: lastCandle.close,
          high: Math.max(...candles.map(c => c.high)),
          low: Math.min(...candles.map(c => c.low))
        }
      });
    }

    // Mean reversion pattern
    if (features.volatility < 0.01 && Math.abs(features.priceChange) < 0.005) {
      patterns.push({
        patternType: 'mean_reversion',
        symbol,
        timeframe,
        confidence: 0.7,
        window: candles.length,
        features: {
          volatility: features.volatility,
          priceChange: features.priceChange
        },
        patternData: {
          range: features.highLowRange,
          avgPrice: candles.reduce((sum, c) => sum + c.close, 0) / candles.length
        }
      });
    }

    // Momentum burst
    if (features.volumeRatio > 1.5 && Math.abs(features.priceChange) > 0.01) {
      patterns.push({
        patternType: 'momentum_burst',
        symbol,
        timeframe,
        confidence: Math.min(0.85, 0.65 + features.volumeRatio * 0.1),
        window: candles.length,
        features: {
          volumeRatio: features.volumeRatio,
          priceChange: features.priceChange,
          trendSlope: features.trendSlope
        },
        patternData: {
          direction: features.priceChange > 0 ? 'up' : 'down',
          volumeSpike: features.volumeRatio
        }
      });
    }

    // Volatility expansion
    if (features.volatility > 0.02 && features.atrPercent > 0.02) {
      patterns.push({
        patternType: 'volatility_expansion',
        symbol,
        timeframe,
        confidence: 0.75,
        window: candles.length,
        features: {
          volatility: features.volatility,
          atrPercent: features.atrPercent
        },
        patternData: {
          expansionRatio: features.volatility / 0.01 // vs baseline
        }
      });
    }

    // Support/resistance touch
    const support = Math.min(...candles.map(c => c.low));
    const resistance = Math.max(...candles.map(c => c.high));
    const currentPrice = lastCandle.close;
    const range = resistance - support;
    
    if (range > 0) {
      const supportDistance = (currentPrice - support) / range;
      const resistanceDistance = (resistance - currentPrice) / range;

      if (supportDistance < 0.1) {
        patterns.push({
          patternType: 'support_touch',
          symbol,
          timeframe,
          confidence: 0.7,
          window: candles.length,
          features: {
            supportDistance,
            volatility: features.volatility
          },
          patternData: {
            supportLevel: support,
            currentPrice
          }
        });
      }

      if (resistanceDistance < 0.1) {
        patterns.push({
          patternType: 'resistance_touch',
          symbol,
          timeframe,
          confidence: 0.7,
          window: candles.length,
          features: {
            resistanceDistance,
            volatility: features.volatility
          },
          patternData: {
            resistanceLevel: resistance,
            currentPrice
          }
        });
      }
    }

    return patterns;
  }

  /**
   * Generate pattern signature for deduplication (scalping-optimized)
   */
  generatePatternSignature(pattern) {
    // For scalping, use tighter signature (more granular)
    const volatilityRounded = pattern.scalping 
      ? Math.round(pattern.features.volatility * 10000) // 4 decimal precision
      : Math.round(pattern.features.volatility * 1000);  // 3 decimal precision
    
    const priceChangeRounded = pattern.scalping
      ? Math.round(pattern.features.priceChange * 10000)
      : Math.round(pattern.features.priceChange * 1000);
    
    const key = `${pattern.patternType}_${pattern.symbol}_${pattern.timeframe}_${volatilityRounded}_${priceChangeRounded}_${pattern.window || 0}`;
    return crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
  }

  /**
   * Save patterns to Google Drive and local cache
   */
  async savePatterns() {
    if (!this.enabled) return;

    try {
      // Update pattern recognition service
      for (const [signature, pattern] of this.patterns.entries()) {
        patternRecognitionService.patterns.set(pattern.patternId || signature, pattern);
      }

      // Save via pattern recognition service (handles Google Drive + local)
      await patternRecognitionService.savePatterns();
      
      console.log(`💾 Saved ${this.patterns.size} patterns to Google Drive and local cache`);
      
      // Trigger indicator generation after saving patterns
      try {
        const indicatorGenerator = require('./indicatorGenerator');
        if (indicatorGenerator.enabled) {
          await indicatorGenerator.generateIndicatorsFromPatterns();
          await indicatorGenerator.saveIndicators();
        }
      } catch (indError) {
        console.warn('⚠️ Indicator generation skipped:', indError.message);
      }
    } catch (error) {
      console.error('❌ Error saving patterns:', error.message);
      this.stats.errors.push({
        timestamp: new Date().toISOString(),
        error: `save_failed: ${error.message}`
      });
    }
  }

  /**
   * Get engine statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalPatterns: this.patterns.size,
      enabled: this.enabled
    };
  }

  /**
   * Prune stale patterns (older than retention days)
   */
  async prunePatterns(retentionDays = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffTimestamp = cutoffDate.toISOString();

    let pruned = 0;
    for (const [signature, pattern] of this.patterns.entries()) {
      if (pattern.lastSeen && pattern.lastSeen < cutoffTimestamp) {
        if (pattern.occurrences < 3) { // Only prune low-occurrence patterns
          this.patterns.delete(signature);
          pruned++;
        }
      }
    }

    if (pruned > 0) {
      console.log(`🧹 Pruned ${pruned} stale patterns`);
      await this.savePatterns();
    }

    return pruned;
  }
}

module.exports = new PatternLearningEngine();

