#!/usr/bin/env node

/**
 * 🎯 Secure TradingView Webhook Server
 * Enhanced with authentication, validation, deduplication, risk management, and trade ledger
 * 
 * Feature Flags:
 * - ENABLE_WEBHOOK_AUTH: Enable HMAC signature verification (default: true)
 * - ENABLE_WEBHOOK_VALIDATION: Enable payload validation (default: true)
 * - ENABLE_WEBHOOK_DEDUPE: Enable alert deduplication (default: true)
 * - ENABLE_RISK_ENGINE: Enable risk management (default: true)
 * - ENABLE_TRADE_LEDGER: Enable immutable trade ledger (default: true)
 */

// Load environment variables first
require('dotenv').config();

// Validate environment variables (fail fast)
const envValidator = require('./backend/services/envValidator');
envValidator.validateAndFailFast();

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const rateLimit = require('express-rate-limit');

// Import middleware and services
const { webhookAuth } = require('./backend/middleware/webhookAuth');
const { webhookValidation } = require('./backend/middleware/webhookValidation');
const { cooldownGuardMiddleware } = require('./backend/middleware/cooldownGuard');
const { riskCheck } = require('./backend/middleware/riskCheck');
const deduplicationService = require('./backend/services/deduplicationService');
const riskEngine = require('./backend/services/riskEngine');
const tradeLedger = require('./backend/db/tradeLedger');
const paperTradingService = require('./backend/services/paperTradingService'); // Keep for backward compatibility
const tradingLearningService = require('./backend/services/tradingLearningService');
const patternRecognitionService = require('./backend/services/patternRecognitionService');
const patternLearningAgents = require('./backend/services/patternLearningAgents');
const patternLearningEngine = require('./backend/services/patternLearningEngine');
const learningDaemon = require('./backend/services/learningDaemon');
const indicatorGenerator = require('./backend/services/indicatorGenerator');
const dailyPatternTracker = require('./backend/services/dailyPatternTracker');
const automatedScalpingTrader = require('./backend/services/automatedScalpingTrader');
const tradingViewSync = require('./backend/services/tradingViewSync');
const { getBrokerAdapter } = require('./backend/adapters/brokerAdapterFactory');
const tradingViewTelemetry = require('./backend/services/tradingViewTelemetry');

// ===== Boot guard: prevent double initialization =====
global.__NP_TRADING_BOOTED ??= false;
global.__NP_TRADING_BOOT_RAN ??= false;

if (global.__NP_TRADING_BOOTED) {
  console.warn("⚠️  Boot guard: initialization already ran. Skipping duplicate boot.");
} else {
  global.__NP_TRADING_BOOTED = true;
}

const app = express();
// Support both PORT (standard) and WEBHOOK_PORT (legacy) for consistency
const port = Number(process.env.PORT || process.env.WEBHOOK_PORT || 3014);

