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

function registryPath() {
  return path.join(dataRoot.getPath('governance'), 'experiment_registry.json');
}

function readRegistry() {
  const p = registryPath();
  return readJsonStore(p, {
    label: 'experiment_registry',
    empty: () => ({ experiments: [] }),
    isValidShape: (j) => j != null && typeof j === 'object' && Array.isArray(j.experiments),
  });
}

function writeRegistry(payload) {
  const p = registryPath();
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  return p;
}

/**
 * Stable, collision-resistant id: UTC YYYYMMDDHHmmssSSS + 6 hex (ms + random).
 * Avoids second-precision collisions under burst starts (see validation Pass 2).
 */
function makeExperimentId() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const mo = p(d.getUTCMonth() + 1, 2);
  const da = p(d.getUTCDate(), 2);
  const h = p(d.getUTCHours(), 2);
  const mi = p(d.getUTCMinutes(), 2);
  const s = p(d.getUTCSeconds(), 2);
  const ms = p(d.getUTCMilliseconds(), 3);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `exp_${y}${mo}${da}${h}${mi}${s}${ms}_${suffix}`;
}

function startExperiment(configSnapshot = {}) {
  const reg = readRegistry();
  const experimentId = makeExperimentId();
  reg.experiments.push({
    experimentId,
    startedAt: nowIso(),
    configSnapshot: configSnapshot && typeof configSnapshot === 'object' ? configSnapshot : {},
    artifacts: [],
    valid: true,
  });
  writeRegistry(reg);
  return experimentId;
}

function appendArtifact(experimentId, stage, pathOrPayload) {
  if (!experimentId) return false;
  const reg = readRegistry();
  const exp = reg.experiments.find((x) => x && x.experimentId === experimentId);
  if (!exp) return false;
  if (!Array.isArray(exp.artifacts)) exp.artifacts = [];
  exp.artifacts.push({
    stage: String(stage || 'unknown'),
    pathOrPayload,
    at: nowIso(),
  });
  writeRegistry(reg);
  return true;
}

function getExperiment(experimentId) {
  const reg = readRegistry();
  return reg.experiments.find((x) => x && x.experimentId === experimentId) || null;
}

function listExperiments(limit = 20) {
  const reg = readRegistry();
  const n = Math.max(1, Number(limit) || 20);
  return reg.experiments.slice(-n).reverse();
}

module.exports = {
  startExperiment,
  appendArtifact,
  getExperiment,
  listExperiments,
};
