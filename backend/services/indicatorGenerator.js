const crypto = require('crypto');
const patternRecognitionService = require('./patternRecognitionService');

/**
 * Indicator Generator Service
 * 
 * Builds custom indicators from learned patterns for specific trading styles.
 * - Scalping: Fast, short-term indicators
 * - Swing: Medium-term indicators
 * - Position: Long-term indicators
 */
class IndicatorGenerator {
  constructor() {
    this.indicators = new Map(); // indicatorId -> indicator
    this.patternToIndicatorMap = new Map(); // patternSignature -> [indicatorIds]
    this.tradingStyle = process.env.TRADING_STYLE || 'scalping'; // scalping, swing, position
    this.enabled = process.env.ENABLE_INDICATOR_GENERATION !== 'false';
    
    this.stats = {
      indicatorsGenerated: 0,
      indicatorsUpdated: 0,
      patternsAnalyzed: 0,
      lastGenerated: null
    };
  }

  /**
   * Initialize from saved indicators
   */
  async initialize() {
    if (!this.enabled) return;
    
    try {
      // Load patterns to analyze
      await patternRecognitionService.loadPatterns();
      
      // Generate indicators from current patterns
      await this.generateIndicatorsFromPatterns();
      
      console.log(`✅ Indicator generator initialized (${this.tradingStyle} mode)`);
      console.log(`📊 Active indicators: ${this.indicators.size}`);
    } catch (error) {
      console.error('❌ Error initializing indicator generator:', error.message);
    }
  }

  /**
   * Generate indicators from learned patterns
   */
  async generateIndicatorsFromPatterns() {
    if (!this.enabled) return;

    const patterns = Array.from(patternRecognitionService.patterns.values());
    this.stats.patternsAnalyzed = patterns.length;

    // Filter patterns by trading style
    const relevantPatterns = this.filterPatternsByStyle(patterns);
    
    // Group patterns by type and symbol
    const patternGroups = this.groupPatterns(relevantPatterns);
    
    // Generate indicators for each group
    for (const [groupKey, groupPatterns] of patternGroups.entries()) {
      const indicator = await this.buildIndicatorFromPatterns(groupKey, groupPatterns);
      if (indicator) {
        this.indicators.set(indicator.indicatorId, indicator);
        this.stats.indicatorsGenerated++;
        
        // Map patterns to indicators
        for (const pattern of groupPatterns) {
          if (!this.patternToIndicatorMap.has(pattern.signature || pattern.patternId)) {
            this.patternToIndicatorMap.set(pattern.signature || pattern.patternId, []);
          }
          this.patternToIndicatorMap.get(pattern.signature || pattern.patternId).push(indicator.indicatorId);
        }
      }
    }

    this.stats.lastGenerated = new Date().toISOString();
    console.log(`🎯 Generated ${this.indicators.size} indicators from ${relevantPatterns.length} patterns`);
  }

  /**
   * Filter patterns by trading style
   */
  filterPatternsByStyle(patterns) {
    if (this.tradingStyle === 'scalping') {
      // Scalping: 1min, 5min timeframes, fast patterns
      return patterns.filter(p => 
        (p.timeframe === '1' || p.timeframe === '5') &&
        (p.scalping === true || 
         p.patternType === 'momentum_burst' ||
         p.patternType === 'volatility_expansion' ||
         p.patternType === 'quick_reversal' ||
         p.patternType === 'support_bounce' ||
         p.patternType === 'resistance_rejection')
      );
    } else if (this.tradingStyle === 'swing') {
      // Swing: 15min, 60min, 240min timeframes
      return patterns.filter(p => 
        ['15', '60', '240'].includes(p.timeframe) &&
        (p.patternType === 'breakout_up' ||
         p.patternType === 'breakout_down' ||
         p.patternType === 'mean_reversion')
      );
    } else {
      // Position: Daily, weekly patterns
      return patterns.filter(p => 
        ['D', 'W'].includes(p.timeframe)
      );
    }
  }

