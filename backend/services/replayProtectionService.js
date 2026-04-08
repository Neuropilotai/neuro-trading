'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getStorePath() {
  return path.join(getDataDir(), 'security', 'replay_protection.json');
}

function getRetentionSeconds() {
  const n = parseInt(process.env.REPLAY_PROTECTION_RETENTION_SECONDS || '600', 10);
  return Number.isFinite(n) && n >= 30 ? Math.min(n, 86400) : 600;
}

async function loadStore() {
  try {
    const raw = await fs.readFile(getStorePath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && Array.isArray(o.entries) ? o : { entries: [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [] };
    return { entries: [] };
  }
}

async function saveStore(store) {
  const p = getStorePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(store, null, 2), 'utf8');
}

function prune(store, nowMs) {
  const ttl = getRetentionSeconds() * 1000;
  store.entries = (store.entries || []).filter((e) => nowMs - (e.ts || 0) < ttl);
}

/**
 * @param {object} input
 * @param {string} input.fingerprint stable id for this request
 * @param {number} [input.ts] optional ms timestamp
 * @returns {Promise<{ ok: boolean, replay: boolean, reason?: string }>}
 */
async function checkAndRecord(input = {}) {
  const fp = String(input.fingerprint || '');
  if (!fp) return { ok: true, replay: false };

  const nowMs = Date.now();
  const store = await loadStore();
  prune(store, nowMs);

  const hit = store.entries.find((e) => e.fingerprint === fp);
  if (hit) {
    return { ok: false, replay: true, reason: 'replay_detected' };
  }

  store.entries.push({ fingerprint: fp, ts: nowMs, meta: input.meta || {} });
  prune(store, nowMs);
  try {
    await saveStore(store);
  } catch (e) {
    console.warn(`[replay-protection] save failed: ${e.message}`);
  }
  return { ok: true, replay: false };
}

function buildFingerprint({ rawBody, signature, alertId, timestampHeader }) {
  const h = crypto.createHash('sha256');
  h.update(String(rawBody || ''));
  h.update('|');
  h.update(String(signature || ''));
  h.update('|');
  h.update(String(alertId || ''));
  h.update('|');
  h.update(String(timestampHeader || ''));
  return h.digest('hex');
}

module.exports = {
  checkAndRecord,
  buildFingerprint,
  getStorePath,
  getRetentionSeconds,
};
