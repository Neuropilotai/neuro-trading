'use strict';

const fs = require('fs').promises;
const path = require('path');
const priceFeedService = require('./priceFeedService');
const autonomousSetupEngine = require('./autonomousSetupEngine');
const autonomousScoring = require('./autonomousCandidateScoringService');
const autonomousCoordinator = require('./autonomousExecutionCoordinator');
const autonomousExitManager = require('./autonomousExitManager');

const AUTONOMOUS_ENTRY_ENGINE_VERSION = 2;

/** Minimum interval floors (seconds) — prevents tight loops if env misconfigured. */
const MIN_SCAN_INTERVAL_SECONDS = 15;
const MIN_EXIT_INTERVAL_SECONDS = 10;

const WARNINGS_CAP = 48;

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

function parseStaleQuoteMs() {
  const n = parseInt(process.env.AUTO_ENTRY_STALE_QUOTE_MS || '90000', 10);
  return Number.isFinite(n) && n > 5000 ? n : 90000;
}

function pushWarning(status, msg) {
  if (!status.warnings) status.warnings = [];
  status.warnings.push(`${new Date().toISOString()} ${msg}`);
  if (status.warnings.length > WARNINGS_CAP) {
    status.warnings.splice(0, status.warnings.length - WARNINGS_CAP);
  }
}

function effectiveScanIntervalSeconds(base) {
  return Math.max(MIN_SCAN_INTERVAL_SECONDS, Math.max(5, parseInt(base, 10) || 60));
}

function effectiveExitIntervalSeconds(base) {
  return Math.max(MIN_EXIT_INTERVAL_SECONDS, Math.max(5, parseInt(base, 10) || 30));
}