  /**
   * Group patterns by symbol and pattern type
   */
  groupPatterns(patterns) {
    const groups = new Map();
    
    for (const pattern of patterns) {
      const groupKey = `${pattern.symbol}_${pattern.patternType}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(pattern);
    }
    
    return groups;
  }

  /**
   * Build an indicator from a group of patterns
   */
  async buildIndicatorFromPatterns(groupKey, patterns) {
    if (patterns.length === 0) return null;

    const [symbol, patternType] = groupKey.split('_');
    const timeframes = [...new Set(patterns.map(p => p.timeframe))];
    const avgConfidence = patterns.reduce((sum, p) => sum + (p.confidence || 0.5), 0) / patterns.length;
    const totalOccurrences = patterns.reduce((sum, p) => sum + (p.occurrences || 1), 0);
    
    // Calculate indicator strength from pattern features
    const indicatorFeatures = this.calculateIndicatorFeatures(patterns);
    
    // Generate indicator based on trading style
    const indicator = {
      indicatorId: `IND_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      name: this.generateIndicatorName(patternType, symbol),
      tradingStyle: this.tradingStyle,
      symbol,
      patternType,
      timeframes,
      confidence: avgConfidence,
      strength: indicatorFeatures.strength,
      occurrences: totalOccurrences,
      features: indicatorFeatures,
      rules: this.generateIndicatorRules(patternType, indicatorFeatures, this.tradingStyle),
      signals: this.generateIndicatorSignals(patternType, indicatorFeatures, this.tradingStyle),
      createdAt: new Date().toISOString(),
      lastSeen: patterns[0].lastSeen || new Date().toISOString(),
      patterns: patterns.map(p => ({
        patternId: p.patternId,
        signature: p.signature,
        confidence: p.confidence,
        occurrences: p.occurrences
      }))
    };

    return indicator;
  }

  /**
   * Calculate indicator features from pattern group
   */
  calculateIndicatorFeatures(patterns) {
    const features = {
      avgVolatility: 0,
      avgPriceChange: 0,
      avgVolumeRatio: 0,
      avgTrendSlope: 0,
      avgMomentumStrength: 0,
      avgReversalStrength: 0,
      supportLevel: null,
      resistanceLevel: null,
      strength: 0
    };

    let count = 0;
    for (const pattern of patterns) {
      if (pattern.features) {
        features.avgVolatility += pattern.features.volatility || 0;
        features.avgPriceChange += Math.abs(pattern.features.priceChange || 0);
        features.avgVolumeRatio += pattern.features.volumeRatio || 0;
        features.avgTrendSlope += Math.abs(pattern.features.trendSlope || 0);
        
        if (pattern.features.momentumStrength) {
          features.avgMomentumStrength += pattern.features.momentumStrength;
        }
        if (pattern.features.reversalStrength) {
          features.avgReversalStrength += pattern.features.reversalStrength;
        }
        
        if (pattern.patternData) {
          if (pattern.patternData.supportLevel && !features.supportLevel) {
            features.supportLevel = pattern.patternData.supportLevel;
          }
          if (pattern.patternData.resistanceLevel && !features.resistanceLevel) {
            features.resistanceLevel = pattern.patternData.resistanceLevel;
          }
        }
        
        count++;
      }
    }

    if (count > 0) {
      features.avgVolatility /= count;
      features.avgPriceChange /= count;
      features.avgVolumeRatio /= count;
      features.avgTrendSlope /= count;
      features.avgMomentumStrength /= count;
      features.avgReversalStrength /= count;
    }

    // Calculate overall strength (0-1)
    if (this.tradingStyle === 'scalping') {
      features.strength = Math.min(1.0, 
        (features.avgMomentumStrength * 2) +
        (features.avgVolumeRatio * 0.3) +
        (features.avgPriceChange * 50) +
        (patterns.length / 10)
      );
    } else {
      features.strength = Math.min(1.0,
        (features.avgPriceChange * 20) +
        (features.avgVolumeRatio * 0.2) +
        (features.avgTrendSlope * 100) +
        (patterns.length / 5)
      );
    }

    return features;
  }

  /**
   * Generate indicator name
   */
  generateIndicatorName(patternType, symbol) {
    const typeNames = {
      'momentum_burst': 'Momentum Burst',
      'volatility_expansion': 'Volatility Expansion',
      'quick_reversal': 'Quick Reversal',
      'support_bounce': 'Support Bounce',
      'resistance_rejection': 'Resistance Rejection',
      'breakout_up': 'Breakout Up',
      'breakout_down': 'Breakout Down',
      'mean_reversion': 'Mean Reversion'
    };

    const stylePrefix = this.tradingStyle === 'scalping' ? 'Scalp' : 
                       this.tradingStyle === 'swing' ? 'Swing' : 'Position';
    
    return `${stylePrefix} ${typeNames[patternType] || patternType} - ${symbol}`;
  }

