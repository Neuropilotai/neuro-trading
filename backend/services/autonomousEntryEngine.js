'use strict';

const fs = require('fs').promises;
const path = require('path');
const priceFeedService = require('./priceFeedService');
const autonomousSetupEngine = require('./autonomousSetupEngine');
const autonomousScoring = require('./autonomousCandidateScoringService');
const autonomousCoordinator = require('./autonomousExecutionCoordinator');
const autonomousExitManager = require('./autonomousExitManager');

const AUTONOMOUS_ENTRY_ENGINE_VERSION = 1;

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}
function getStatusPath() {
  return path.join(getDataDir(), 'autonomous_entry_engine_status.json');
}
function getPriceStatePath() {
  return path.join(getDataDir(), 'autonomous_price_state.json');
}

function parseSymbols() {
  return String(process.env.AUTO_ENTRY_SYMBOLS || 'XAUUSD,EURUSD')
    .split(',')
    .map((s) => String(s || '').toUpperCase().trim())
    .filter(Boolean);
}

function isEnabled() {
  return String(process.env.ENABLE_AUTONOMOUS_ENTRY_ENGINE || 'false').toLowerCase() === 'true';
}

class AutonomousEntryEngine {
  constructor() {
    this.version = AUTONOMOUS_ENTRY_ENGINE_VERSION;
    this.enabled = isEnabled();
    this.running = false;
    this.symbols = parseSymbols();
    this.scanIntervalSeconds = parseInt(process.env.AUTO_ENTRY_SCAN_INTERVAL_SECONDS || '60', 10);
    this.exitIntervalSeconds = parseInt(process.env.AUTO_EXIT_SCAN_INTERVAL_SECONDS || '30', 10);
    this.priceState = { pricesBySymbol: {}, spreadProxyBySymbol: {} };
    this.timers = { scan: null, exit: null };
    this.status = {
      autonomousEntryEngineVersion: this.version,
      enabled: this.enabled,
      running: false,
      lastScanAt: null,
      lastExitCheckAt: null,
      lastExecutionAt: null,
      symbols: this.symbols,
      scanIntervalSeconds: this.scanIntervalSeconds,
      exitIntervalSeconds: this.exitIntervalSeconds,
      candidatesSeen: 0,
      candidatesAccepted: 0,
      candidatesRejected: 0,
      entriesExecuted: 0,
      exitsExecuted: 0,
      lastError: null,
      warnings: [],
      metrics: {},
    };
  }

  async loadPriceState() {
    try {
      const raw = await fs.readFile(getPriceStatePath(), 'utf8');
      const o = JSON.parse(raw);
      this.priceState = o && typeof o === 'object' ? o : this.priceState;
    } catch (e) {
      if (e.code !== 'ENOENT') this.status.warnings.push(`load_price_state:${e.message}`);
    }
  }

