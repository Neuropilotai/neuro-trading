#!/usr/bin/env node
'use strict';

/**
 * Minimal admission queue policy (advisory, paper-only).
 * Reads ticker_candidates.json; writes ticker_admission_queue.json
 *
 * - Max 2 paper_candidate (highest admissionScore among eligible).
 * - Others eligible stay watchlist_candidate on the queue.
 * - admission < 55 → ignored
 */

const path = require('path');
const { resolveDiscoveryDir, readJsonSafe, writeJsonPretty } = require('./_discoveryIo');

const SCHEMA_VERSION = '1.0.0';
const DEFAULT_MAX_PAPER = 2;

function buildTickerAdmissionQueuePayload(candidatesDoc, opts = {}) {
  const doc = candidatesDoc && typeof candidatesDoc === 'object' ? candidatesDoc : {};
  const list = Array.isArray(doc.candidates) ? doc.candidates : [];
  const maxPaper = Number(opts.maxPaperCandidates) || DEFAULT_MAX_PAPER;
  const generatedAt = opts.generatedAt || new Date().toISOString();

  const sortedEligible = list
    .filter((c) => c && c.eligibleForPaperAdmission === true)
    .slice()
    .sort((a, b) => (b.admissionScore || 0) - (a.admissionScore || 0));

  const paperSymbols = new Set(
    sortedEligible.slice(0, maxPaper).map((c) => c.symbol)
  );

  let watchlistCount = 0;
  let paperCount = 0;
  let ignoredCount = 0;

  const items = list.map((c) => {
    if (!c || !c.symbol) return null;
    const admissionScore = Number(c.admissionScore) || 0;
    const eligible = c.eligibleForPaperAdmission === true;

    if (admissionScore < 55) {
      ignoredCount += 1;
      return {
        symbol: c.symbol,
        priority: 'low',
        status: 'ignored',
        recommendedAction: 'no_action',
        reason: 'admission score below watchlist threshold',
        admissionScore,
        ownerApprovalRequired: false,
        paperOnly: true,
        source: 'ticker_discovery_v1',
      };
    }

    if (eligible && paperSymbols.has(c.symbol)) {
      paperCount += 1;
      return {
        symbol: c.symbol,
        priority: admissionScore >= 85 ? 'high' : 'medium',
        status: 'paper_candidate',
        recommendedAction: 'observe_or_admit_to_paper',
        reason:
          'admission score above threshold and data coverage sufficient (quota paper candidate)',
        admissionScore,
        ownerApprovalRequired: false,
        paperOnly: true,
        source: 'ticker_discovery_v1',
      };
    }

    watchlistCount += 1;
    return {
      symbol: c.symbol,
      priority: 'medium',
      status: 'watchlist_candidate',
      recommendedAction: 'observe_only',
      reason: eligible
        ? 'eligible but over paper quota; remain watchlist'
        : 'admission or coverage below paper threshold',
      admissionScore,
      ownerApprovalRequired: false,
      paperOnly: true,
      source: 'ticker_discovery_v1',
    };
  }).filter(Boolean);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    sourceCandidatesAt: doc.generatedAt || null,
    summary: {
      watchlistCandidates: watchlistCount,
      paperCandidates: paperCount,
      ignored: ignoredCount,
      maxPaperQuota: maxPaper,
      notes: ['v1_advisory_queue_only', 'no_live_automation'],
    },
    items,
  };
}

function writeTickerAdmissionQueue(opts = {}) {
  const dir = resolveDiscoveryDir(opts);
  const candPath = path.join(dir, 'ticker_candidates.json');
  const doc = readJsonSafe(candPath, null);
  const generatedAt = opts.generatedAt || new Date().toISOString();

  if (!doc || typeof doc !== 'object') {
    const fallback = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      sourceCandidatesAt: null,
      summary: {
        watchlistCandidates: 0,
        paperCandidates: 0,
        ignored: 0,
        maxPaperQuota: DEFAULT_MAX_PAPER,
        notes: ['ticker_candidates.json missing; run scoreTickerCandidates first'],
      },
      items: [],
    };
    const outPath = path.join(dir, 'ticker_admission_queue.json');
    writeJsonPretty(outPath, fallback);
    return { path: outPath, payload: fallback };
  }

  const payload = buildTickerAdmissionQueuePayload(doc, {
    generatedAt,
    maxPaperCandidates: opts.maxPaperCandidates,
  });
  const outPath = path.join(dir, 'ticker_admission_queue.json');
  writeJsonPretty(outPath, payload);
  return { path: outPath, payload };
}

module.exports = {
  SCHEMA_VERSION,
  buildTickerAdmissionQueuePayload,
  writeTickerAdmissionQueue,
  DEFAULT_MAX_PAPER,
};

if (require.main === module) {
  const r = writeTickerAdmissionQueue();
  console.log('[buildTickerAdmissionQueue] wrote', r.path, 'items=', r.payload.items.length);
}
