#!/usr/bin/env node
'use strict';

/**
 * CLI: writes <DATA_ROOT>/governance/replay_boost_policy.json
 * Env: NEUROPILOT_DATA_ROOT, NEUROPILOT_OPS_SNAPSHOT_DIR (repo ops-snapshot)
 */

const fs = require('fs');
const path = require('path');
const {
  computeReplayBoostPolicy,
  policyDocumentForWrite,
} = require('./replayBoostPolicyCore');

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dataRoot = process.env.NEUROPILOT_DATA_ROOT
    ? path.resolve(process.env.NEUROPILOT_DATA_ROOT)
    : path.join(repoRoot, 'data_workspace');
  const opsDir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
    ? path.resolve(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR)
    : path.join(repoRoot, 'ops-snapshot');

  const gov = path.join(dataRoot, 'governance');
  fs.mkdirSync(gov, { recursive: true });
  const outPath = path.join(gov, 'replay_boost_policy.json');

  let doc;
  try {
    doc = computeReplayBoostPolicy({ dataRoot, repoRoot, opsDir });
  } catch (e) {
    console.error(`[buildReplayBoostPolicy] FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }

  const toWrite = policyDocumentForWrite(doc);
  fs.writeFileSync(outPath, JSON.stringify(toWrite, null, 2), 'utf8');

  const statusPath = path.join(opsDir, 'replay_boost_policy_build_status.json');
  try {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(
      statusPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          ok: true,
          generatedAt: toWrite.generatedAt,
          outPath,
          policyMode: toWrite.policyMode,
          summary: toWrite.summary,
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    /* optional */
  }

  console.log(
    JSON.stringify({
      ok: true,
      path: outPath,
      policyMode: toWrite.policyMode,
      summary: toWrite.summary,
    })
  );
}

if (require.main === module) main();

module.exports = { main };
