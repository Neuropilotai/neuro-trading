/**
 * Express Application Factory
 * Creates and configures Express app with all middleware and routes
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { config } = require('../config');

// Import middleware and services
const { webhookAuth } = require('../middleware/webhookAuth');
const { webhookValidation } = require('../middleware/webhookValidation');
const { riskCheck } = require('../middleware/riskCheck');
const deduplicationService = require('../services/deduplicationService');
const riskEngine = require('../services/riskEngine');
// NOTE:
// Avoid requiring tradeLedger at module top-level if you want to be extra safe
// (in case some entrypoint loads createApp before env bootstrap).
// We'll lazy-load it inside createApp() where env is guaranteed ready.
let tradeLedger = null;
const paperTradingService = require('../services/paperTradingService');
const { getBrokerAdapter } = require('../adapters/brokerAdapterFactory');

/**
 * Create Express application
 * @returns {express.Application} - Configured Express app
 */
function createApp() {
  // Lazy-load tradeLedger to ensure env bootstrap has run
  if (!tradeLedger) {
    tradeLedger = require('../db/tradeLedger');
  }
  
  const app = express();
  
  // ===== MIDDLEWARE ORDER IS CRITICAL =====
  // express.json() MUST be mounted before routes to capture raw body Buffer
  // for byte-exact HMAC verification in webhookAuth middleware.
  // DO NOT add duplicate express.json() parsers in routes or sub-routers.
  // Store raw body for HMAC verification (byte-exact Buffer)
  app.use(express.json({
    verify: (req, res, buf) => {
      if (buf && buf.length) {
        // CRITICAL: Store Buffer for byte-exact HMAC verification
        req.rawBodyBuffer = buf;
        // Also store string for fallback/debug (but HMAC MUST use Buffer)
        req.rawBody = buf.toString('utf8');
      }
    },
    limit: `${config.webhookMaxBodySize}b`, // Request size limit
  }));
  app.use(express.urlencoded({ extended: true, limit: `${config.webhookMaxBodySize}b` }));
  
  // CORS configuration
  app.use((req, res, next) => {
    const origin = config.corsOrigin === '*' ? '*' : config.corsOrigin;
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-TradingView-Signature');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
    } else {
      next();
    }
  });
  
  // Serve static files (dashboard HTML)
  app.use(express.static(__dirname + '/../../', {
    extensions: ['html'],
    index: false
  }));
  
  // Rate limiting
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: config.webhookRateLimit,
    message: { error: 'Too many requests', message: `Rate limit exceeded. Max ${config.webhookRateLimit} requests per minute.` },
    standardHeaders: true,
    legacyHeaders: false,
  });
  
  // Register routes
  registerRoutes(app, limiter);
  
  return app;
}

/**
 * Register all application routes
 * @param {express.Application} app - Express app
 * @param {express.RateLimit} limiter - Rate limiter middleware
 */
