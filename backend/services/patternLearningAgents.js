/**
 * Pattern Learning Agents
 * Specialized agents that learn different types of patterns
 * 
 * Feature Flag: ENABLE_PATTERN_LEARNING_AGENTS (default: true)
 */

const patternRecognitionService = require('./patternRecognitionService');
const googleDriveStorage = require('./googleDrivePatternStorage');

class PatternLearningAgent {
  constructor(agentType, config = {}) {
    this.agentType = agentType; // 'opening_pattern', 'reversal_pattern', etc.
    this.config = {
      minConfidence: config.minConfidence || 0.7,
      minSampleSize: config.minSampleSize || 5,
      learningRate: config.learningRate || 0.1,
      ...config
    };
    
    this.learnedPatterns = new Map();
    this.performance = {
      totalDetections: 0,
      successfulPredictions: 0,
      totalPnL: 0,
      winRate: 0
    };
  }

  /**
   * Learn from a trade outcome
   */
  async learnFromTrade(trade, detectedPatterns) {
    for (const pattern of detectedPatterns) {
      if (pattern.patternType.startsWith(this.agentType) || 
          this.matchesAgentType(pattern)) {
        
        // Update pattern performance
        const patternKey = this.getPatternKey(pattern);
        
        if (!this.learnedPatterns.has(patternKey)) {
          this.learnedPatterns.set(patternKey, {
            pattern: pattern,
            occurrences: 0,
            wins: 0,
            losses: 0,
            totalPnL: 0,
            winRate: 0
          });
        }

        const learned = this.learnedPatterns.get(patternKey);
        learned.occurrences++;
        learned.totalPnL += trade.pnl;

        if (trade.pnl > 0) {
          learned.wins++;
        } else {
          learned.losses++;
        }

        learned.winRate = learned.wins / learned.occurrences;

        // Update agent performance
        this.performance.totalDetections++;
        if (trade.pnl > 0) {
          this.performance.successfulPredictions++;
        }
        this.performance.totalPnL += trade.pnl;
        this.performance.winRate = this.performance.successfulPredictions / this.performance.totalDetections;
      }
    }
  }

  /**
   * Check if pattern matches agent type
   */
  matchesAgentType(pattern) {
    // Override in subclasses
    return false;
  }

  /**
   * Get pattern key for storage
   */
  getPatternKey(pattern) {
    return `${pattern.patternType}_${pattern.timeframe || '5min'}`;
  }

  /**
   * Get agent performance
   */
  getPerformance() {
    return {
      agentType: this.agentType,
      ...this.performance,
      learnedPatterns: this.learnedPatterns.size,
      topPatterns: Array.from(this.learnedPatterns.values())
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 5)
        .map(p => ({
          patternType: p.pattern.patternType,
          winRate: p.winRate,
          occurrences: p.occurrences,
          totalPnL: p.totalPnL
        }))
    };
  }
}

/**
 * Opening Pattern Agent
 * Specializes in 5min and 15min opening patterns
 */
class OpeningPatternAgent extends PatternLearningAgent {
  constructor() {
    super('opening_pattern', {
      minConfidence: 0.65,
      timeframes: ['5min', '15min']
    });
  }

  matchesAgentType(pattern) {
    return pattern.patternType.includes('opening') || 
           pattern.patternType.includes('gap') ||
           (pattern.timeframe && ['5min', '15min'].includes(pattern.timeframe));
  }

  /**
   * Analyze opening patterns for a symbol
   */
  async analyzeOpening(symbol, marketData, timeframe) {
    const patterns = await patternRecognitionService.detectPatterns(
      symbol,
      marketData,
      timeframe
    );

    // Filter for opening patterns
    return patterns.filter(p => 
      p.patternType.includes('opening') || 
      p.patternType.includes('gap')
    );
  }
}

/**
 * Reversal Pattern Agent
 * Specializes in reversal patterns (double top/bottom, etc.)
 */
class ReversalPatternAgent extends PatternLearningAgent {
  constructor() {
    super('reversal_pattern', {
      minConfidence: 0.7
    });
  }

