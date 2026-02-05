/**
 * Whale Detection Agent
 * 
 * Detects large institutional/whale buying patterns and guides the system
 * to prioritize opportunities with whale activity.
 * 
 * Features:
 * - Volume spike detection (unusual volume increases)
 * - Large order flow detection (whale activity)
 * - Institutional pattern recognition
 * - Portfolio movement tracking
 * - Opportunity ranking boost based on whale signals
 */

const EventEmitter = require('events');

class WhaleDetectionAgent extends EventEmitter {
  constructor() {
    super();
    this.enabled = process.env.ENABLE_WHALE_DETECTION !== 'false';
    this.isRunning = false;
    this.__initialized = false; // Idempotent initialization guard
    
    // Configuration
    this.config = {
      // Volume thresholds (multiples of average)
      volumeSpikeThreshold: parseFloat(process.env.WHALE_VOLUME_SPIKE_THRESHOLD || '3.0'), // 3x average = whale
      largeVolumeThreshold: parseFloat(process.env.WHALE_LARGE_VOLUME_THRESHOLD || '5.0'), // 5x = big whale
      
      // Price movement thresholds
      priceMoveThreshold: parseFloat(process.env.WHALE_PRICE_MOVE_THRESHOLD || '0.02'), // 2% move = significant
      largePriceMoveThreshold: parseFloat(process.env.WHALE_LARGE_PRICE_MOVE || '0.05'), // 5% = big move
      
      // Time windows for analysis
      shortWindow: parseInt(process.env.WHALE_SHORT_WINDOW || '5', 10), // 5 candles
      mediumWindow: parseInt(process.env.WHALE_MEDIUM_WINDOW || '20', 10), // 20 candles
      longWindow: parseInt(process.env.WHALE_LONG_WINDOW || '100', 10), // 100 candles
      
      // Whale signal strength
      minWhaleSignal: parseFloat(process.env.WHALE_MIN_SIGNAL || '0.6'), // Minimum signal to consider
      strongWhaleSignal: parseFloat(process.env.WHALE_STRONG_SIGNAL || '0.8'), // Strong whale signal
    };
    
    // Tracking data
    this.whaleSignals = new Map(); // symbol -> { signal, timestamp, details }
    this.volumeHistory = new Map(); // symbol -> volume history
    this.priceHistory = new Map(); // symbol -> price history
    
    // Statistics
    this.stats = {
      whalesDetected: 0,
      signalsGenerated: 0,
      opportunitiesBoosted: 0,
      lastScan: null
    };
  }

  /**
   * Initialize the whale detection agent
   */
  async initialize() {
    if (!this.enabled) {
      console.log('⚠️  Whale detection agent is DISABLED');
      return;
    }

    // Idempotent guard: prevent double initialization
    if (this.__initialized) {
      console.log('⚠️  Whale detection agent already initialized (idempotent guard)');
      return;
    }

    this.__initialized = true;
    this.isRunning = true;
    console.log('🐋 Whale detection agent initialized');
    console.log(`   Volume spike threshold: ${this.config.volumeSpikeThreshold}x`);
    console.log(`   Large volume threshold: ${this.config.largeVolumeThreshold}x`);
  }

  /**
   * Analyze market data for whale activity
   * @param {string} symbol - Trading symbol
   * @param {object} marketData - Market data with candles, volume, price
   * @param {string} timeframe - Timeframe (1, 5, etc.)
   * @returns {object} - Whale signal with strength and details
   */
  analyzeWhaleActivity(symbol, marketData, timeframe = '1') {
    if (!this.enabled || !this.isRunning) {
      return { signal: 0, details: {} };
    }

    try {
      const candles = marketData.candles || [];
      if (candles.length < this.config.mediumWindow) {
        return { signal: 0, details: { reason: 'insufficient_data' } };
      }

      // Extract volume and price data
      const volumes = candles.map(c => c.volume || 0);
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      
      const latestCandle = candles[candles.length - 1];
      const latestVolume = latestCandle.volume || 0;
      const latestPrice = latestCandle.close;
      
      // Calculate volume metrics
      const avgVolume = this.calculateAverageVolume(volumes, this.config.mediumWindow);
      const recentAvgVolume = this.calculateAverageVolume(volumes.slice(-this.config.shortWindow), this.config.shortWindow);
      const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1.0;
      const recentVolumeRatio = recentAvgVolume > 0 ? latestVolume / recentAvgVolume : 1.0;
      
      // Calculate price movement
      const priceChange = closes.length > 1 ? (latestPrice - closes[closes.length - 2]) / closes[closes.length - 2] : 0;
      const priceChangePercent = Math.abs(priceChange);
      
      // Detect whale patterns
      const patterns = this.detectWhalePatterns({
        symbol,
        timeframe,
        volumes,
        closes,
        highs,
        lows,
        latestVolume,
        latestPrice,
        volumeRatio,
        recentVolumeRatio,
        priceChange,
        priceChangePercent,
        avgVolume,
        recentAvgVolume
      });
      
      // Calculate composite whale signal (0-1)
      const whaleSignal = this.calculateWhaleSignal(patterns);
      
      // Store signal
      if (whaleSignal >= this.config.minWhaleSignal) {
        this.whaleSignals.set(symbol, {
          signal: whaleSignal,
          timestamp: Date.now(),
          timeframe,
          patterns,
          volumeRatio,
          priceChangePercent,
          details: {
            latestVolume,
            avgVolume,
            priceChange
          }
        });
        
        this.stats.signalsGenerated++;
        this.stats.whalesDetected++;
        
        // Emit event for strong signals
        if (whaleSignal >= this.config.strongWhaleSignal) {
          this.emit('strongWhaleDetected', {
            symbol,
            signal: whaleSignal,
            patterns,
            volumeRatio,
            priceChangePercent
          });
        }
      }
      
      return {
        signal: whaleSignal,
        patterns,
        volumeRatio,
        priceChangePercent,
        details: {
          latestVolume,
          avgVolume,
          recentAvgVolume,
          priceChange
        }
      };
    } catch (error) {
      console.error(`❌ Error analyzing whale activity for ${symbol}:`, error.message);
      return { signal: 0, details: { error: error.message } };
    }
  }