class AutonomousEntryEngine {
  constructor() {
    this.version = AUTONOMOUS_ENTRY_ENGINE_VERSION;
    this.enabled = isEnabled();
    this.running = false;
    this.symbols = parseSymbols();
    this.scanIntervalSeconds = effectiveScanIntervalSeconds(
      parseInt(process.env.AUTO_ENTRY_SCAN_INTERVAL_SECONDS || '60', 10)
    );
    this.exitIntervalSeconds = effectiveExitIntervalSeconds(
      parseInt(process.env.AUTO_EXIT_SCAN_INTERVAL_SECONDS || '30', 10)
    );
    this.priceState = { pricesBySymbol: {}, spreadProxyBySymbol: {} };
    this.timers = { scan: null, exit: null };
    this._scanRunning = false;
    this._exitRunning = false;
    this._startGeneration = 0;
    this.quoteHealthBySymbol = {};
    this.lastNoCandidateSummary = null;
    this.lastRejectionSummary = null;
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
      paperOnlyEnforced: true,
      liveExecutionBlocked: true,
    };
  }

  async loadPriceState() {
    try {
      const raw = await fs.readFile(getPriceStatePath(), 'utf8');
      const o = JSON.parse(raw);
      this.priceState = o && typeof o === 'object' ? o : this.priceState;
    } catch (e) {
      if (e.code !== 'ENOENT') pushWarning(this.status, `load_price_state:${e.message}`);
    }
  }

  async savePriceState() {
    try {
      const p = getPriceStatePath();
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(this.priceState, null, 2), 'utf8');
    } catch (e) {
      pushWarning(this.status, `save_price_state:${e.message}`);
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
      if (e.code !== 'ENOENT') pushWarning(this.status, `load_status:${e.message}`);
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

  /**
   * Quote health for gating + diagnostics. Fail-soft if timestamps missing.
   */
  _quoteHealth(symbol, q) {
    const sym = String(symbol || '').toUpperCase();
    const px = Number(q?.price);
    const staleMs = parseStaleQuoteMs();
    const unavailable = !(px > 0);
    let ageMs = null;
    let staleQuote = false;
    if (q?.markTimestamp) {
      const t = Date.parse(String(q.markTimestamp));
      if (Number.isFinite(t)) {
        ageMs = Date.now() - t;
        staleQuote = ageMs > staleMs;
      }
    } else if (priceFeedService.isLiveEnabled() && q?.source === 'fallback') {
      staleQuote = true;
    }
    return {
      symbol: sym,
      quoteUnavailable: unavailable,
      staleQuote,
      ageMs,
      source: q?.source || null,
      price: unavailable ? null : px,
    };
  }

  async refreshMarketState() {
    const out = {};
    for (const sym of this.symbols) {
      let q;
      try {
        q = await priceFeedService.ensureFreshQuote(sym);
      } catch (e) {
        q = priceFeedService.getQuoteSync(sym);
      }
      const px = Number(q?.price);
      const spreadProxy = Number.isFinite(Number(q?.latencyMs))
        ? Math.min(0.01, Number(q.latencyMs) / 100000)
        : 0.0005;
      if (px > 0) {
        this._pushPrice(sym, px, spreadProxy);
      }
      const h = this._quoteHealth(sym, q);
      out[sym] = h;
    }
    this.quoteHealthBySymbol = out;
    await this.savePriceState();
    return out;
  }

  buildSafetyChecks() {
    const E = autonomousCoordinator.parseCoordinatorEnv();
    const timersOk = !this.running || (this.timers.scan != null && this.timers.exit != null);
    const intervalsOk =
      this.scanIntervalSeconds >= MIN_SCAN_INTERVAL_SECONDS &&
      this.exitIntervalSeconds >= MIN_EXIT_INTERVAL_SECONDS;
    return {
      paperOnlyOk: autonomousCoordinator.PAPER_ONLY_ENFORCED === true,
      intervalsOk,
      timersOk,
      positionLimitsOk: E.maxPosTotal > 0 && E.maxPosPerSymbol > 0,
      exposureLimitsOk: E.maxNotional > E.minNotional && E.maxExposurePct > 0,
    };
  }

  buildStatusSnapshot() {
    const flags = autonomousSetupEngine.parseEnabledSetupFlags();
    const E = autonomousCoordinator.parseCoordinatorEnv();
    let openAuto = 0;
    try {
      const paperTradingService = require('./paperTradingService');
      openAuto = (paperTradingService.getAutonomousOpenPositions?.() || []).length;
    } catch (e) {
      void e;
    }

    const scanHealthy = this.status.lastError == null || this.status.metrics?.lastScan?.ok !== false;
    const exitHealthy = this.status.lastError == null || this.status.metrics?.lastExit?.ok !== false;

    return {
      ...this.status,
      enabled: this.enabled,
      running: this.running,
      symbols: this.symbols,
      paperOnlyEnforced: true,
      liveExecutionBlocked: true,
      maxPositionsTotal: E.maxPosTotal,
      maxPositionsPerSymbol: E.maxPosPerSymbol,
      cooldownSeconds: E.symbolCooldownSec,
      strategySymbolCooldownSeconds: E.strategySymbolCooldownSec,
      entriesPerSymbolPerHourLimit: E.maxEntriesPerSymbolPerHour,
      detectorEnabled: { ...flags },
      currentOpenAutonomousPositions: openAuto,
      scanHealthy,
      exitHealthy,
      lastNoCandidateSummary: this.lastNoCandidateSummary,
      lastRejectionSummary: this.lastRejectionSummary,
      safetyChecks: this.buildSafetyChecks(),
      minScanIntervalFloorSeconds: MIN_SCAN_INTERVAL_SECONDS,
      minExitIntervalFloorSeconds: MIN_EXIT_INTERVAL_SECONDS,
    };
  }

  getStatus() {
    return this.buildStatusSnapshot();
  }

  async runScanCycle() {
    const at = new Date().toISOString();
    if (this._scanRunning) {
      return { ok: true, skipped: true, reason: 'scan_already_running' };
    }
    this._scanRunning = true;
    try {
      const quoteHealth = await this.refreshMarketState();

      const { candidates: rawCandidates, detectorDiagnostics } =
        autonomousSetupEngine.detectAutonomousCandidatesWithDiagnostics({
          symbols: this.symbols,
          state: this.priceState,
        });

      const marketContextBySymbol = {};
      for (const sym of this.symbols) {
        const h = quoteHealth[sym] || {};
        marketContextBySymbol[sym] = {
          quoteUnavailable: !!h.quoteUnavailable,
          staleQuote: !!h.staleQuote,
          source: h.source || null,
          ageMs: h.ageMs,
        };
      }

      const scored = rawCandidates.map((c) => {
        const sym = String(c.symbol || '').toUpperCase();
        const h = marketContextBySymbol[sym] || {};
        const spreadProxy = Number(this.priceState.spreadProxyBySymbol?.[sym]) || 0;
        return autonomousScoring.scoreAutonomousCandidate(c, {
          spreadProxy,
          quoteUnavailable: h.quoteUnavailable,
          marketStale: h.staleQuote,
        });
      });

      const cycle = await autonomousCoordinator.runAutonomousEntryCycle(
        {
          candidates: rawCandidates,
          scoredCandidates: scored,
          marketContextBySymbol,
        },
        {}
      );

      this.status.lastScanAt = at;
      this.status.candidatesSeen += cycle.candidatesSeen || 0;
      this.status.candidatesAccepted += cycle.candidatesAccepted || 0;
      this.status.candidatesRejected += cycle.candidatesRejected || 0;
      this.status.entriesExecuted += cycle.entriesExecuted || 0;
      if ((cycle.entriesExecuted || 0) > 0) this.status.lastExecutionAt = at;
      this.status.lastError = null;

      const recs = cycle.records || [];
      const lastRej = [...recs].reverse().find((r) => r.finalDecision !== 'allow' || !r.executed);
      if (lastRej && lastRej.rejectionSummary) {
        this.lastRejectionSummary = {
          at,
          primaryRejectionCode: lastRej.primaryRejectionCode,
          rejectionSummary: lastRej.rejectionSummary,
          symbol: lastRej.symbol,
        };
      }

      if (!rawCandidates.length) {
        const summary = detectorDiagnostics.map((d) => ({
          symbol: d.symbol,
          br: (d.breakoutRejectedReasons || []).slice(0, 3),
          pb: (d.pullbackRejectedReasons || []).slice(0, 3),
        }));
        this.lastNoCandidateSummary = { at, summary, detectorDiagnostics };
        const flat = summary
          .map((s) => `${s.symbol}: breakout=${s.br.join(';') || 'ok'} pullback=${s.pb.join(';') || 'ok'}`)
          .join(' | ');
        console.log(`[autonomous] no candidates emitted symbols=${this.symbols.join(',')} ${flat}`);
      }

      this.status.metrics.lastScan = {
        ok: true,
        at,
        symbolsEvaluated: this.symbols.length,
        rawCandidatesDetected: rawCandidates.length,
        detectorDiagnostics,
        scoredCandidates: scored.length,
        governanceCandidatesSeen: cycle.candidatesSeen,
        governanceCandidatesRejected: cycle.candidatesRejected,
        governanceCandidatesAccepted: cycle.candidatesAccepted,
        entriesExecuted: cycle.entriesExecuted || 0,
        lastNoCandidateSummary: !rawCandidates.length ? this.lastNoCandidateSummary : null,
      };

      await this.saveStatus();
      return cycle;
    } catch (e) {
      this.status.lastScanAt = at;
      this.status.lastError = e.message;
      this.status.metrics.lastScan = { ok: false, at, error: e.message };
      pushWarning(this.status, `runScanCycle:${e.message}`);
      await this.saveStatus();
      return { ok: false, error: e.message };
    } finally {
      this._scanRunning = false;
    }
  }

  async runExitCycle() {
    const at = new Date().toISOString();
    if (this._exitRunning) {
      return { ok: true, skipped: true, reason: 'exit_already_running' };
    }
    this._exitRunning = true;
    try {
      await this.refreshMarketState();
      const cycle = await autonomousExitManager.runAutonomousExitCycle();
      this.status.lastExitCheckAt = at;
      this.status.exitsExecuted += cycle.exitsExecuted || 0;
      this.status.lastError = null;
      this.status.metrics.lastExit = {
        ok: true,
        at,
        openAutonomousPositions: cycle.openAutonomousPositions,
        exitsExecuted: cycle.exitsExecuted,
      };
      await this.saveStatus();
      return cycle;
    } catch (e) {
      this.status.lastExitCheckAt = at;
      this.status.lastError = e.message;
      this.status.metrics.lastExit = { ok: false, at, error: e.message };
      pushWarning(this.status, `runExitCycle:${e.message}`);
      await this.saveStatus();
      return { ok: false, error: e.message };
    } finally {
      this._exitRunning = false;
    }
  }

  async start() {
    this.enabled = isEnabled();
    this.symbols = parseSymbols();
    this.scanIntervalSeconds = effectiveScanIntervalSeconds(
      parseInt(process.env.AUTO_ENTRY_SCAN_INTERVAL_SECONDS || '60', 10)
    );
    this.exitIntervalSeconds = effectiveExitIntervalSeconds(
      parseInt(process.env.AUTO_EXIT_SCAN_INTERVAL_SECONDS || '30', 10)
    );

    if (!this.enabled) {
      this.running = false;
      this.status.enabled = false;
      this.status.running = false;
      await this.saveStatus();
      return this.getStatus();
    }

    if (this.running) {
      return this.getStatus();
    }

    const gen = (this._startGeneration || 0) + 1;
    this._startGeneration = gen;

    await this.loadStatus();
    await this.loadPriceState();
    this.running = true;
    this.status.enabled = true;
    this.status.running = true;
    this.status.paperOnlyEnforced = true;
    this.status.liveExecutionBlocked = true;

    const scanMs = this.scanIntervalSeconds * 1000;
    const exitMs = this.exitIntervalSeconds * 1000;

    this.timers.scan = setInterval(() => {
      if (this._startGeneration !== gen) return;
      this.runScanCycle().catch((e) => {
        this.status.lastError = e.message;
      });
    }, scanMs);
    this.timers.exit = setInterval(() => {
      if (this._startGeneration !== gen) return;
      this.runExitCycle().catch((e) => {
        this.status.lastError = e.message;
      });
    }, exitMs);

    try {
      await this.runScanCycle();
    } catch (e) {
      pushWarning(this.status, `immediate_scan:${e.message}`);
    }
    try {
      await this.runExitCycle();
    } catch (e) {
      pushWarning(this.status, `immediate_exit:${e.message}`);
    }

    await this.saveStatus();
    return this.getStatus();
  }

  async stop() {
    this._startGeneration = (this._startGeneration || 0) + 1;
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
