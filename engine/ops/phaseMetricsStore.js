'use strict';

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function governanceDir() {
  const root = process.env.NEUROPILOT_DATA_ROOT || dataRoot.getDataRoot();
  return path.join(root, 'governance');
}

function metricsPath() {
  return path.join(governanceDir(), 'pipeline_phase_metrics.jsonl');
}

function safeReadLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readPhaseMetrics(phaseName, limit = 200) {
  const lines = safeReadLines(metricsPath());
  const out = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const row = JSON.parse(lines[i]);
      if (!phaseName || String(row.phase || '') === String(phaseName)) out.push(row);
      if (out.length >= limit) break;
    } catch (_) {
      // ignore corrupted rows
    }
  }
  return out.reverse();
}

function appendPhaseMetric(row) {
  try {
    const dir = governanceDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(metricsPath(), `${JSON.stringify(row)}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function estimateEtaSec(phaseName, elapsedSec, completedUnits, totalUnits) {
  const c = Number(completedUnits);
  const t = Number(totalUnits);
  const elapsed = Math.max(0, Number(elapsedSec) || 0);
  if (Number.isFinite(c) && Number.isFinite(t) && t > 0 && c > 0) {
    const throughput = c / Math.max(1e-9, elapsed);
    return Math.max(0, Math.round((t - c) / Math.max(1e-9, throughput)));
  }
  const hist = readPhaseMetrics(phaseName, 20)
    .map((r) => Number(r.durationMs))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!hist.length) return null;
  const avgMs = hist.reduce((a, b) => a + b, 0) / hist.length;
  return Math.max(0, Math.round(avgMs / 1000 - elapsed));
}

module.exports = {
  appendPhaseMetric,
  readPhaseMetrics,
  estimateEtaSec,
  metricsPath,
};

