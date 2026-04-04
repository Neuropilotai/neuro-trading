#!/usr/bin/env node
'use strict';

/**
 * CLI: writes <DATA_ROOT>/governance/capital_allocation_policy.json
 */

const fs = require('fs');
const path = require('path');
const {
  loadInputsForCapitalAllocationBuild,
  buildCapitalAllocationPolicy,
  policyDocumentForWrite,
  writeCapitalAllocationPolicy,
} = require('./capitalAllocationPolicyCore');

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dataRoot = process.env.NEUROPILOT_DATA_ROOT
    ? path.resolve(process.env.NEUROPILOT_DATA_ROOT)
    : path.join(repoRoot, 'data_workspace');
  const opsDir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
    ? path.resolve(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR)
    : path.join(repoRoot, 'ops-snapshot');

  let inputs;
  try {
    inputs = loadInputsForCapitalAllocationBuild({ dataRoot, repoRoot, opsDir });
  } catch (e) {
    console.error(`[buildCapitalAllocationPolicy] load inputs FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }

  let doc;
  try {
    doc = buildCapitalAllocationPolicy(inputs);
  } catch (e) {
    console.error(`[buildCapitalAllocationPolicy] build FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }

  const gov = path.join(dataRoot, 'governance');
  fs.mkdirSync(gov, { recursive: true });
  const outPath = path.join(gov, 'capital_allocation_policy.json');
  const toWrite = policyDocumentForWrite(doc);
  writeCapitalAllocationPolicy(outPath, doc);

  const statusPath = path.join(opsDir, 'capital_allocation_policy_build_status.json');
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
          concentrationRisk: toWrite.concentrationRisk,
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