function registerRoutes(app, limiter) {
  // Symbol cooldown guard (anti-double-execution)
  const symbolCooldown = new Map(); // symbol -> lastExecMs
  const COOLDOWN_MS = config.symbolCooldownMs;
  const GUARD_ORDER = config.guardOrder.toLowerCase();
  const GUARD_ORDER_COOLDOWN_FIRST = GUARD_ORDER === 'cooldown_first';
  
  // Optional services (only used if available)
  let tradingLearningService = null;
  let patternRecognitionService = null;
  let patternLearningAgents = null;
  let patternLearningEngine = null;
  let learningDaemon = null;
  let indicatorGenerator = null;
  let dailyPatternTracker = null;
  let automatedScalpingTrader = null;
  let tradingViewSync = null;
  let tradingViewTelemetry = null;
  let symbolRouter = null;
  let whaleDetectionAgent = null;
  let googleDrivePatternStorage = null;
  let universeLoader = null;
  
  try { tradingLearningService = require('../services/tradingLearningService'); } catch (e) {}
  try { patternRecognitionService = require('../services/patternRecognitionService'); } catch (e) {}
  try { patternLearningAgents = require('../services/patternLearningAgents'); } catch (e) {}
  try { patternLearningEngine = require('../services/patternLearningEngine'); } catch (e) {}
  try { learningDaemon = require('../services/learningDaemon'); } catch (e) {}
  try { indicatorGenerator = require('../services/indicatorGenerator'); } catch (e) {}
  try { dailyPatternTracker = require('../services/dailyPatternTracker'); } catch (e) {}
  try { automatedScalpingTrader = require('../services/automatedScalpingTrader'); } catch (e) {}
  try { tradingViewSync = require('../services/tradingViewSync'); } catch (e) {}
  try { tradingViewTelemetry = require('../services/tradingViewTelemetry'); } catch (e) {}
  try { symbolRouter = require('../services/symbolRouter'); } catch (e) {}
  try { whaleDetectionAgent = require('../services/whaleDetectionAgent'); } catch (e) {}
  try { googleDrivePatternStorage = require('../services/googleDrivePatternStorage'); } catch (e) {}
  try { universeLoader = require('../services/universeLoader'); } catch (e) {}
  
  // Main webhook endpoint
  app.post('/webhook/tradingview',
    limiter,
    webhookAuth,
    webhookValidation,
    async (req, res, next) => {
      try {
        const dedupeResult = await deduplicationService.checkDuplicate(req.body);
        
        if (dedupeResult.isDuplicate) {
          try {
            if (tradingViewTelemetry) await tradingViewTelemetry.recordWebhook({
              remoteIp: req.ip || req.connection?.remoteAddress,
              userAgent: req.get('user-agent'),
              authModeUsed: req.authModeUsed || 'unknown',
              result: '409',
              httpStatus: 409,
              alertId: req.body.alert_id,
              symbol: req.body.symbol,
              action: req.body.action,
              idempotencyOutcome: 'duplicate'
            });
          } catch (telemetryError) {
            console.warn('⚠️  Failed to record duplicate telemetry:', telemetryError.message);
          }
          
          return res.status(409).json({
            error: 'Duplicate alert',
            message: `Alert with idempotency key ${dedupeResult.idempotencyKey} already processed`,
            idempotencyKey: dedupeResult.idempotencyKey
          });
        }
        
        req.idempotencyKey = dedupeResult.idempotencyKey;
        req.idempotencyOutcome = 'new';
        next();
      } catch (error) {
        console.error('❌ Deduplication error:', error);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
      }
    },
    riskCheck,
    require('./webhookHandler')({
      symbolCooldown,
      COOLDOWN_MS,
      GUARD_ORDER_COOLDOWN_FIRST,
      tradingLearningService,
      patternRecognitionService,
      indicatorGenerator,
      tradingViewTelemetry,
      symbolRouter,
      automatedScalpingTrader,
    })
  );
  
  // Test GET endpoint
  app.get('/webhook/tradingview', (req, res) => {
    res.json({
      status: 'active',
      message: 'TradingView webhook endpoint is ready',
      method: 'Use POST requests to send alerts',
      url: `http://localhost:${config.port}/webhook/tradingview`
    });
  });
  
  // Health check
  app.get('/health', async (req, res) => {
    const riskStats = riskEngine.getStats();
    const dedupeStats = deduplicationService.getStats();
    const learningMetrics = tradingLearningService ? tradingLearningService.getMetrics() : { enabled: false };
    
    let accountSummary = null;
    let brokerHealth = null;
    try {
      const brokerAdapter = getBrokerAdapter();
      accountSummary = await brokerAdapter.getAccountSummary();
      brokerHealth = await brokerAdapter.healthCheck();
    } catch (error) {
      console.error('❌ Error getting broker adapter:', error.message);
      accountSummary = paperTradingService.getAccountSummary();
      brokerHealth = { connected: false, error: error.message };
    }
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      port: config.port,
      features: {
        auth: config.enableWebhookAuth,
        validation: config.enableWebhookValidation,
        deduplication: dedupeStats.enabled,
        riskEngine: riskStats.enabled,
        tradeLedger: config.enableTradeLedger,
        paperTrading: config.enablePaperTrading,
        learning: tradingLearningService ? tradingLearningService.enabled : false
      },
      broker: {
        type: config.brokerType,
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
      const accountSummary = paperTradingService.getAccountSummary();
      res.json(accountSummary);
    }
  });
  
  // Root endpoint
  app.get('/', (req, res) => {
    res.json({
      name: 'TradingView Webhook Server',
      version: '1.0.0',
      endpoints: {
        webhook: `http://localhost:${config.port}/webhook/tradingview`,
        health: `http://localhost:${config.port}/health`,
        dashboard: `http://localhost:${config.port}/trading_dashboard.html`,
        account: `http://localhost:${config.port}/api/account`,
        learning: `http://localhost:${config.port}/api/learning`
      }
    });
  });
  
  // Register additional routes (dev endpoints, dashboard, etc.)
  // These are kept in the main file for now to avoid breaking changes
  // Can be extracted later if needed
  registerAdditionalRoutes(app, {
    deduplicationService,
    riskEngine,
    tradeLedger,
    paperTradingService,
    getBrokerAdapter,
    tradingLearningService,
    patternRecognitionService,
    indicatorGenerator,
    dailyPatternTracker,
    automatedScalpingTrader,
    tradingViewSync,
    tradingViewTelemetry,
    symbolRouter,
    whaleDetectionAgent,
    googleDrivePatternStorage,
    universeLoader,
    learningDaemon,
    patternLearningEngine,
    patternLearningAgents,
  });
}

/**
 * Register additional routes (dashboard, dev endpoints, etc.)
 * This function will be populated by extracting routes from simple_webhook_server.js
 * For now, it's a placeholder to maintain compatibility
 */
function registerAdditionalRoutes(app, services) {
  // Placeholder - routes will be extracted from simple_webhook_server.js
  // This maintains backward compatibility while allowing gradual refactoring
}

module.exports = { createApp };