  /**
   * Generate trading rules for indicator
   */
  generateIndicatorRules(patternType, features, tradingStyle) {
    const rules = {
      entry: [],
      exit: [],
      stopLoss: null,
      takeProfit: null,
      riskManagement: {}
    };

    if (tradingStyle === 'scalping') {
      // Scalping rules
      if (patternType === 'momentum_burst') {
        rules.entry.push(`Volume ratio > ${(features.avgVolumeRatio * 0.9).toFixed(2)}`);
        rules.entry.push(`Price change > ${(features.avgPriceChange * 0.9).toFixed(4)}`);
        rules.entry.push(`Momentum strength > ${(features.avgMomentumStrength * 0.9).toFixed(4)}`);
        rules.stopLoss = `${(features.avgPriceChange * 0.5).toFixed(4)}`; // Tight stop
        rules.takeProfit = `${(features.avgPriceChange * 1.5).toFixed(4)}`; // Quick profit
      } else if (patternType === 'volatility_expansion') {
        rules.entry.push(`Volatility > ${(features.avgVolatility * 0.9).toFixed(4)}`);
        rules.entry.push(`ATR expansion detected`);
        rules.stopLoss = `${(features.avgVolatility * 1.5).toFixed(4)}`;
        rules.takeProfit = `${(features.avgVolatility * 2).toFixed(4)}`;
      } else if (patternType === 'quick_reversal') {
        rules.entry.push(`Reversal strength > ${(features.avgReversalStrength * 0.9).toFixed(4)}`);
        rules.entry.push(`Direction change confirmed`);
        rules.stopLoss = `${(features.avgReversalStrength * 0.6).toFixed(4)}`;
        rules.takeProfit = `${(features.avgReversalStrength * 1.2).toFixed(4)}`;
      } else if (patternType === 'support_bounce' || patternType === 'resistance_rejection') {
        if (features.supportLevel) {
          rules.entry.push(`Price near support: ${features.supportLevel.toFixed(2)}`);
        }
        if (features.resistanceLevel) {
          rules.entry.push(`Price near resistance: ${features.resistanceLevel.toFixed(2)}`);
        }
        rules.entry.push(`Bounce/rejection confirmed`);
        rules.stopLoss = `${(features.avgVolatility * 1.2).toFixed(4)}`;
        rules.takeProfit = `${(features.avgVolatility * 2.5).toFixed(4)}`;
      }

      rules.riskManagement = {
        maxPositionSize: '2-5%',
        maxDailyLoss: '1%',
        maxHoldTime: '5-15 minutes',
        minConfidence: 0.75
      };
    } else {
      // Swing/Position rules (similar structure but different thresholds)
      rules.riskManagement = {
        maxPositionSize: '5-10%',
        maxDailyLoss: '2%',
        maxHoldTime: '1-5 days',
        minConfidence: 0.65
      };
    }

    return rules;
  }

  /**
   * Generate trading signals for indicator
   */
  generateIndicatorSignals(patternType, features, tradingStyle) {
    const signals = {
      buy: [],
      sell: [],
      neutral: []
    };

    if (patternType.includes('burst') || patternType.includes('breakout_up')) {
      signals.buy.push({
        condition: `Momentum strength > ${(features.avgMomentumStrength * 0.8).toFixed(4)}`,
        confidence: features.strength,
        description: 'Strong upward momentum detected'
      });
    }

    if (patternType.includes('reversal') && features.avgReversalStrength > 0) {
      signals.buy.push({
        condition: `Reversal strength > ${(features.avgReversalStrength * 0.8).toFixed(4)}`,
        confidence: features.strength * 0.9,
        description: 'Potential reversal pattern'
      });
    }

    if (patternType === 'support_bounce') {
      signals.buy.push({
        condition: `Price at support level`,
        confidence: features.strength,
        description: 'Support bounce opportunity'
      });
    }

    if (patternType === 'resistance_rejection') {
      signals.sell.push({
        condition: `Price at resistance level`,
        confidence: features.strength,
        description: 'Resistance rejection - potential short'
      });
    }

    if (patternType.includes('breakout_down') || patternType.includes('reversal') && features.avgPriceChange < 0) {
      signals.sell.push({
        condition: `Downward momentum detected`,
        confidence: features.strength,
        description: 'Bearish pattern confirmed'
      });
    }

    return signals;
  }

  /**
   * Get indicator for a symbol and pattern type
   */
  getIndicator(symbol, patternType) {
    for (const indicator of this.indicators.values()) {
      if (indicator.symbol === symbol && indicator.patternType === patternType) {
        return indicator;
      }
    }
    return null;
  }

