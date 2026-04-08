'use strict';

/**
 * Per tradeGroupId MFE/MAE and lifecycle (long-only; SHORT-ready structure).
 * Must never throw into execution path — callers wrap notify* in try/catch.
 */

const fs = require('fs').promises;
const path = require('path');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getLifecycleJournalPath() {
  return path.join(getDataDir(), 'trade_lifecycles.jsonl');
}

function normalizeSymbol(symbol) {
  return String(symbol || '').toUpperCase().trim();
}

class TradeLifecycleService {
  constructor() {
    /** @type {Map<string, object>} */
    this.groups = new Map();
    /** @type {Map<string, string>} symbol -> tradeGroupId */
    this.symbolActive = new Map();
  }

  isEnabled() {
    return String(process.env.ENABLE_TRADE_LIFECYCLE || 'true').toLowerCase() !== 'false';
  }

  /**
   * LONG: update max/min price and running peak/worst unrealized $.
   */
  _applyMarkLong(st, price) {
    const p = Number(price);
    if (!st || !Number.isFinite(p) || p <= 0) return;
    const entry = Number(st.entryPrice);
    const qty = Number(st.quantity);
    if (!Number.isFinite(entry) || !Number.isFinite(qty) || qty <= 0) return;

    st.maxPriceSeen = Math.max(Number(st.maxPriceSeen) || p, p);
    st.minPriceSeen = Math.min(Number(st.minPriceSeen) || p, p);

    const unrealized = (p - entry) * qty;
    st.peakUnrealizedPnL = Math.max(Number(st.peakUnrealizedPnL) || 0, unrealized);
    st.worstUnrealizedPnL = Math.min(
      Number.isFinite(Number(st.worstUnrealizedPnL)) ? st.worstUnrealizedPnL : 0,
      unrealized
    );
  }

  /**
   * After BUY fill: open or scale-in (same tradeGroupId when adding to position).
   */
  notifyBuyFilled({ tradeGroupId, symbol, fillPrice, avgPrice, quantity }) {
    if (!this.isEnabled() || !tradeGroupId) return;
    const sym = normalizeSymbol(symbol);
    const gid = String(tradeGroupId);
    let st = this.groups.get(gid);

    if (!st) {
      const q0 = Number(quantity);
      st = {
        tradeGroupId: gid,
        symbol: sym,
        side: 'LONG',
        entryPrice: Number(avgPrice),
        quantity: q0,
        maxOpenQty: Number.isFinite(q0) && q0 > 0 ? q0 : 0,
        firstEntryTimestamp: new Date().toISOString(),
        maxPriceSeen: Number(fillPrice),
        minPriceSeen: Number(fillPrice),
        peakUnrealizedPnL: 0,
        worstUnrealizedPnL: 0,
        cumulativeRealizedPnL: 0,
      };
      this.groups.set(gid, st);
      this.symbolActive.set(sym, gid);
    } else {
      st.entryPrice = Number(avgPrice);
      st.quantity = Number(quantity);
      const q = Number(st.quantity);
      if (Number.isFinite(q) && q > 0) {
        st.maxOpenQty = Math.max(Number(st.maxOpenQty) || 0, q);
      }
    }

    this._applyMarkLong(st, fillPrice);
  }

  /**
   * External price tick (webhook, OANDA refresh).
   */
  notifyPriceTick(symbol, price) {
    if (!this.isEnabled()) return;
    const sym = normalizeSymbol(symbol);
    const gid = this.symbolActive.get(sym);
    if (!gid) return;
    const st = this.groups.get(gid);
    if (!st || st.side !== 'LONG') return;
    this._applyMarkLong(st, price);
  }

  /**
   * Partial or full exit: update PnL, qty, mark at exit; finalize if flat.
   * @returns {{ finalized: object|null }}
   */
  notifySellFill({
    tradeGroupId,
    symbol,
    exitPrice,
    pnl,
    newOpenQuantity,
    exitTimestamp,
  }) {
    if (!this.isEnabled() || !tradeGroupId) {
      return { finalized: null };
    }
    const gid = String(tradeGroupId);
    const st = this.groups.get(gid);
    if (!st) {
      return { finalized: null };
    }

    const qOpen = Number(st.quantity);
    if (Number.isFinite(qOpen) && qOpen > 0) {
      st.maxOpenQty = Math.max(Number(st.maxOpenQty) || 0, qOpen);
    }

    this._applyMarkLong(st, exitPrice);
    st.cumulativeRealizedPnL =
      (Number(st.cumulativeRealizedPnL) || 0) + (Number(pnl) || 0);
    st.quantity = Math.max(0, Number(newOpenQuantity) || 0);

    const finalClose = st.quantity <= 0;
    if (!finalClose) {
      return { finalized: null };
    }

    const finalized = this._finalizeAndRemove(st, exitPrice, exitTimestamp);
    return { finalized };
  }

