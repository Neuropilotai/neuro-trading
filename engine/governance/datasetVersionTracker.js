'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataRoot = require('../dataRoot');
const { readJsonStore } = require('./jsonArtifactStore');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function filePath() {
  return path.join(dataRoot.getPath('governance'), 'dataset_versions.json');
}

function readStore() {
  const p = filePath();
  return readJsonStore(p, {
    label: 'dataset_versions',
    empty: () => ({ versions: [] }),
    isValidShape: (j) => j != null && typeof j === 'object' && Array.isArray(j.versions),
  });
}

function writeStore(payload) {
  const p = filePath();
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  return p;
}

function makeVersionId(input) {
  return `dsv_${crypto.createHash('sha1').update(input).digest('hex').slice(0, 12)}`;
}

function registerDataset(symbol, timeframe, pathOrKey, candleCount, dateRange = null) {
  const s = String(symbol || '').toUpperCase();
  const tf = String(timeframe || '').toLowerCase();
  const key = String(pathOrKey || '');
  const count = Math.max(0, Number(candleCount) || 0);
  const firstTs =
    dateRange && dateRange.firstTimestamp != null ? String(dateRange.firstTimestamp) : '';
  const lastTs =
    dateRange && dateRange.lastTimestamp != null ? String(dateRange.lastTimestamp) : '';
  const basis = `${s}|${tf}|${key}|${count}|${firstTs}|${lastTs}`;
  const datasetVersionId = makeVersionId(basis);

  const store = readStore();
  const exists = store.versions.find((v) => v && v.datasetVersionId === datasetVersionId);
  if (!exists) {
    store.versions.push({
      datasetVersionId,
      symbol: s,
      timeframe: tf,
      pathOrKey: key,
      candleCount: count,
      dateRange: dateRange || null,
      registeredAt: nowIso(),
    });
    writeStore(store);
  }
  return datasetVersionId;
}

function getVersionId(pathOrKey) {
  const key = String(pathOrKey || '');
  if (!key) return null;
  const store = readStore();
  const match = [...store.versions].reverse().find((v) => v && v.pathOrKey === key);
  return match ? match.datasetVersionId : null;
}

function getVersion(datasetVersionId) {
  const store = readStore();
  return store.versions.find((v) => v && v.datasetVersionId === datasetVersionId) || null;
}

module.exports = {
  registerDataset,
  getVersionId,
  getVersion,
};