  /**
   * Get all indicators for a trading style
   */
  getIndicatorsByStyle(style = null) {
    const targetStyle = style || this.tradingStyle;
    return Array.from(this.indicators.values())
      .filter(ind => ind.tradingStyle === targetStyle)
      .sort((a, b) => b.strength - a.strength);
  }

  /**
   * Get indicators for a symbol
   */
  getIndicatorsBySymbol(symbol) {
    return Array.from(this.indicators.values())
      .filter(ind => ind.symbol === symbol)
      .sort((a, b) => b.strength - a.strength);
  }

  /**
   * Evaluate current market conditions against indicators
   */
  evaluateMarketConditions(symbol, timeframe, marketData) {
    const indicators = this.getIndicatorsBySymbol(symbol)
      .filter(ind => ind.timeframes.includes(timeframe));

    const evaluations = [];
    for (const indicator of indicators) {
      const evaluation = this.evaluateIndicator(indicator, marketData);
      if (evaluation.match) {
        evaluations.push(evaluation);
      }
    }

    return evaluations.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Evaluate if current market matches indicator
   */
  evaluateIndicator(indicator, marketData) {
    const { price, volume, volatility, priceChange, volumeRatio } = marketData;
    let match = false;
    let confidence = 0;
    let matchedRules = [];

    // Check entry rules
    for (const rule of indicator.rules.entry) {
      if (this.evaluateRule(rule, marketData)) {
        matchedRules.push(rule);
        confidence += 0.2;
      }
    }

    if (matchedRules.length >= indicator.rules.entry.length * 0.7) {
      match = true;
      confidence = Math.min(1.0, indicator.strength * (0.5 + confidence));
    }

    return {
      indicatorId: indicator.indicatorId,
      indicatorName: indicator.name,
      match,
      confidence,
      matchedRules,
      signals: match ? indicator.signals : { buy: [], sell: [], neutral: [] },
      stopLoss: indicator.rules.stopLoss,
      takeProfit: indicator.rules.takeProfit
    };
  }

  /**
   * Evaluate a single rule against market data
   */
  evaluateRule(rule, marketData) {
    // Simple rule evaluation (can be enhanced)
    if (rule.includes('Volume ratio')) {
      const threshold = parseFloat(rule.match(/>\s*([\d.]+)/)?.[1] || '0');
      return marketData.volumeRatio >= threshold;
    }
    if (rule.includes('Price change')) {
      const threshold = parseFloat(rule.match(/>\s*([\d.]+)/)?.[1] || '0');
      return Math.abs(marketData.priceChange) >= threshold;
    }
    if (rule.includes('Momentum strength')) {
      const threshold = parseFloat(rule.match(/>\s*([\d.]+)/)?.[1] || '0');
      const momentum = Math.abs(marketData.priceChange) * marketData.volumeRatio;
      return momentum >= threshold;
    }
    if (rule.includes('Volatility')) {
      const threshold = parseFloat(rule.match(/>\s*([\d.]+)/)?.[1] || '0');
      return marketData.volatility >= threshold;
    }
    return false;
  }

  /**
   * Save indicators to Google Drive
   */
  async saveIndicators() {
    if (!this.enabled) return;

    try {
      const indicatorsArray = Array.from(this.indicators.values());
      const indicatorsData = {
        version: '1.0',
        tradingStyle: this.tradingStyle,
        lastUpdated: new Date().toISOString(),
        indicators: indicatorsArray,
        stats: this.stats
      };

      // Save via pattern recognition service (uses Google Drive)
      // Store in TradingPatterns/indicators_<style>.json
      const fileName = `indicators_${this.tradingStyle}.json`;
      // TODO: Integrate with Google Drive storage
      // For now, save locally
      const fs = require('fs').promises;
      const path = require('path');
      const filePath = path.join(process.cwd(), 'data', 'indicators', fileName);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(indicatorsData, null, 2));
      
      console.log(`💾 Saved ${indicatorsArray.length} indicators to ${fileName}`);
    } catch (error) {
      console.error('❌ Error saving indicators:', error.message);
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalIndicators: this.indicators.size,
      tradingStyle: this.tradingStyle,
      enabled: this.enabled,
      indicatorsByStyle: {
        scalping: this.getIndicatorsByStyle('scalping').length,
        swing: this.getIndicatorsByStyle('swing').length,
        position: this.getIndicatorsByStyle('position').length
      }
    };
  }
}

module.exports = new IndicatorGenerator();