// Store raw body for HMAC verification using express.json verify option
app.use(express.json({
  verify: (req, res, buf) => {
    // Store raw body for HMAC verification BEFORE express.json parses it
    if (buf && buf.length) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-TradingView-Signature');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Serve static files (dashboard HTML)
app.use(express.static(__dirname, {
    extensions: ['html'],
    index: false
}));

// Rate limiting (10 requests per minute per IP)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT || '10', 10),
  message: { error: 'Too many requests', message: 'Rate limit exceeded. Max 10 requests per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Factorized webhook pipeline (reusable for both endpoints)
const webhookPipeline = [
  limiter,                    // Rate limiting
  webhookAuth,                // HMAC signature verification
  webhookValidation,          // Payload validation
  cooldownGuardMiddleware,    // Cooldown guard (per symbol+action)
  async (req, res, next) => { // Deduplication check
    try {
      const dedupeResult = await deduplicationService.checkDuplicate(req.body);
      
      if (dedupeResult.isDuplicate) {
        // Record telemetry for duplicate (await to ensure it's recorded)
        try {
          await tradingViewTelemetry.recordWebhook({
            remoteIp: req.ip || req.connection?.remoteAddress,
            userAgent: req.get('user-agent'),
            authModeUsed: req.authModeUsed || 'unknown',
            result: '200',
            httpStatus: 200,
            alertId: req.body.alert_id,
            symbol: req.body.symbol,
            action: req.body.action,
            idempotencyOutcome: 'duplicate'
          });
        } catch (telemetryError) {
          console.warn('⚠️  Failed to record duplicate telemetry:', telemetryError.message);
        }

        // IMPORTANT: return 200 so TradingView won't retry
        return res.status(200).json({
          ok: true,
          status: 'duplicate',
          message: `Duplicate alert ignored (idempotency key ${dedupeResult.idempotencyKey})`,
          idempotencyKey: dedupeResult.idempotencyKey
        });
      }

      // Attach idempotency key to request
      req.idempotencyKey = dedupeResult.idempotencyKey;
      req.idempotencyOutcome = 'new';
      return next();
    } catch (error) {
      console.error('❌ Deduplication error:', error);
      return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  },
  riskCheck                  // Risk management
];

// Main webhook handler (reusable for both endpoints)
async function tradingViewMainHandler(req, res) {
    try {
        // CRITICAL GUARD: If riskCheck returned 403/500, req.orderIntent won't be set
        // This handler should only run if riskCheck passed (called next())
        if (!req.orderIntent) {
            // This should never happen if middleware chain is correct, but defensive check
            console.error('❌ CRITICAL: Handler reached without orderIntent (riskCheck should have blocked)');
            return res.status(500).json({
                status: 'error',
                error: 'INTERNAL_ERROR',
                message: 'Request reached handler without orderIntent validation'
            });
        }
        
        console.log('🚨 TradingView Alert Received:', JSON.stringify(req.body, null, 2));
        
        const alertData = req.body;
        const orderIntent = req.orderIntent;
        // Use idempotency key from middleware (always available if dedupe passed)
        const idempotencyKey = req.idempotencyKey;
        
        // CRITICAL INVARIANT: Only mark as processed if we successfully save to ledger AND return 200
        // Track acceptance state explicitly
        let accepted = false;
        
        // Check if symbol is TradingView-only BEFORE creating trade record
        const symbolRouter = require('./backend/services/symbolRouter');
        const symbolClassification = symbolRouter.classifySymbol(orderIntent.symbol);
        const isTradingViewOnlySymbol = symbolClassification.source === 'tradingview_only';
        
        // Create trade record
        const tradeId = `TRADE_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '100000');
        
        // Set status based on symbol type (TradingView-only = ALERT_ONLY, others = VALIDATED)
        const initialStatus = isTradingViewOnlySymbol ? 'ALERT_ONLY' : 'VALIDATED';
        
        if (isTradingViewOnlySymbol) {
            console.log(`ℹ️  Routing TradingView-only symbol to ALERT_ONLY ledger status: ${symbolClassification.normalizedSymbol}`);
        }
        
        // Collect BOS/ATR metrics if available (from riskCheck middleware)
        const bosMetrics = req.bosMetrics || null;
        
        const tradeData = {
            trade_id: tradeId,
            idempotency_key: idempotencyKey,
            timestamp: new Date().toISOString(),
            symbol: orderIntent.symbol,
            action: orderIntent.action,
            price: orderIntent.price,
            quantity: orderIntent.quantity,
            stop_loss: orderIntent.stopLoss,
            take_profit: orderIntent.takeProfit,
            confidence: orderIntent.confidence || parseFloat(alertData.confidence) || null,
            account_balance: accountBalance,
            ai_score: parseFloat(alertData.ai_score) || null,
            regime: alertData.regime || null,
            risk_mode: alertData.risk_mode || null,
            alert_id: alertData.alert_id || null,
            alert_timestamp: alertData.timestamp ? parseInt(alertData.timestamp) : null,
            status: initialStatus,
            metadata: {
                original_alert: alertData,
                // BOS/ATR metrics for learning agent
                bosMetrics: bosMetrics ? {
                    atrSlope: bosMetrics.atrSlope,
                    atrExpansion: bosMetrics.atrExpansion,
                    currentATR: bosMetrics.currentATR,
                    avgATR: bosMetrics.avgATR,
                    bosCount: bosMetrics.bosCount,
                    bosDirection: bosMetrics.bosDirection,
                    barsSinceCHOCH: bosMetrics.barsSinceCHOCH,
                    cooldownRequired: bosMetrics.cooldownRequired
                } : null
            }
        };
        
        console.log('💰 Processed Trade:', tradeData);
        
        // Save to immutable ledger (must succeed for true acceptance)
        try {
            await tradeLedger.initialize();
            const ledgerId = await tradeLedger.insertTrade(tradeData);
            console.log(`✅ Trade saved to ledger (ID: ${ledgerId}) with status: ${initialStatus}`);
        } catch (error) {
            console.error('❌ Ledger save error:', error.message);
            // Not accepted → return non-2xx so TradingView can retry
            // This ensures clean invariant: 2xx ⇒ ledgerSaved ⇒ marked, non-2xx ⇒ not marked
            return res.status(503).json({
                status: 'error',
                error: 'LEDGER_WRITE_FAILED',
                message: error.message,
                idempotency_key: idempotencyKey
            });
        }
        
        // Also save to file (backup/legacy)
        const dataDir = './TradingDrive/webhook_logs';
        try {
            await fs.mkdir(dataDir, { recursive: true });
            const logFile = path.join(dataDir, 'trades.json');
            
            let trades = [];
            try {
                const data = await fs.readFile(logFile, 'utf8');
                trades = JSON.parse(data);
            } catch (e) {
                // File doesn't exist yet
            }
            
            trades.push(tradeData);
            await fs.writeFile(logFile, JSON.stringify(trades, null, 2));
            
            console.log('✅ Trade data saved to file');
        } catch (error) {
            console.error('❌ File save error:', error.message);
        }
        
        // Evaluate market conditions against scalping indicators (if enabled)
        let indicatorMatch = null;
        let indicatorBoost = 0;
        if (indicatorGenerator.enabled) {
            try {
                const marketData = {
                    price: orderIntent.price,
                    volume: alertData.volume || 0,
                    volatility: alertData.volatility || 0.01,
                    priceChange: alertData.priceChange || 0,
                    volumeRatio: alertData.volumeRatio || 1.0
                };
                
                const evaluations = indicatorGenerator.evaluateMarketConditions(
                    orderIntent.symbol,
                    alertData.timeframe || '1',
                    marketData
                );
                
                // Use best matching indicator
                if (evaluations.length > 0 && evaluations[0].match) {
                    indicatorMatch = evaluations[0];
                    indicatorBoost = indicatorMatch.confidence;
                    console.log(`🎯 Indicator match: ${indicatorMatch.indicatorName} (confidence: ${(indicatorBoost * 100).toFixed(1)}%)`);
                    
                    // Boost confidence if indicator matches
                    if (orderIntent.confidence) {
                        orderIntent.confidence = Math.min(1.0, orderIntent.confidence + (indicatorBoost * 0.2));
                    }
                    
                    // Use indicator stop loss/take profit if available
                    // Override defaults with indicator values (indicators are more sophisticated than simple defaults)
                    if (indicatorMatch.stopLoss && orderIntent._stopLossWasDefault) {
                        const stopLossPrice = orderIntent.price * (1 - parseFloat(indicatorMatch.stopLoss));
                        orderIntent.stopLoss = stopLossPrice;
                        console.log(`🎯 Using indicator stop loss: ${stopLossPrice.toFixed(2)} (overriding default)`);
                    }
                    if (indicatorMatch.takeProfit && orderIntent._takeProfitWasDefault) {
                        const takeProfitPrice = orderIntent.price * (1 + parseFloat(indicatorMatch.takeProfit));
                        orderIntent.takeProfit = takeProfitPrice;
                        console.log(`🎯 Using indicator take profit: ${takeProfitPrice.toFixed(2)} (overriding default)`);
                    }
                }
            } catch (indError) {
                console.warn('⚠️  Indicator evaluation failed:', indError.message);
            }
        }
        
        // Execute trade via broker adapter
        // Skip broker execution for TradingView-only symbols (already set status='ALERT_ONLY' in ledger)
        let executionResult = null;
        try {
            if (isTradingViewOnlySymbol) {
                console.log(`ℹ️  TradingView symbol detected (${orderIntent.symbol}), skipping broker execution - relying on TradingView alerts only`);
                // Trade already logged with status='ALERT_ONLY' in ledger
                // No execution result needed (will be handled in response)
            } else {
                const brokerAdapter = getBrokerAdapter();
                
                // Ensure broker is connected before executing trade
                // NOTE: getBrokerAdapter() does NOT auto-connect to avoid race conditions.
                // Connection is explicitly handled here with proper awaiting to ensure
                // isConnected() checks are reliable.
                if (brokerAdapter.isEnabled()) {
                    // If not connected, try to connect (with timeout for first webhook)
                    if (!brokerAdapter.isConnected()) {
                        console.log(`⏳ Broker adapter not connected, attempting connection...`);
                        try {
                            // Use Promise.race to add a timeout for connection attempts
                            // IMPORTANT: We await the connection here to ensure isConnected() 
                            // will return true before we proceed to execute trades
                            const connectPromise = brokerAdapter.connect();
                            const timeoutPromise = new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('Connection timeout')), 5000)
                            );
                            await Promise.race([connectPromise, timeoutPromise]);
                            
                            // Verify connection state after await (defensive check)
                            if (!brokerAdapter.isConnected()) {
                                throw new Error('Connection completed but adapter reports not connected');
                            }
                            console.log(`✅ Broker adapter connected successfully`);
                        } catch (connectError) {
                            console.warn(`⚠️  Failed to connect to ${brokerAdapter.getName()} broker: ${connectError.message}`);
                            // For paper trading, connection should always succeed, so continue
                            // For real brokers, we might want to reject or fallback
                            if (brokerAdapter.getName() !== 'Paper' && !brokerAdapter.isConnected()) {
                                throw new Error(`Cannot execute trade: ${brokerAdapter.getName()} broker not connected`);
                            }
                        }
                    }
                    
                    // Execute trade if connected (final safety check)
                    if (brokerAdapter.isConnected()) {
                        executionResult = await brokerAdapter.placeOrder(orderIntent);
                        console.log(`✅ Trade executed via ${brokerAdapter.getName()} broker: ${executionResult.tradeId}`);
                        
                        // Record cooldown guard execution (after successful trade)
                        if (req.cooldownGuard) {
                            req.cooldownGuard.recordExecution(orderIntent.symbol, orderIntent.action);
                        }
                        
                        // Update trade status to EXECUTED/FILLED in ledger
                        if (executionResult.executionResult) {
                            tradeData.status = 'FILLED';
                            tradeData.pnl = executionResult.executionResult.pnl || 0;
                            tradeData.executed_at = executionResult.executionResult.executedAt;
                            
                            // Check if this is a trade close (SELL closes BUY, etc.)
                            // For v1: simple single-position model - SELL closes BUY position
                            const isTradeClose = (orderIntent.action === 'SELL' || orderIntent.action === 'CLOSE');
                            
                            // Pattern attribution on trade close (guard against double-counting)
                            if (isTradeClose && tradeData.pnl !== undefined && tradeData.pnl !== null) {
                                try {
                                    const patternAttributionService = require('./backend/services/patternAttributionService');
                                    
                                    // Get patterns from alert metadata or pattern recognition
                                    const patterns = alertData.patterns || [];
                                    
                                    // Calculate PnL percentage (if account balance available)
                                    const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '100000');
                                    const pnlPct = accountBalance > 0 ? (tradeData.pnl / accountBalance) * 100 : 0;
                                    
                                    // Attribute trade to patterns (idempotent - checks for existing attribution)
                                    await patternAttributionService.attributeTrade(
                                        tradeId,
                                        patterns,
                                        {
                                            pnl: tradeData.pnl,
                                            pnlPct: pnlPct
                                        }
                                    );
                                    
                                    console.log(`📊 Pattern attribution completed for trade ${tradeId}`);
                                } catch (attributionError) {
                                    console.error('❌ Pattern attribution error:', attributionError.message);
                                    // Continue - attribution failure shouldn't break trade execution
                                }
                            }
                            
                            // Learn from trade outcome (pattern recognition + learning agents)
                            try {
                                // Prepare market data for pattern learning
                                const marketData = {
                                    timestamp: new Date().toISOString(),
                                    price: orderIntent.price,
                                    high: orderIntent.price * 1.01, // Estimate
                                    low: orderIntent.price * 0.99,  // Estimate
                                    volume: alertData.volume || null,
                                    previousClose: alertData.previousClose || null,
                                    timeframe: alertData.timeframe || '5min',
                                    indicators: {
                                        rsi: alertData.rsi || null,
                                        macd: alertData.macd || null,
                                        ema20: alertData.ema20 || null,
                                        ema50: alertData.ema50 || null
                                    }
                                };
                                
                                // Learn from trade (includes pattern recognition + indicator learning)
                                await tradingLearningService.learnFromTrade(
                                    {
                                        symbol: orderIntent.symbol,
                                        action: orderIntent.action,
                                        pnl: tradeData.pnl,
                                        fillPrice: executionResult.executionResult.fillPrice,
                                        filledQuantity: executionResult.executionResult.filledQuantity,
                                        indicatorMatch: indicatorMatch ? {
                                            indicatorId: indicatorMatch.indicatorId,
                                            indicatorName: indicatorMatch.indicatorName,
                                            confidence: indicatorMatch.confidence
                                        } : null
                                    },
                                    orderIntent,
                                    marketData
                                );
                                
                                console.log('🧠 Pattern learning completed');
                            } catch (learningError) {
                                console.error('❌ Pattern learning error:', learningError.message);
                                // Continue - learning failure shouldn't break trade execution
                            }
                        }
                    } else {
                        console.warn(`⚠️  Broker adapter (${brokerAdapter.getName()}) is not connected after connection attempt`);
                    }
                } else {
                    console.warn(`⚠️  Broker adapter (${brokerAdapter.getName()}) is disabled`);
                }
            }
        } catch (error) {
            console.error(`❌ Trade execution failed: ${error.message}`);
            // Continue - trade is still logged even if execution fails
            tradeData.status = 'REJECTED';
            tradeData.rejection_reason = error.message;
            
            // Record telemetry for execution failure (still 200 response, but trade failed)
            await tradingViewTelemetry.recordWebhook({
              remoteIp: req.ip || req.connection?.remoteAddress,
              userAgent: req.get('user-agent'),
              authModeUsed: req.authModeUsed || 'unknown',
              result: '200',
              httpStatus: 200,
              alertId: alertData.alert_id,
              symbol: orderIntent.symbol,
              action: orderIntent.action,
              idempotencyOutcome: req.idempotencyOutcome || 'new',
              executionError: error.message
            }).catch(() => {}); // Don't block on telemetry errors
            
            // Update ledger with rejection
            try {
                await tradeLedger.updateTradeStatus(tradeId, 'REJECTED', {
                    rejection_reason: error.message
                });
            } catch (ledgerError) {
                console.error('❌ Error updating ledger:', ledgerError);
            }
        }
        
        // Record successful webhook telemetry
        await tradingViewTelemetry.recordWebhook({
          remoteIp: req.ip || req.connection?.remoteAddress,
          userAgent: req.get('user-agent'),
          authModeUsed: req.authModeUsed || 'unknown',
          result: '200',
          httpStatus: 200,
          alertId: alertData.alert_id,
          symbol: orderIntent.symbol,
          action: orderIntent.action,
          idempotencyOutcome: req.idempotencyOutcome || 'new'
        }).catch(err => {
          console.warn('⚠️  Telemetry recording failed:', err.message);
        });
        
        // Build execution response based on symbol type
        let executionResponse;
        if (isTradingViewOnlySymbol) {
            // TradingView-only symbols: not executed, reason provided
            executionResponse = {
                executed: false,
                reason: 'TRADINGVIEW_ONLY'
            };
        } else if (executionResult) {
            // Normal execution
            executionResponse = {
                executed: true,
                tradeId: executionResult.tradeId,
                fillPrice: executionResult.executionResult?.fillPrice,
                filledQuantity: executionResult.executionResult?.filledQuantity,
                pnl: executionResult.executionResult?.pnl
            };
        } else {
            // No execution (e.g., TRADING_ENABLED=false for Binance symbols)
            executionResponse = { executed: false };
        }
        
        // CRITICAL INVARIANT: Only mark as processed if ledger saved successfully
        // Ledger save happens at line 197 - if it fails, we return 503 at line 203
        // If we reach here, ledger save succeeded, so we can mark as accepted
        accepted = true;
        
        // Mark as processed in deduplication cache (only on true acceptance)
        // Invariant: 2xx response ⇒ ledger saved ⇒ marked as processed
        // This ensures failed requests (403, 500, 503) can be retried
        // IMPORTANT: Mark BEFORE sending response to avoid race conditions
        // CRITICAL: Only mark if we're about to return 200 (ledger saved successfully)
        if (idempotencyKey && accepted) {
          await deduplicationService.markAsProcessed(idempotencyKey);
        }
        
        // Send success response (ledger saved, marked as processed)
        // Note: status "success" means "received and recorded", execution may be false
        // CRITICAL: This is the ONLY place where we return 200, ensuring markAsProcessed is only called on success
        return res.status(200).json({ 
            status: 'success', 
            message: 'Trade alert received and validated' + (executionResult ? ' and executed' : ''),
            trade_id: tradeId,
            idempotency_key: idempotencyKey,
            execution: executionResponse,
            data: tradeData
        });
        
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        // CRITICAL: Do NOT mark as processed on error (non-2xx response)
        // This ensures TradingView can retry failed requests
        // accepted remains false, so markAsProcessed() is never called
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
}

// Main webhook endpoint for TradingView (legacy path)
app.post('/webhook/tradingview', ...webhookPipeline, tradingViewMainHandler);

// API webhook endpoint for TradingView (recommended path)
app.post('/api/webhook/tradingview', ...webhookPipeline, tradingViewMainHandler);

// Test GET endpoint to verify server is working
app.get('/webhook/tradingview', (req, res) => {
    res.json({
        status: 'active',
        message: 'TradingView webhook endpoint is ready',
        method: 'Use POST requests to send alerts',
        url: `http://localhost:${port}/webhook/tradingview`
    });
});

// Trading status endpoint
app.get('/api/status/trading', async (req, res) => {
  try {
    const tradingMode = process.env.TRADING_MODE || 'paper';
    const tradingEnabled = process.env.TRADING_ENABLED !== 'false';
    const riskEnabled = process.env.ENABLE_RISK_ENGINE !== 'false';
    
    // Get broker adapter status
    let oandaConfigured = false;
    let brokerHealth = null;
    try {
      const brokerAdapter = getBrokerAdapter();
      brokerHealth = await brokerAdapter.healthCheck();
      oandaConfigured = brokerAdapter.getName() === 'OANDA' && brokerAdapter.isEnabled();
    } catch (error) {
      // Broker not available
    }
    
    // Get last webhook timestamp from telemetry
    let lastWebhookTimestamp = null;
    try {
      await tradingViewTelemetry.initialize();
      const lastTelemetry = tradingViewTelemetry.getLastTelemetry();
      if (lastTelemetry) {
        lastWebhookTimestamp = lastTelemetry.receivedAt;
      }
    } catch (error) {
      // Telemetry not available
    }
    
    // Get open positions count
    let openPositionsCount = 0;
    try {
      const brokerAdapter = getBrokerAdapter();
      const positions = await brokerAdapter.getPositions();
      openPositionsCount = positions ? positions.length : 0;
    } catch (error) {
      // Positions not available
    }
    
    // Get ledger path
    const ledgerPath = process.env.LEDGER_DB_PATH || './data/trade_ledger.db';
    
    // Get last error (if any) - could be from risk engine or broker
    let lastError = null;
    if (brokerHealth && !brokerHealth.connected && brokerHealth.error) {
      lastError = brokerHealth.error;
    }
    
    // Get cooldown guard stats
    const { cooldownGuard } = require('./backend/middleware/cooldownGuard');
    const cooldownStats = cooldownGuard.getStats();
    
    res.json({
      ok: true,
      mode: tradingMode,
      trading_enabled: tradingEnabled,
      risk_enabled: riskEnabled,
      oanda_configured: oandaConfigured,
      last_webhook_timestamp: lastWebhookTimestamp,
      open_positions_count: openPositionsCount,
      ledger_path: ledgerPath,
      last_error: lastError,
      cooldown: {
        enabled: cooldownStats.enabled,
        seconds: cooldownStats.cooldownSeconds,
        active_cooldowns: cooldownStats.activeCooldowns
      },
      broker: brokerHealth ? {
        name: brokerHealth.broker || 'unknown',
        connected: brokerHealth.connected || false,
        enabled: brokerHealth.enabled !== false
      } : null
    });
  } catch (error) {
    console.error('❌ Error getting trading status:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', async (req, res) => {
    const riskStats = riskEngine.getStats();
    const dedupeStats = deduplicationService.getStats();
    const learningMetrics = tradingLearningService.getMetrics();
    
    // Get broker adapter and account summary
    let accountSummary = null;
    let brokerHealth = null;
    try {
        const brokerAdapter = getBrokerAdapter();
        accountSummary = await brokerAdapter.getAccountSummary();
        brokerHealth = await brokerAdapter.healthCheck();
    } catch (error) {
        console.error('❌ Error getting broker adapter:', error.message);
        // Fallback to paper trading service for backward compatibility
        accountSummary = paperTradingService.getAccountSummary();
        brokerHealth = { connected: false, error: error.message };
    }
    
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: port,
        features: {
            auth: process.env.ENABLE_WEBHOOK_AUTH !== 'false',
            validation: process.env.ENABLE_WEBHOOK_VALIDATION !== 'false',
            deduplication: dedupeStats.enabled,
            riskEngine: riskStats.enabled,
            tradeLedger: process.env.ENABLE_TRADE_LEDGER !== 'false',
            paperTrading: process.env.ENABLE_PAPER_TRADING !== 'false',
            learning: tradingLearningService.enabled
        },
        broker: {
            type: process.env.BROKER || 'paper',
            health: brokerHealth
        },
        risk: riskStats,
        deduplication: dedupeStats,
        account: accountSummary,
        learning: learningMetrics
    });
});

// Account summary endpoint
app.get('/api/account', async (req, res) => {
    try {
        const brokerAdapter = getBrokerAdapter();
        const accountSummary = await brokerAdapter.getAccountSummary();
        res.json(accountSummary);
    } catch (error) {
        console.error('❌ Error getting account summary:', error.message);
        // Fallback to paper trading service for backward compatibility
        const accountSummary = paperTradingService.getAccountSummary();
        res.json(accountSummary);
    }
});

// Learning metrics endpoint
app.get('/api/learning', (req, res) => {
    const learningMetrics = tradingLearningService.getMetrics();
    res.json(learningMetrics);
});

// ===== DEV-ONLY DEDUPE ENDPOINTS =====

// Helper to check if dev endpoints are enabled
const isDevEndpointsEnabled = () => {
    return process.env.NODE_ENV === 'development' || process.env.ENABLE_DEV_ENDPOINTS === 'true';
};

// Get dedupe stats (dev only)
app.get('/api/dedupe/stats', (req, res) => {
    if (!isDevEndpointsEnabled()) {
        return res.status(404).json({ error: 'Not found' });
    }

    try {
        const stats = deduplicationService.getStats();
        const sampleKeys = deduplicationService.getSampleKeys(20);
        const cacheFile = deduplicationService.getCacheFilePath();
        const fs = require('fs');
        
        // Check if cache file exists
        let cacheFileExists = false;
        try {
            fs.accessSync(cacheFile, fs.constants.F_OK);
            cacheFileExists = true;
        } catch (e) {
            // File doesn't exist, that's okay
        }

        res.json({
            enabled: stats.enabled,
            size: stats.size,
            ttlSeconds: stats.ttl,
            sampleKeys: sampleKeys,
            source: 'in_memory', // Always in-memory with optional file persistence
            cacheFile: cacheFileExists ? cacheFile : null
        });
    } catch (error) {
        console.error('❌ Error getting dedupe stats:', error.message);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Reset dedupe cache (dev only)
app.post('/api/dedupe/reset', async (req, res) => {
    if (!isDevEndpointsEnabled()) {
        return res.status(404).json({ error: 'Not found' });
    }

    try {
        const fs = require('fs').promises;
        const cacheFile = deduplicationService.getCacheFilePath();
        
        // Clear in-memory cache
        const cleared = deduplicationService.clearCache();
        
        // Delete cache file if it exists
        let deletedFile = false;
        try {
            await fs.unlink(cacheFile);
            deletedFile = true;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                // File doesn't exist, that's okay
                throw error;
            }
        }

        res.json({
            status: 'ok',
            cleared: cleared,
            deletedFile: deletedFile
        });
    } catch (error) {
        console.error('❌ Error resetting dedupe cache:', error.message);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// ===== DASHBOARD API ENDPOINTS =====

// Dashboard: Get recent trades
app.get('/api/dashboard/trades', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const offset = parseInt(req.query.offset || '0', 10);
        
        const trades = await tradeLedger.getTrades(limit, offset);
        res.json({
            success: true,
            trades: trades,
            count: trades.length,
            limit: limit,
            offset: offset
        });
    } catch (error) {
        console.error('❌ Error getting trades:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Dashboard: Get open positions
app.get('/api/dashboard/positions', async (req, res) => {
    try {
        const brokerAdapter = getBrokerAdapter();
        const positions = await brokerAdapter.getPositions();
        res.json({
            success: true,
            positions: positions || [],
            count: positions ? positions.length : 0
        });
    } catch (error) {
        console.error('❌ Error getting positions:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            positions: []
        });
    }
});

// Dashboard: Get account summary (enhanced)
app.get('/api/dashboard/account', async (req, res) => {
    try {
        const brokerAdapter = getBrokerAdapter();
        const accountSummary = await brokerAdapter.getAccountSummary();
        
        // Get daily PnL from ledger
        const dailyPnL = await tradeLedger.getDailyPnL();
        
        res.json({
            success: true,
            account: accountSummary,
            dailyPnL: dailyPnL
        });
    } catch (error) {
        console.error('❌ Error getting account summary:', error.message);
        // Fallback to paper trading service
        const accountSummary = paperTradingService.getAccountSummary();
        res.json({
            success: true,
            account: accountSummary,
            dailyPnL: { totalPnL: 0, tradeCount: 0 }
        });
    }
});

// Dashboard: Get health summary
app.get('/api/dashboard/health', async (req, res) => {
    try {
        const riskStats = riskEngine.getStats();
        const dedupeStats = deduplicationService.getStats();
        const brokerAdapter = getBrokerAdapter();
        const brokerHealth = await brokerAdapter.healthCheck();
        
        res.json({
            success: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
            features: {
                auth: process.env.ENABLE_WEBHOOK_AUTH !== 'false',
                validation: process.env.ENABLE_WEBHOOK_VALIDATION !== 'false',
                deduplication: dedupeStats.enabled,
                riskEngine: riskStats.enabled,
                tradeLedger: process.env.ENABLE_TRADE_LEDGER !== 'false',
                paperTrading: process.env.ENABLE_PAPER_TRADING !== 'false',
                learning: tradingLearningService.enabled
            },
            broker: {
                type: process.env.BROKER || 'paper',
                name: brokerAdapter.getName(),
                connected: brokerAdapter.isConnected(),
                enabled: brokerAdapter.isEnabled(),
                health: brokerHealth
            },
            risk: riskStats,
            deduplication: dedupeStats
        });
    } catch (error) {
        console.error('❌ Error getting health summary:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Dashboard: Get learning metrics
app.get('/api/dashboard/learning', (req, res) => {
    try {
        const learningMetrics = tradingLearningService.getMetrics();
        res.json({
            success: true,
            learning: learningMetrics
        });
    } catch (error) {
        console.error('❌ Error getting learning metrics:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== PATTERN RECOGNITION API ENDPOINTS =====

// Get all patterns
app.get('/api/patterns', (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const patternType = req.query.type || null;
        
        let patterns = Array.from(patternRecognitionService.patterns.values());
        
        // Filter by type if specified
        if (patternType) {
            patterns = patterns.filter(p => p.patternType === patternType);
        }
        
        // Sort by confidence and limit
        patterns = patterns
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, limit);
        
        res.json({
            success: true,
            patterns: patterns,
            count: patterns.length,
            total: patternRecognitionService.patterns.size
        });
    } catch (error) {
        console.error('❌ Error getting patterns:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get pattern statistics (MUST be before /api/patterns/:id to avoid route shadowing)
app.get('/api/patterns/stats', async (req, res) => {
    try {
        const googleDriveStorage = require('./backend/services/googleDrivePatternStorage');
        const patternStats = patternRecognitionService.getStats();
        const allPatterns = Array.from(patternRecognitionService.patterns.values());
        
        // Count by symbol
        const bySymbol = {};
        const byTimeframe = {};
        
        for (const pattern of allPatterns) {
            // Count by symbol
            const symbol = pattern.symbol || 'unknown';
            bySymbol[symbol] = (bySymbol[symbol] || 0) + 1;
            
            // Count by timeframe
            const timeframe = pattern.timeframe || 'unknown';
            byTimeframe[timeframe] = (byTimeframe[timeframe] || 0) + 1;
        }
        
        // Determine storage mode
        const driveEnabled = process.env.ENABLE_GOOGLE_DRIVE_SYNC === 'true';
        const hasCredentials = !!(
            process.env.GOOGLE_DRIVE_CLIENT_ID &&
            process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
            process.env.GOOGLE_DRIVE_REFRESH_TOKEN
        );
        
        let storageMode = 'LOCAL_ONLY';
        let googleDriveEnabled = false;
        let driveReason = null;
        
        if (driveEnabled && hasCredentials) {
            // Check if Drive is actually connected
            if (googleDriveStorage.drive !== null) {
                storageMode = 'GOOGLE_DRIVE_PRIMARY';
                googleDriveEnabled = true;
            } else {
                storageMode = 'LOCAL_ONLY';
                googleDriveEnabled = false;
                driveReason = 'Drive credentials configured but not connected (check initialization)';
            }
        } else if (driveEnabled && !hasCredentials) {
            storageMode = 'LOCAL_ONLY';
            googleDriveEnabled = false;
            driveReason = 'ENABLE_GOOGLE_DRIVE_SYNC=true but missing credentials (GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN)';
        } else {
            storageMode = 'LOCAL_ONLY';
            googleDriveEnabled = false;
            driveReason = 'ENABLE_GOOGLE_DRIVE_SYNC not set to true';
        }
        
        // Get last sync time from Google Drive storage if available
        const fs = require('fs').promises;
        const path = require('path');
        let lastSyncAt = null;
        let lastSavedAt = null;
        if (googleDriveStorage && googleDriveStorage.lastSyncAt) {
            lastSyncAt = googleDriveStorage.lastSyncAt;
            lastSavedAt = googleDriveStorage.lastSyncAt;
        } else {
            // Try to get from pattern file mtime
            try {
                const patternFile = path.join(__dirname, 'data/patterns.json');
                const stats = await fs.stat(patternFile);
                lastSavedAt = stats.mtime.toISOString();
            } catch (e) {
                // File doesn't exist
            }
        }
        
        res.json({
            success: true,
            totalPatterns: patternStats.totalPatterns || patternRecognitionService.patterns.size,
            bySymbol: bySymbol,
            byTimeframe: byTimeframe,
            storageMode: storageMode,
            googleDriveEnabled: googleDriveEnabled,
            lastSyncAt: lastSyncAt,
            lastSavedAt: lastSavedAt,
            driveReason: driveReason,
            patternsByType: patternStats.patternsByType,
            avgConfidence: patternStats.avgConfidence,
            avgWinRate: patternStats.avgWinRate
        });
    } catch (error) {
        console.error('❌ Error getting pattern stats:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get pattern by ID (must be after /api/patterns/stats to avoid route shadowing)
app.get('/api/patterns/:id', (req, res) => {
    try {
        const pattern = patternRecognitionService.patterns.get(req.params.id);
        
        if (!pattern) {
            return res.status(404).json({
                success: false,
                error: 'Pattern not found'
            });
        }
        
        res.json({
            success: true,
            pattern: pattern
        });
    } catch (error) {
        console.error('❌ Error getting pattern:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== DAILY PATTERN TRACKING API =====

// Get daily pattern statistics
app.get('/api/patterns/daily', async (req, res) => {
  try {
    const stats = dailyPatternTracker.getStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    console.error('❌ Error getting daily patterns:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get opening trends
app.get('/api/patterns/opening-trends', async (req, res) => {
  try {
    const trends = dailyPatternTracker.getOpeningTrends();
    res.json({ success: true, trends });
  } catch (error) {
    console.error('❌ Error getting opening trends:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get best trading times
// ===== AUTOMATED TRADING API =====

// Get automated trading performance
app.get('/api/automated/performance', async (req, res) => {
  try {
    const performance = automatedScalpingTrader.getPerformance();
    res.json({ success: true, performance });
  } catch (error) {
    console.error('❌ Error getting automated trading performance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start automated trading
app.post('/api/automated/start', async (req, res) => {
  try {
    await automatedScalpingTrader.start();
    res.json({ success: true, message: 'Automated trading started' });
  } catch (error) {
    console.error('❌ Error starting automated trading:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop automated trading
app.post('/api/automated/stop', async (req, res) => {
  try {
    automatedScalpingTrader.stop();
    res.json({ success: true, message: 'Automated trading stopped' });
  } catch (error) {
    console.error('❌ Error stopping automated trading:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get automated trading status
app.get('/api/automated/status', async (req, res) => {
  try {
    // Get full status including scanning activity
    const status = automatedScalpingTrader.getStatus();
    
    // Get symbols being monitored
    const universeLoader = require('./backend/services/universeLoader');
    await universeLoader.load();
    const symbols = [...new Set(universeLoader.getSymbolTimeframePairs().map(p => p.symbol))];
    
    res.json({ 
      success: true, 
      status: {
        ...status,
        monitoring: {
          totalSymbols: symbols.length,
          symbols: symbols,
          activePositions: status.activePositions.length,
          lastScanTime: status.lastScanTime
        }
      }
    });
  } catch (error) {
    console.error('❌ Error getting automated trading status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/patterns/best-times', async (req, res) => {
  try {
    const bestTimes = dailyPatternTracker.getBestTradingTimes();
    res.json({ success: true, ...bestTimes });
  } catch (error) {
    console.error('❌ Error getting best trading times:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== TRADINGVIEW TELEMETRY & CONNECTION API ENDPOINTS =====

// Get TradingView webhook telemetry
app.get('/api/tradingview/telemetry', async (req, res) => {
  try {
    await tradingViewTelemetry.initialize();
    const telemetry = tradingViewTelemetry.getLastTelemetry();
    
    if (!telemetry) {
      return res.status(404).json({
        success: false,
        error: 'No webhook telemetry found',
        message: 'No webhooks have been received yet'
      });
    }
    
    res.json({
      success: true,
      telemetry: {
        ...telemetry,
        ageSeconds: tradingViewTelemetry.getTelemetryAge(),
        ageFormatted: tradingViewTelemetry.formatTelemetryAge()
      }
    });
  } catch (error) {
    console.error('❌ Error getting telemetry:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get TradingView connection status
app.get('/api/tradingview/connection', async (req, res) => {
  try {
    // Get server health
    const healthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString()
    };
    
    // Get ngrok URL if available
    let ngrokDetectedUrl = null;
    try {
      const http = require('http');
      const ngrokData = await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 2000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      
      const httpsTunnel = ngrokData.tunnels?.find(t => t.proto === 'https');
      if (httpsTunnel) {
        ngrokDetectedUrl = httpsTunnel.public_url;
      }
    } catch (error) {
      // ngrok not running or not accessible - that's OK
    }
    
    // Get expected public URL from config
    const expectedPublicUrl = process.env.TRADINGVIEW_PUBLIC_WEBHOOK_URL || null;
    
    // Build webhook endpoint URL
    const webhookEndpoint = expectedPublicUrl 
      ? `${expectedPublicUrl}/webhook/tradingview`
      : (ngrokDetectedUrl ? `${ngrokDetectedUrl}/webhook/tradingview` : null);
    
    // Generate recommendations
    const recommendations = [];
    if (!ngrokDetectedUrl && !expectedPublicUrl) {
      recommendations.push('⚠️  ngrok is not running and TRADINGVIEW_PUBLIC_WEBHOOK_URL is not set. TradingView cannot reach your server.');
    } else if (expectedPublicUrl && ngrokDetectedUrl && expectedPublicUrl !== ngrokDetectedUrl) {
      recommendations.push(`⚠️  URL mismatch detected! Expected: ${expectedPublicUrl}, but ngrok shows: ${ngrokDetectedUrl}`);
      recommendations.push(`📋 Update TradingView alert webhook URL to: ${ngrokDetectedUrl}/webhook/tradingview`);
    } else if (!ngrokDetectedUrl && expectedPublicUrl) {
      recommendations.push('⚠️  ngrok is not running. If using ngrok, start it with: ngrok http 3014');
    }
    
    // Get last webhook age
    await tradingViewTelemetry.initialize();
    const lastTelemetry = tradingViewTelemetry.getLastTelemetry();
    const webhookAge = tradingViewTelemetry.getTelemetryAge();
    
    if (webhookAge !== null && webhookAge > 3600) { // Older than 1 hour
      recommendations.push(`⚠️  Last webhook received ${tradingViewTelemetry.formatTelemetryAge()}. Check TradingView alert configuration.`);
    }
    
    res.json({
      success: true,
      connection: {
        serverHealth: healthResponse,
        ngrokDetectedUrl,
        expectedPublicUrl,
        webhookEndpoint,
        urlMatch: !expectedPublicUrl || !ngrokDetectedUrl || expectedPublicUrl === ngrokDetectedUrl,
        lastWebhook: lastTelemetry ? {
          receivedAt: lastTelemetry.receivedAt,
          ageSeconds: webhookAge,
          ageFormatted: tradingViewTelemetry.formatTelemetryAge(),
          symbol: lastTelemetry.symbol,
          action: lastTelemetry.action
        } : null,
        recommendations
      }
    });
  } catch (error) {
    console.error('❌ Error getting connection status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== WHALE DETECTION API ENDPOINTS =====

// Get all active whale signals
app.get('/api/whales/signals', async (req, res) => {
  try {
    const whaleDetectionAgent = require('./backend/services/whaleDetectionAgent');
    const signals = whaleDetectionAgent.getAllWhaleSignals();
    res.json({ success: true, signals, count: signals.length });
  } catch (error) {
    console.error('❌ Error getting whale signals:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get whale signal for specific symbol
app.get('/api/whales/signals/:symbol', async (req, res) => {
  try {
    const whaleDetectionAgent = require('./backend/services/whaleDetectionAgent');
    const signal = whaleDetectionAgent.getWhaleSignal(req.params.symbol);
    res.json({ success: true, symbol: req.params.symbol, signal });
  } catch (error) {
    console.error('❌ Error getting whale signal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get whale detection statistics
app.get('/api/whales/stats', async (req, res) => {
  try {
    const whaleDetectionAgent = require('./backend/services/whaleDetectionAgent');
    const stats = whaleDetectionAgent.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('❌ Error getting whale stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get opening patterns for specific timeframe
app.get('/api/patterns/opening/:timeframe', (req, res) => {
    try {
        const timeframe = req.params.timeframe; // 5min or 15min
        
        const patterns = Array.from(patternRecognitionService.patterns.values())
            .filter(p => 
                (p.patternType.includes('opening') || p.patternType.includes('gap')) &&
                p.timeframe === timeframe
            )
            .sort((a, b) => b.winRate - a.winRate);
        
        res.json({
            success: true,
            timeframe: timeframe,
            patterns: patterns,
            count: patterns.length
        });
    } catch (error) {
        console.error('❌ Error getting opening patterns:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Match current market to patterns
app.post('/api/patterns/match', async (req, res) => {
    try {
        const { symbol, marketData, timeframe = '5min' } = req.body;
        
        if (!symbol || !marketData) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: symbol, marketData'
            });
        }
        
        // Detect patterns
        const detectedPatterns = await patternRecognitionService.detectPatterns(
            symbol,
            marketData,
            timeframe
        );
        
        // Get predictions from learning agents
        const predictions = await patternLearningAgents.getPredictions(
            symbol,
            marketData,
            timeframe
        );
        
        res.json({
            success: true,
            detectedPatterns: detectedPatterns,
            agentPredictions: predictions,
            count: detectedPatterns.length + predictions.length
        });
    } catch (error) {
        console.error('❌ Error matching patterns:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Manual sync to Google Drive
app.post('/api/patterns/sync', async (req, res) => {
    try {
        const googleDriveStorage = require('./backend/services/googleDrivePatternStorage');
        
        if (!googleDriveStorage.enabled) {
            return res.status(400).json({
                success: false,
                error: 'Google Drive sync is not enabled'
            });
        }
        
        const patterns = Array.from(patternRecognitionService.patterns.values());
        const result = await googleDriveStorage.syncToDrive(patterns);
        
        res.json({
            success: result.success,
            ...result
        });
    } catch (error) {
        console.error('❌ Error syncing patterns:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== LEARNING DAEMON API ENDPOINTS =====

// Learning health check
app.get('/learn/health', async (req, res) => {
    try {
        const daemon = new learningDaemon();
        const status = daemon.getStatus();
        const engineStats = patternLearningEngine.getStats();
        
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            daemon: {
                enabled: status.enabled,
                isRunning: status.isRunning,
                lastRun: status.lastRun
            },
            engine: {
                enabled: engineStats.enabled,
                totalPatterns: engineStats.totalPatterns,
                lastRun: engineStats.lastRun
            },
            googleDrive: {
                enabled: process.env.ENABLE_GOOGLE_DRIVE_SYNC === 'true'
            }
        };

        res.json(health);
    } catch (error) {
        console.error('❌ Error getting learning health:', error.message);
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

// Learning status (detailed)
app.get('/learn/status', async (req, res) => {
    try {
        const fs = require('fs').promises;
        const path = require('path');
        const daemon = new learningDaemon();
        const status = await daemon.getStatus(); // Now async
        const engineStats = patternLearningEngine.getStats();
        const googleDriveStorage = require('./backend/services/googleDrivePatternStorage');
        const universeLoader = require('./backend/services/universeLoader');
        
        // Read heartbeat file for accurate daemon status
        const heartbeatPath = path.join(__dirname, 'data/learning/heartbeat.json');
        let heartbeat = null;
        let daemonPid = null;
        let daemonStartedAt = null;
        let lastCycleAt = null;
        let isRunning = false;
        
        try {
            const heartbeatContent = await fs.readFile(heartbeatPath, 'utf8');
            heartbeat = JSON.parse(heartbeatContent);
            daemonPid = heartbeat.pid;
            daemonStartedAt = heartbeat.startedAt;
            lastCycleAt = heartbeat.lastCycleAt;
            
            // Check if PID is actually running using process.kill(pid, 0)
            if (daemonPid) {
                try {
                    process.kill(daemonPid, 0); // Signal 0 checks if process exists
                    isRunning = true;
                } catch (e) {
                    // Process not running (ESRCH = no such process)
                    isRunning = false;
                }
            }
        } catch (e) {
            // Heartbeat file doesn't exist - try PID file as fallback
            const pidFile = path.join(__dirname, 'data/pids/learning.pid');
            try {
                const pidContent = await fs.readFile(pidFile, 'utf8');
                daemonPid = parseInt(pidContent.trim(), 10);
                if (daemonPid) {
                    try {
                        process.kill(daemonPid, 0); // Signal 0 checks if process exists
                        isRunning = true;
                    } catch (e) {
                        // Process not running
                        isRunning = false;
                    }
                }
            } catch (e2) {
                // Neither heartbeat nor PID file exists
            }
        }
        
        // Use heartbeat data if available
        if (heartbeat) {
            lastCycleAt = heartbeat.lastCycleAt;
            if (heartbeat.lastError) {
                status.lastError = heartbeat.lastError;
            }
        }
        
        // Count errors from engine stats or heartbeat
        let errorCount = 0;
        if (heartbeat && heartbeat.errorCount !== undefined) {
            errorCount = heartbeat.errorCount;
        } else if (engineStats.errors && Array.isArray(engineStats.errors)) {
            errorCount = engineStats.errors.length;
        }
        
        // Load universe info
        let universeInfo = { symbolsCount: 0, timeframesCount: 0, pairsCount: 0 };
        try {
            await universeLoader.load();
            const pairs = universeLoader.getSymbolTimeframePairs();
            const symbols = new Set(pairs.map(p => p.symbol));
            const timeframes = new Set(pairs.map(p => p.timeframe));
            universeInfo = {
                symbolsCount: symbols.size,
                timeframesCount: timeframes.size,
                pairsCount: pairs.length
            };
        } catch (e) {
            // Universe not loaded
        }
        
        // Determine storage info
        const driveEnabled = process.env.ENABLE_GOOGLE_DRIVE_SYNC === 'true';
        const hasCredentials = !!(
            process.env.GOOGLE_DRIVE_CLIENT_ID &&
            process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
            process.env.GOOGLE_DRIVE_REFRESH_TOKEN
        );
        
        let storageMode = 'LOCAL_ONLY';
        let driveReason = null;
        
        if (driveEnabled && hasCredentials) {
            if (googleDriveStorage.drive !== null) {
                storageMode = 'GOOGLE_DRIVE_PRIMARY';
            } else {
                storageMode = 'LOCAL_ONLY';
                driveReason = 'Drive credentials configured but not connected (check initialization)';
            }
        } else if (driveEnabled && !hasCredentials) {
            storageMode = 'LOCAL_ONLY';
            driveReason = 'ENABLE_GOOGLE_DRIVE_SYNC=true but missing credentials (GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN)';
        } else {
            storageMode = 'LOCAL_ONLY';
            driveReason = 'ENABLE_GOOGLE_DRIVE_SYNC not set to true';
        }
        
        // Get pattern source
        let patternSource = 'local';
        if (storageMode === 'GOOGLE_DRIVE_PRIMARY') {
            patternSource = 'drive';
        }
        
        // Get last saved timestamp
        let lastSavedAt = null;
        if (googleDriveStorage.lastSyncAt) {
            lastSavedAt = googleDriveStorage.lastSyncAt;
        } else {
            // Try to get from pattern file mtime
            try {
                const patternFile = path.join(__dirname, 'data/patterns.json');
                const stats = await fs.stat(patternFile);
                lastSavedAt = stats.mtime.toISOString();
            } catch (e) {
                // File doesn't exist
            }
        }
        
        const detailedStatus = {
            timestamp: new Date().toISOString(),
            daemon: {
                running: isRunning, // Use PID liveness check result (authoritative)
                pid: daemonPid,
                startedAt: daemonStartedAt || heartbeat?.startedAt,
                lastCycleAt: lastCycleAt || heartbeat?.lastCycleAt || status.lastRun,
                errorCount: errorCount,
                lastError: heartbeat?.lastError || status.lastError,
                enabled: status.enabled,
                intervalMinutes: status.intervalMinutes,
                concurrency: status.concurrency,
                queueDepth: status.queueDepth,
                processing: status.processing,
                heartbeat: heartbeat ? {
                    candlesProcessed: heartbeat.candlesProcessed,
                    patternsFound: heartbeat.patternsFound,
                    patternsTotal: heartbeat.patternsTotal,
                    patternsExtracted: heartbeat.patternsExtracted,
                    patternsDeduped: heartbeat.patternsDeduped,
                    storageMode: heartbeat.storageMode,
                    googleDriveEnabled: heartbeat.googleDriveEnabled,
                    errorCount: heartbeat.errorCount,
                    lastError: heartbeat.lastError,
                    timestamp: heartbeat.timestamp
                } : null
            },
            patterns: {
                total: engineStats.totalPatterns || patternRecognitionService.patterns.size,
                lastSavedAt: lastSavedAt,
                source: patternSource
            },
            storage: {
                googleDriveEnabled: storageMode === 'GOOGLE_DRIVE_PRIMARY',
                driveFolder: googleDriveStorage.folderId || null,
                cachePath: path.join(__dirname, 'data/patterns.json'),
                mode: storageMode,
                reason: driveReason
            },
            universe: universeInfo,
            engine: {
                enabled: engineStats.enabled !== false,
                patternsExtracted: engineStats.patternsExtracted || 0,
                patternsDeduped: engineStats.patternsDeduped || 0,
                symbolsProcessed: engineStats.symbolsProcessed || 0,
                lastRun: engineStats.lastRun
            },
            errors: (engineStats.errors || []).slice(-5) // Last 5 errors
        };

        res.json(detailedStatus);
    } catch (error) {
        console.error('❌ Error getting learning status:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Storage status endpoint
app.get('/learn/storage/status', async (req, res) => {
    try {
        const googleDriveStorage = require('./backend/services/googleDrivePatternStorage');
        const status = googleDriveStorage.getStatus();
        
        res.json({
            timestamp: new Date().toISOString(),
            ...status
        });
    } catch (error) {
        console.error('❌ Error getting storage status:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Backfill status endpoint
app.get('/learn/backfill/status', async (req, res) => {
    try {
        const fs = require('fs').promises;
        const path = require('path');
        const checkpointDir = path.join(__dirname, 'data/checkpoints');
        
        // Read checkpoint files to determine backfill progress
        let checkpoints = {};
        try {
            const files = await fs.readdir(checkpointDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const checkpointPath = path.join(checkpointDir, file);
                    const content = await fs.readFile(checkpointPath, 'utf8');
                    const checkpoint = JSON.parse(content);
                    const key = file.replace('.json', '');
                    checkpoints[key] = {
                        lastProcessed: checkpoint.lastProcessed || null,
                        lastCandleTime: checkpoint.lastCandleTime || null,
                        totalProcessed: checkpoint.totalProcessed || 0
                    };
                }
            }
        } catch (e) {
            // Checkpoint directory doesn't exist or empty
        }
        
        res.json({
            timestamp: new Date().toISOString(),
            checkpoints: checkpoints,
            totalCheckpoints: Object.keys(checkpoints).length
        });
    } catch (error) {
        console.error('❌ Error getting backfill status:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Latest metrics snapshot
app.get('/learn/metrics/latest', async (req, res) => {
    try {
        const fs = require('fs').promises;
        const path = require('path');
        const metricsDir = path.join(__dirname, 'data/metrics');

        // Find latest metrics file
        let files = [];
        try {
            files = await fs.readdir(metricsDir);
        } catch (error) {
            return res.status(404).json({
                success: false,
                error: 'No metrics found'
            });
        }

        const metricsFiles = files
            .filter(f => f.startsWith('metrics_') && f.endsWith('.json'))
            .sort()
            .reverse();

        if (metricsFiles.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No metrics files found'
            });
        }

        const latestFile = path.join(metricsDir, metricsFiles[0]);
        const data = await fs.readFile(latestFile, 'utf8');
        const metrics = JSON.parse(data);

        res.json({
            success: true,
            file: metricsFiles[0],
            metrics: metrics
        });
    } catch (error) {
        console.error('❌ Error getting latest metrics:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Serve dashboard HTML
app.get('/trading_dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'trading_dashboard.html'));
});

// Serve trading system monitor
app.get('/monitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'trading_system_monitor.html'));
});

// ===== TRADINGVIEW SYNC API =====

// Export trades for TradingView
app.get('/api/tradingview/export', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const filePath = await tradingViewSync.exportTrades(format);
    
    if (filePath) {
      res.download(filePath, path.basename(filePath));
    } else {
      res.status(500).json({ success: false, error: 'Export failed' });
    }
  } catch (error) {
    console.error('❌ Error exporting trades:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get trades for TradingView webhook
app.get('/api/tradingview/trades', async (req, res) => {
  try {
    const since = req.query.since || null;
    const trades = await tradingViewSync.getTradesForWebhook(since);
    
    res.json({
      success: true,
      trades: trades.map(t => tradingViewSync.formatTradeForDisplay(t)),
      count: trades.length
    });
  } catch (error) {
    console.error('❌ Error getting trades:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'TradingView Webhook Server',
        version: '1.0.0',
        endpoints: {
            webhook: `http://localhost:${port}/webhook/tradingview`,
            health: `http://localhost:${port}/health`,
            dashboard: `http://localhost:${port}/trading_dashboard.html`,
            account: `http://localhost:${port}/api/account`,
            learning: `http://localhost:${port}/api/learning`
        }
    });
});

// Start server
app.listen(port, async () => {
    // ===== Boot guard: prevent double initialization =====
    if (global.__NP_TRADING_BOOTED && !global.__NP_TRADING_BOOT_RAN) {
        global.__NP_TRADING_BOOT_RAN = true;

        // Initialize services (idempotent guards in each service prevent double init)

        // Fast-fail check for Google Drive if enabled
        if (process.env.ENABLE_GOOGLE_DRIVE_SYNC === 'true') {
        const googleDriveStorage = require('./backend/services/googleDrivePatternStorage');
        try {
            // If enabled but not initialized, try to initialize
            if (!googleDriveStorage.connected && googleDriveStorage.enabled) {
                await googleDriveStorage.initialize();
            }
            if (googleDriveStorage.enabled && !googleDriveStorage.connected) {
                console.error(`❌ FATAL: Google Drive enabled but not connected. Check credentials.`);
                console.error(`   Error: ${googleDriveStorage.lastError || 'Unknown error'}`);
                process.exit(1);
            }
        } catch (error) {
            console.error(`❌ FATAL: Google Drive initialization failed: ${error.message}`);
            process.exit(1);
        }
    }
    console.log(`🎯 Secure TradingView Webhook Server started on port ${port}`);
    console.log(`📡 TradingView webhook URL: http://localhost:${port}/webhook/tradingview`);
    console.log(`🏥 Health check: http://localhost:${port}/health`);
    console.log(`💰 Account: http://localhost:${port}/api/account`);
    console.log(`🧠 Learning: http://localhost:${port}/api/learning`);
    console.log(`📊 Dashboard: http://localhost:${port}/trading_dashboard.html`);
    console.log(`🔬 Learning Health: http://localhost:${port}/learn/health`);
    console.log(`📈 Learning Status: http://localhost:${port}/learn/status`);
    console.log(`🎯 Indicators API: http://localhost:${port}/api/indicators`);
    console.log(`📊 Indicator Stats: http://localhost:${port}/api/indicators/stats`);
    console.log(`✅ Ready to receive TradingView alerts!`);
    
    // Initialize broker adapter
    try {
        const brokerAdapter = getBrokerAdapter();
        console.log(`📊 Broker: ${brokerAdapter.getName()} (${process.env.BROKER || 'paper'})`);
        console.log(`📊 Broker Status: ${brokerAdapter.isEnabled() ? 'ENABLED' : 'DISABLED'}`);
        
        if (brokerAdapter.isEnabled()) {
            const connected = await brokerAdapter.connect();
            console.log(`📊 Broker Connection: ${connected ? 'CONNECTED' : 'NOT CONNECTED'}`);
        }
    } catch (error) {
        console.error(`❌ Broker adapter initialization error: ${error.message}`);
    }
    
    // Initialize paper trading state (rebuild from ledger if enabled)
    try {
        await paperTradingService.initializeState();
        console.log(`✅ Paper trading state initialized`);
    } catch (error) {
        console.error(`❌ Paper trading state initialization failed: ${error.message}`);
    }
    
    console.log(`📊 Paper Trading: ${process.env.ENABLE_PAPER_TRADING !== 'false' ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🧠 Learning: ${tradingLearningService.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🎯 Indicator Generation: ${indicatorGenerator.enabled ? 'ENABLED' : 'DISABLED'} (${indicatorGenerator.tradingStyle})`);
    console.log(`🤖 Automated Trading: ${automatedScalpingTrader.enabled ? 'ENABLED' : 'DISABLED'}`);
    // Initialize whale detection agent
    const whaleDetectionAgent = require('./backend/services/whaleDetectionAgent');
    if (whaleDetectionAgent.enabled) {
        try {
            await whaleDetectionAgent.initialize();
            console.log(`🐋 Whale Detection: ENABLED`);
            console.log(`   Volume spike threshold: ${whaleDetectionAgent.config.volumeSpikeThreshold}x`);
        } catch (error) {
            console.warn(`⚠️  Whale detection initialization failed: ${error.message}`);
        }
    } else {
        console.log(`🐋 Whale Detection: DISABLED`);
    }
    
    if (process.env.ENABLE_PAPER_TRADING !== 'false' && tradingLearningService.enabled) {
        console.log(`🚀 System will automatically execute trades and learn from outcomes!`);
    }
    
    // Initialize indicator generator
    if (indicatorGenerator.enabled) {
        try {
            await indicatorGenerator.initialize();
            console.log(`✅ Indicator generator initialized (${indicatorGenerator.indicators.size} indicators)`);
        } catch (error) {
            console.warn(`⚠️  Indicator generator initialization failed: ${error.message}`);
        }
    }
    
    // Start automated trading (if enabled)
    if (automatedScalpingTrader.enabled) {
        try {
            await automatedScalpingTrader.start();
            console.log(`✅ Automated scalping trader started`);
            console.log(`   Target Accuracy: ${(automatedScalpingTrader.config.targetAccuracy * 100).toFixed(1)}%`);
        } catch (error) {
            console.warn(`⚠️  Automated trading start failed: ${error.message}`);
        }
    }
    
    // Ensure patterns are loaded
    try {
        await patternRecognitionService.loadPatterns();
        console.log(`📊 Pattern Recognition: Loaded ${patternRecognitionService.patterns.size} patterns`);
    } catch (error) {
        console.warn(`⚠️  Pattern loading failed: ${error.message}`);
    }
    } // End of boot guard wrapper
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down webhook server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down...');
    process.exit(0);
});