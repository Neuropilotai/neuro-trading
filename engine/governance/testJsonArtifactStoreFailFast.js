#!/usr/bin/env node
'use strict';

/**
 * Proof test: jsonArtifactStore fail-fast contract (tmp only).
 *
 * Cases:
 *   1) absent file → empty factory
 *   2) invalid JSON → quarantine + throw
 *   3) invalid schema → quarantine + throw
 *   4) NEUROPILOT_LENIENT_JSON_STORES=true + invalid JSON → empty, file left in place
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/governance/testJsonArtifactStoreFailFast.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJsonStore } = require('./jsonArtifactStore');

const registryOpts = {
  label: 'test_registry',
  empty: () => ({ experiments: [] }),
  isValidShape: (j) => j != null && typeof j === 'object' && Array.isArray(j.experiments),
};

function assert(cond, msg) {
  if (!cond) {
    console.error('[testJsonArtifactStoreFailFast] FAIL:', msg);
    process.exit(1);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function quarantineSiblings(dir, baseFile) {
  const base = path.basename(baseFile);
  const prefix = `${base}.corrupt.`;
  return fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
}

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np_json_store_test_'));
  const storePath = path.join(tmp, 'experiment_registry.json');

  console.log('tmp:', tmp);

  // 1) absent
  const empty = readJsonStore(storePath, registryOpts);
  assert(deepEqual(empty, { experiments: [] }), 'absent file should yield empty registry');

  // valid round-trip
  fs.writeFileSync(storePath, JSON.stringify({ experiments: [{ experimentId: 'x' }] }), 'utf8');
  const ok = readJsonStore(storePath, registryOpts);
  assert(ok.experiments.length === 1 && ok.experiments[0].experimentId === 'x', 'valid JSON round-trip');

  // 2) invalid JSON (strict)
  fs.writeFileSync(storePath, '{ not json', 'utf8');
  let threw = false;
  try {
    readJsonStore(storePath, registryOpts);
  } catch (e) {
    threw = true;
    assert(String(e.message).includes('invalid JSON'), 'error should mention invalid JSON');
  }
  assert(threw, 'invalid JSON should throw');
  assert(!fs.existsSync(storePath), 'original file should be renamed away');
  const q1 = quarantineSiblings(tmp, 'experiment_registry.json');
  assert(q1.length >= 1, 'should have at least one .corrupt.* file');
  assert(fs.existsSync(path.join(tmp, q1[0])), 'quarantined file should exist');

  // 3) invalid schema
  const storePath2 = path.join(tmp, 'store2.json');
  fs.writeFileSync(storePath2, JSON.stringify({ experiments: 'not-array' }), 'utf8');
  threw = false;
  try {
    readJsonStore(storePath2, registryOpts);
  } catch (e) {
    threw = true;
    assert(String(e.message).includes('invalid schema'), 'error should mention invalid schema');
  }
  assert(threw, 'bad schema should throw');
  assert(!fs.existsSync(storePath2), 'bad schema file should be quarantined');
  assert(quarantineSiblings(tmp, 'store2.json').length >= 1, 'store2 corrupt sibling');

  // 4) lenient + invalid JSON (no quarantine, returns empty)
  const storePath3 = path.join(tmp, 'store3.json');
  fs.writeFileSync(storePath3, '!!!', 'utf8');
  withEnv('NEUROPILOT_LENIENT_JSON_STORES', 'true', () => {
    const r = readJsonStore(storePath3, registryOpts);
    assert(deepEqual(r, { experiments: [] }), 'lenient invalid JSON returns empty');
    assert(fs.existsSync(storePath3), 'lenient mode leaves corrupt file in place (recovery manual)');
  });

  console.log('[testJsonArtifactStoreFailFast] OK — all 4 cases passed');
}

main();