  matchesAgentType(pattern) {
    return pattern.patternType.includes('reversal') ||
           pattern.patternType.includes('double') ||
           pattern.patternType.includes('top') ||
           pattern.patternType.includes('bottom');
  }
}

/**
 * Support/Resistance Agent
 * Specializes in support/resistance bounce patterns
 */
class SupportResistanceAgent extends PatternLearningAgent {
  constructor() {
    super('support_resistance', {
      minConfidence: 0.68
    });
  }

  matchesAgentType(pattern) {
    return pattern.patternType.includes('support') ||
           pattern.patternType.includes('resistance') ||
           pattern.patternType.includes('bounce') ||
           pattern.patternType.includes('rejection');
  }
}

/**
 * Pattern Learning Agent Manager
 * Coordinates multiple specialized agents
 */
class PatternLearningAgentManager {
  constructor() {
    this.enabled = process.env.ENABLE_PATTERN_LEARNING_AGENTS !== 'false';
    
    this.agents = {
      opening: new OpeningPatternAgent(),
      reversal: new ReversalPatternAgent(),
      supportResistance: new SupportResistanceAgent()
    };

    // Sync to Google Drive periodically
    if (this.enabled) {
      setInterval(() => this.syncToGoogleDrive(), 10 * 60 * 1000); // Every 10 minutes
    }
  }

  /**
   * Learn from a completed trade
   */
  async learnFromTrade(trade, marketData, detectedPatterns) {
    if (!this.enabled) return;

    // Each agent learns from the trade
    for (const agent of Object.values(this.agents)) {
      await agent.learnFromTrade(trade, detectedPatterns);
    }

    // Store successful patterns
    for (const pattern of detectedPatterns) {
      if (trade.pnl > 0 && pattern.confidence > 0.7) {
        await patternRecognitionService.learnFromTrade(trade, marketData, [pattern]);
      }
    }
  }

  /**
   * Get pattern predictions for current market
   */
  async getPredictions(symbol, marketData, timeframe = '5min') {
    if (!this.enabled) return [];

    const predictions = [];

    // Opening pattern agent (for 5min/15min)
    if (timeframe === '5min' || timeframe === '15min') {
      const openingPatterns = await this.agents.opening.analyzeOpening(
        symbol,
        marketData,
        timeframe
      );
      predictions.push(...openingPatterns);
    }

    // All agents detect patterns
    const allPatterns = await patternRecognitionService.detectPatterns(
      symbol,
      marketData,
      timeframe
    );

    // Filter by agent types
    for (const pattern of allPatterns) {
      for (const agent of Object.values(this.agents)) {
        if (agent.matchesAgentType(pattern)) {
          // Boost confidence based on agent's historical performance
          const agentPerf = agent.getPerformance();
          const boostedConfidence = Math.min(0.95,
            pattern.confidence * 0.7 + agentPerf.winRate * 0.3
          );
          
          predictions.push({
            ...pattern,
            confidence: boostedConfidence,
            agentType: agent.agentType,
            agentWinRate: agentPerf.winRate
          });
        }
      }
    }

    return predictions;
  }

  /**
   * Get all agent performance
   */
  getAllAgentPerformance() {
    const performance = {};
    
    for (const [name, agent] of Object.entries(this.agents)) {
      performance[name] = agent.getPerformance();
    }

    return performance;
  }

  /**
   * Sync patterns to Google Drive
   */
  async syncToGoogleDrive() {
    if (!this.enabled) return;

    try {
      // Get all patterns from pattern recognition service
      const stats = patternRecognitionService.getStats();
      const patterns = Array.from(patternRecognitionService.patterns.values());

      // Sync to Google Drive
      const result = await googleDriveStorage.syncToDrive(patterns);
      
      if (result.success) {
        console.log(`✅ Synced ${result.uploaded} patterns to Google Drive`);
      }
    } catch (error) {
      console.error('❌ Error syncing to Google Drive:', error.message);
    }
  }
}

module.exports = new PatternLearningAgentManager();