  /**
   * Detect specific whale patterns
   */
  detectWhalePatterns(data) {
    const patterns = {
      volumeSpike: false,
      largeVolumeSpike: false,
      priceMomentum: false,
      largePriceMove: false,
      volumeAccumulation: false,
      whaleBuying: false,
      whaleSelling: false
    };
    
    // Volume spike detection
    if (data.volumeRatio >= this.config.volumeSpikeThreshold) {
      patterns.volumeSpike = true;
    }
    
    if (data.volumeRatio >= this.config.largeVolumeThreshold) {
      patterns.largeVolumeSpike = true;
    }
    
    // Price movement detection
    if (data.priceChangePercent >= this.config.priceMoveThreshold) {
      patterns.priceMomentum = true;
    }
    
    if (data.priceChangePercent >= this.config.largePriceMoveThreshold) {
      patterns.largePriceMove = true;
    }
    
    // Volume accumulation (sustained high volume)
    const recentVolumes = data.volumes.slice(-this.config.shortWindow);
    const avgRecentVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    if (avgRecentVolume > data.avgVolume * 2.0) {
      patterns.volumeAccumulation = true;
    }
    
    // Whale buying pattern: High volume + price increase
    if (data.volumeRatio >= this.config.volumeSpikeThreshold && data.priceChange > 0) {
      patterns.whaleBuying = true;
    }
    
    // Whale selling pattern: High volume + price decrease
    if (data.volumeRatio >= this.config.volumeSpikeThreshold && data.priceChange < 0) {
      patterns.whaleSelling = true;
    }
    
    return patterns;
  }

  /**
   * Calculate composite whale signal strength (0-1)
   */
  calculateWhaleSignal(patterns) {
    let signal = 0;
    
    // Volume spike contributes 30%
    if (patterns.largeVolumeSpike) {
      signal += 0.30;
    } else if (patterns.volumeSpike) {
      signal += 0.15;
    }
    
    // Price movement contributes 25%
    if (patterns.largePriceMove) {
      signal += 0.25;
    } else if (patterns.priceMomentum) {
      signal += 0.12;
    }
    
    // Volume accumulation contributes 20%
    if (patterns.volumeAccumulation) {
      signal += 0.20;
    }
    
    // Whale buying/selling pattern contributes 25%
    if (patterns.whaleBuying) {
      signal += 0.25; // Strong buy signal
    } else if (patterns.whaleSelling) {
      signal += 0.10; // Sell signal (less attractive for long trades)
    }
    
    // Cap at 1.0
    return Math.min(signal, 1.0);
  }

  /**
   * Calculate average volume over a window
   */
  calculateAverageVolume(volumes, window) {
    if (volumes.length === 0) return 0;
    const relevantVolumes = volumes.slice(-window);
    return relevantVolumes.reduce((a, b) => a + b, 0) / relevantVolumes.length;
  }

  /**
   * Boost opportunity score based on whale signal
   * @param {object} opportunity - Trading opportunity
   * @param {object} whaleSignal - Whale signal data
   * @returns {number} - Boost multiplier (1.0 = no boost, 1.5 = 50% boost)
   */
  boostOpportunityScore(opportunity, whaleSignal) {
    if (!whaleSignal || whaleSignal.signal < this.config.minWhaleSignal) {
      return 1.0; // No boost
    }
    
    // Strong whale signal = significant boost
    if (whaleSignal.signal >= this.config.strongWhaleSignal) {
      // 50% boost for strong whale signals
      this.stats.opportunitiesBoosted++;
      return 1.5;
    }
    
    // Moderate whale signal = moderate boost
    if (whaleSignal.signal >= this.config.minWhaleSignal) {
      // Linear boost from 1.0 to 1.3 based on signal strength
      const boost = 1.0 + (whaleSignal.signal * 0.3);
      this.stats.opportunitiesBoosted++;
      return boost;
    }
    
    return 1.0;
  }

  /**
   * Get whale signal for a symbol
   */
  getWhaleSignal(symbol) {
    return this.whaleSignals.get(symbol) || { signal: 0, details: {} };
  }

  /**
   * Get all active whale signals
   */
  getAllWhaleSignals() {
    const signals = [];
    for (const [symbol, data] of this.whaleSignals.entries()) {
      // Only return recent signals (within last 5 minutes)
      const age = Date.now() - data.timestamp;
      if (age < 5 * 60 * 1000) {
        signals.push({
          symbol,
          ...data
        });
      }
    }
    return signals.sort((a, b) => b.signal - a.signal); // Sort by signal strength
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      isRunning: this.isRunning,
      activeSignals: this.whaleSignals.size,
      config: this.config
    };
  }

  /**
   * Clear old signals (cleanup)
   */
  clearOldSignals(maxAge = 10 * 60 * 1000) { // 10 minutes
    const now = Date.now();
    for (const [symbol, data] of this.whaleSignals.entries()) {
      if (now - data.timestamp > maxAge) {
        this.whaleSignals.delete(symbol);
      }
    }
  }
}

module.exports = new WhaleDetectionAgent();

