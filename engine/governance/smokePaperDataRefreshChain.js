#!/usr/bin/env node
'use strict';

/**
 * Smoke: paper data refresh chain with --skip-data-engine (no network).
 * Requires data_workspace (or NEUROPILOT_DATA_ROOT) with:
 * - datasets_manifest.json + .bin for NEUROPILOT_WAVE1_SYMBOLS
 * - generated_strategies/setup_mut_*.json (Wave1 signals path)
 *
 * Pass: signals rebuild OK + paper exec appended > 0 + jsonl line count increased OR maxExitTs in tail advanced.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'data_workspace');

function main() {
  /** Prefer repo data_workspace so npm smoke is deterministic; override with NEUROPILOT_PAPER_CHAIN_SMOKE_ROOT. */
  const root = process.env.NEUROPILOT_PAPER_CHAIN_SMOKE_ROOT || DEFAULT_ROOT;
  const sym = process.env.NEUROPILOT_WAVE1_SYMBOLS || 'BTCUSDT,SPY';

  const res = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'engine/governance/runPaperDataRefreshChain.js'), '--skip-data-engine', `--data-root=${root}`],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NEUROPILOT_DATA_ROOT: root,
        NEUROPILOT_WAVE1_SYMBOLS: sym,
      },
      encoding: 'utf8',
    }
  );

  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);

  if (res.status !== 0) {
    console.error('[smokePaperDataRefreshChain] FAIL exit', res.status);
    process.exit(res.status || 1);
  }

  const out = String(res.stdout || '');
  const m = out.match(/paper_exec appended (\d+)/);
  const n = m ? Number(m[1]) : 0;
  if (!Number.isFinite(n) || n <= 0) {
    console.error('[smokePaperDataRefreshChain] FAIL could not parse appended count');
    process.exit(1);
  }

  const ld = out.match(/SUMMARY lineDelta=\s*(-?\d+)/);
  const delta = ld ? Number(ld[1]) : null;
  if (delta == null || delta <= 0) {
    console.error('[smokePaperDataRefreshChain] FAIL expected lineDelta > 0 got', delta);
    process.exit(1);
  }

  console.log('[smokePaperDataRefreshChain] ALL OK (skip-data-engine; signals+paper exercised)');
  process.exit(0);
}

main();