  async savePriceState() {
    try {
      const p = getPriceStatePath();
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(this.priceState, null, 2), 'utf8');
    } catch (e) {
      this.status.warnings.push(`save_price_state:${e.message}`);
    }
  }

  async saveStatus() {
    try {
      const p = getStatusPath();
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(this.status, null, 2), 'utf8');
      return true;
    } catch (e) {
      this.status.lastError = e.message;
      return false;
    }
  }

  async loadStatus() {
    try {
      const raw = await fs.readFile(getStatusPath(), 'utf8');
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        this.status = { ...this.status, ...o };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') this.status.warnings.push(`load_status:${e.message}`);
    }
  }

  _pushPrice(symbol, price, spreadProxy = 0) {
    const s = String(symbol || '').toUpperCase();
    if (!s || !(Number(price) > 0)) return;
    if (!Array.isArray(this.priceState.pricesBySymbol[s])) this.priceState.pricesBySymbol[s] = [];
    const arr = this.priceState.pricesBySymbol[s];
    arr.push(Number(price));
    const maxLen = 120;
    if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
    this.priceState.spreadProxyBySymbol[s] = Number(spreadProxy) || this.priceState.spreadProxyBySymbol[s] || 0;
  }

  async refreshMarketState() {
    for (const sym of this.symbols) {
      let q;
      try {
        q = await priceFeedService.ensureFreshQuote(sym);
      } catch (e) {
        q = priceFeedService.getQuoteSync(sym);
      }
      const px = Number(q?.price);
      if (px > 0) {
        const spreadProxy = Number.isFinite(Number(q?.latencyMs))
          ? Math.min(0.01, Number(q.latencyMs) / 100000)
          : 0.0005;
        this._pushPrice(sym, px, spreadProxy);
      }
    }
    await this.savePriceState();
  }

  buildStatusSnapshot() {
    return { ...this.status, enabled: this.enabled, running: this.running, symbols: this.symbols };
  }

  getStatus() {
    return this.buildStatusSnapshot();
  }

  async runScanCycle() {
    const at = new Date().toISOString();
    try {
      await this.refreshMarketState();
      const rawCandidates = autonomousSetupEngine.detectAutonomousCandidates({
        symbols: this.symbols,
        state: this.priceState,
      });
      const scored = rawCandidates.map((c) => autonomousScoring.scoreAutonomousCandidate(c));
      const cycle = await autonomousCoordinator.runAutonomousEntryCycle({
        candidates: rawCandidates,
        scoredCandidates: scored,
      });
      this.status.lastScanAt = at;
      this.status.candidatesSeen += cycle.candidatesSeen || 0;
      this.status.candidatesAccepted += cycle.candidatesAccepted || 0;
      this.status.candidatesRejected += cycle.candidatesRejected || 0;
      this.status.entriesExecuted += cycle.entriesExecuted || 0;
      if ((cycle.entriesExecuted || 0) > 0) this.status.lastExecutionAt = at;
      this.status.metrics.lastScan = {
        candidatesSeen: cycle.candidatesSeen,
        entriesExecuted: cycle.entriesExecuted,
      };
      await this.saveStatus();
      return cycle;
    } catch (e) {
      this.status.lastScanAt = at;
      this.status.lastError = e.message;
      await this.saveStatus();
      return { ok: false, error: e.message };
    }
  }

  async runExitCycle() {
    const at = new Date().toISOString();
    try {
      await this.refreshMarketState();
      const cycle = await autonomousExitManager.runAutonomousExitCycle();
      this.status.lastExitCheckAt = at;
      this.status.exitsExecuted += cycle.exitsExecuted || 0;
      this.status.metrics.lastExit = {
        openAutonomousPositions: cycle.openAutonomousPositions,
        exitsExecuted: cycle.exitsExecuted,
      };
      await this.saveStatus();
      return cycle;
    } catch (e) {
      this.status.lastExitCheckAt = at;
      this.status.lastError = e.message;
      await this.saveStatus();
      return { ok: false, error: e.message };
    }
  }

  async start() {
    this.enabled = isEnabled();
    if (!this.enabled) {
      this.running = false;
      this.status.enabled = false;
      this.status.running = false;
      await this.saveStatus();
      return this.getStatus();
    }
    if (this.running) return this.getStatus();
    await this.loadStatus();
    await this.loadPriceState();
    this.running = true;
    this.status.enabled = true;
    this.status.running = true;
    this.timers.scan = setInterval(() => {
      this.runScanCycle().catch((e) => {
        this.status.lastError = e.message;
      });
    }, Math.max(5, this.scanIntervalSeconds) * 1000);
    this.timers.exit = setInterval(() => {
      this.runExitCycle().catch((e) => {
        this.status.lastError = e.message;
      });
    }, Math.max(5, this.exitIntervalSeconds) * 1000);
    await this.saveStatus();
    return this.getStatus();
  }

  async stop() {
    if (this.timers.scan) clearInterval(this.timers.scan);
    if (this.timers.exit) clearInterval(this.timers.exit);
    this.timers.scan = null;
    this.timers.exit = null;
    this.running = false;
    this.status.running = false;
    await this.saveStatus();
    return this.getStatus();
  }
}

const autonomousEntryEngine = new AutonomousEntryEngine();

module.exports = autonomousEntryEngine;
module.exports.AutonomousEntryEngine = AutonomousEntryEngine;
module.exports.AUTONOMOUS_ENTRY_ENGINE_VERSION = AUTONOMOUS_ENTRY_ENGINE_VERSION;
