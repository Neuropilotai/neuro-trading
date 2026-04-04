'use strict';

const { execSync } = require('child_process');

function runStep(name, cmd) {
  const ts = new Date().toISOString();
  console.log(`[cycle] ${ts} START ${name}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`[cycle] ${ts} OK ${name}`);
  } catch (e) {
    console.error(`[cycle] ${ts} ERROR ${name}`, e.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const intervalMs = Number(process.env.NEUROPILOT_CYCLE_INTERVAL_MS || 60000);

  while (true) {
    const cycleStart = new Date().toISOString();
    console.log(`\n==============================`);
    console.log(`[cycle] START ${cycleStart}`);
    console.log(`==============================\n`);

    runStep('buildPromotedChildren', 'node engine/evolution/buildPromotedChildren.js');
    runStep('buildPromotedManifest', 'node engine/governance/buildPromotedManifest.js');
    runStep('buildPaperSignals', 'node engine/governance/buildPaperExecutionV1SignalsWave1.js');
    runStep('runPaperExecution', 'node engine/governance/runPaperExecutionV1.js');
    runStep('exportOpsSnapshot', 'node engine/evolution/scripts/exportOpsSnapshot.js');

    console.log(`[cycle] SLEEP ${intervalMs}ms\n`);
    await sleep(intervalMs);
  }
}

main().catch((e) => {
  console.error('[cycle] FATAL', e);
  process.exit(1);
});