  _finalizeAndRemove(st, exitPrice, exitTimestamp) {
    const entryFinal = Number(st.entryPrice);
    const maxP = Number(st.maxPriceSeen);
    const minP = Number(st.minPriceSeen);
    const mfe = Number.isFinite(entryFinal) && Number.isFinite(maxP) ? maxP - entryFinal : 0;
    const mae = Number.isFinite(entryFinal) && Number.isFinite(minP) ? entryFinal - minP : 0;
    const mfePercent =
      entryFinal > 0 && Number.isFinite(mfe) ? (mfe / entryFinal) * 100 : 0;
    const maePercent =
      entryFinal > 0 && Number.isFinite(mae) ? (mae / entryFinal) * 100 : 0;

    const t0 = Date.parse(st.firstEntryTimestamp);
    const t1 = Date.parse(exitTimestamp);
    const lifecycleDurationSec =
      Number.isFinite(t0) && Number.isFinite(t1)
        ? Math.max(0, Math.round((t1 - t0) / 1000))
        : 0;
    const lifecycleDurationMin = lifecycleDurationSec / 60;

    const peak = Number(st.peakUnrealizedPnL) || 0;
    const cum = Number(st.cumulativeRealizedPnL) || 0;
    const maxQ = Number(st.maxOpenQty) || 0;
    const mfeDollar = mfe > 0 && maxQ > 0 ? mfe * maxQ : 0;
    let efficiencyRatio = null;
    if (mfeDollar > 0 && Number.isFinite(cum)) {
      efficiencyRatio = cum / mfeDollar;
    } else if (peak > 0 && Number.isFinite(cum)) {
      efficiencyRatio = cum / peak;
    }

    const summary = {
      tradeGroupId: st.tradeGroupId,
      symbol: st.symbol,
      side: st.side,
      entryPriceAvg: entryFinal,
      entryTimestamp: st.firstEntryTimestamp,
      finalExitTimestamp: exitTimestamp,
      lifecycleDurationSec,
      lifecycleDurationMin,
      peakUnrealizedPnL: Math.round(peak * 1e6) / 1e6,
      worstUnrealizedPnL: Math.round((Number(st.worstUnrealizedPnL) || 0) * 1e6) / 1e6,
      mfe: Math.round(mfe * 1e6) / 1e6,
      mae: Math.round(mae * 1e6) / 1e6,
      mfePercent: Math.round(mfePercent * 1e4) / 1e4,
      maePercent: Math.round(maePercent * 1e4) / 1e4,
      cumulativeRealizedPnL: Math.round((Number(st.cumulativeRealizedPnL) || 0) * 1e6) / 1e6,
      efficiencyRatio:
        efficiencyRatio != null && Number.isFinite(efficiencyRatio)
          ? Math.round(efficiencyRatio * 1e4) / 1e4
          : null,
      maxPriceSeen: maxP,
      minPriceSeen: minP,
      maxOpenQty: maxQ,
      finalExitPrice: Number(exitPrice),
    };

    this.groups.delete(st.tradeGroupId);
    if (this.symbolActive.get(st.symbol) === st.tradeGroupId) {
      this.symbolActive.delete(st.symbol);
    }

    this._appendLifecycleJournal(summary).catch((e) => {
      console.warn(`[lifecycle] journal append failed: ${e.message}`);
    });

    return summary;
  }

  async _appendLifecycleJournal(row) {
    const file = getLifecycleJournalPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
  }

  async loadLifecycleSummaries() {
    const file = getLifecycleJournalPath();
    try {
      const text = await fs.readFile(file, 'utf8');
      const out = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch (e) {
          console.warn(`[lifecycle] skip bad line: ${e.message}`);
        }
      }
      return out.sort((a, b) =>
        String(b.finalExitTimestamp || '').localeCompare(String(a.finalExitTimestamp || ''))
      );
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      console.warn(`[lifecycle] load failed: ${e.message}`);
      return [];
    }
  }
}

module.exports = new TradeLifecycleService();
