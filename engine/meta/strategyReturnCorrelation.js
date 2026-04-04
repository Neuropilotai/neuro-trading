'use strict';

function safeNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round6(v) {
  return Math.round(safeNum(v, 0) * 1e6) / 1e6;
}

function mean(arr) {
  const xs = (arr || []).map(Number).filter(Number.isFinite);
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(arr) {
  const xs = (arr || []).map(Number).filter(Number.isFinite);
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function pearson(a, b) {
  const xs = (a || []).map(Number).filter(Number.isFinite);
  const ys = (b || []).map(Number).filter(Number.isFinite);
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;

  const xa = xs.slice(0, n);
  const ya = ys.slice(0, n);

  const mx = mean(xa);
  const my = mean(ya);
  const sx = stddev(xa);
  const sy = stddev(ya);
  if (sx <= 1e-12 || sy <= 1e-12) return 0;

  let cov = 0;
  for (let i = 0; i < n; i += 1) cov += (xa[i] - mx) * (ya[i] - my);
  cov /= n - 1;

  const c = cov / (sx * sy);
  return Math.max(-1, Math.min(1, c));
}

function buildReturnSeriesMap(batchFiles) {
  const bySetup = new Map();

  for (const batch of batchFiles || []) {
    for (const r of batch.results || []) {
      const setupId = String(r.setupId || '');
      if (!setupId) continue;

      const series =
        Array.isArray(r.tradeReturns) ? r.tradeReturns
          : Array.isArray(r.barReturns) ? r.barReturns
            : [];

      if (!series.length) continue;

      if (!bySetup.has(setupId)) bySetup.set(setupId, []);
      bySetup.get(setupId).push(...series.map((x) => safeNum(x, NaN)).filter(Number.isFinite));
    }
  }

  return bySetup;
}

function computeReturnCorrelationMatrix(batchFiles) {
  const seriesMap = buildReturnSeriesMap(batchFiles);
  const ids = Array.from(seriesMap.keys());
  const matrix = {};

  for (let i = 0; i < ids.length; i += 1) {
    const a = ids[i];
    if (!matrix[a]) matrix[a] = {};
    matrix[a][a] = 1;

    for (let j = i + 1; j < ids.length; j += 1) {
      const b = ids[j];
      const corr = round6(pearson(seriesMap.get(a), seriesMap.get(b)));
      if (!matrix[a]) matrix[a] = {};
      if (!matrix[b]) matrix[b] = {};
      matrix[a][b] = corr;
      matrix[b][a] = corr;
    }
  }

  return {
    ids,
    matrix,
    seriesCount: ids.length,
  };
}

function getPairCorrelation(corrMatrix, a, b) {
  if (!corrMatrix || !corrMatrix.matrix) return 0;
  return safeNum(corrMatrix.matrix[a]?.[b], 0);
}

function computeReturnCorrelationPenalty(candidate, selected, corrMatrix, opts = {}) {
  const penaltyScale = safeNum(opts.penaltyScale, 0.45);
  const floorIgnore = safeNum(opts.floorIgnore, 0.2);

  if (!candidate || !selected || !selected.length || !corrMatrix) {
    return {
      penalty: 0,
      avgCorrelation: 0,
      maxCorrelation: 0,
      pairwise: [],
    };
  }

  const candidateId = String(candidate.setupId || '');
  const pairwise = selected.map((s) => {
    const corr = getPairCorrelation(corrMatrix, candidateId, String(s.setupId || ''));
    return {
      withSetupId: String(s.setupId || ''),
      correlation: corr,
    };
  });

  const corrs = pairwise.map((x) => safeNum(x.correlation, 0));
  const avgCorr = mean(corrs);
  const maxCorr = corrs.length ? Math.max(...corrs) : 0;

  const effAvg = Math.max(0, avgCorr - floorIgnore);
  const effMax = Math.max(0, maxCorr - floorIgnore);
  const penalty = round6(Math.min(0.6, penaltyScale * (effAvg * 0.55 + effMax * 0.45)));

  return {
    penalty,
    avgCorrelation: round6(avgCorr),
    maxCorrelation: round6(maxCorr),
    pairwise,
  };
}

module.exports = {
  computeReturnCorrelationMatrix,
  getPairCorrelation,
  computeReturnCorrelationPenalty,
  buildReturnSeriesMap,
};
