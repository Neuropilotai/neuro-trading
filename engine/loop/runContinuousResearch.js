#!/usr/bin/env node
'use strict';

/**
 * Continuous Research Loop
 *
 * Modes:
 * - standard  -> engine/scripts/runGlobalPipeline.sh
 * - expanded  -> engine/scripts/runFullPipelineExpanded.sh
 *
 * Usage:
 *   node engine/loop/runContinuousResearch.js --cycles 10 --sleepSec 300
 *   node engine/loop/runContinuousResearch.js --cycles 10 --sleepSec 300 --expanded
 *   node engine/loop/runContinuousResearch.js --infinite --sleepSec 600 --expanded
 *   node engine/loop/runContinuousResearch.js --cycles 20 --sleepSec 300 --stopOnError
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dataRoot = require('../dataRoot');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function tsCompact(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '_',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function getLoopDir() {
  return path.join(dataRoot.getDataRoot(), 'loop_runs');
}

function parseArgs(argv) {
  const args = {
    cycles: 1,
    infinite: false,
    sleepSec: 300,
    continueOnError: true,
    expanded: false,
    scriptPath: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--infinite') {
      args.infinite = true;
    } else if (a === '--cycles') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.cycles = Math.floor(n);
    } else if (a === '--sleepSec') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) args.sleepSec = n;
    } else if (a === '--stopOnError') {
      args.continueOnError = false;
    } else if (a === '--expanded') {
      args.expanded = true;
    } else if (a === '--script') {
      const p = argv[++i];
      if (p) args.scriptPath = p;
    }
  }

  return args;
}

function resolveScriptPath(projectRoot, args) {
  if (args.scriptPath) {
    return path.isAbsolute(args.scriptPath)
      ? args.scriptPath
      : path.join(projectRoot, args.scriptPath);
  }

  const rel = args.expanded
    ? 'engine/scripts/runFullPipelineExpanded.sh'
    : 'engine/scripts/runGlobalPipeline.sh';

  return path.join(projectRoot, rel);
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      shell: false,
    });

    child.stdout.on('data', (buf) => {
      const s = String(buf);
      stdout += s;
      process.stdout.write(s);
    });

    child.stderr.on('data', (buf) => {
      const s = String(buf);
      stderr += s;
      process.stderr.write(s);
    });

    child.on('close', (code, signal) => {
      resolve({
        ok: code === 0,
        code,
        signal: signal || null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
      });
    });
  });
}

async function runOneCycle(cycleNo, totalCycles, scriptPath, projectRoot) {
  console.log(`--- Cycle ${cycleNo}/${totalCycles === Infinity ? '∞' : totalCycles} ---`);

  const startedAt = new Date();
  const result = await runCommand('/bin/bash', [scriptPath], {
    cwd: projectRoot,
    env: process.env,
  });
  const finishedAt = new Date();

  return {
    cycle: cycleNo,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    code: result.code,
    signal: result.signal,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const projectRoot = process.cwd();
  const loopDir = getLoopDir();
  const sessionTs = tsCompact();
  const scriptFull = resolveScriptPath(projectRoot, args);

  if (!fs.existsSync(scriptFull)) {
    console.error(`Continuous Research failed: script not found: ${scriptFull}`);
    process.exit(1);
  }

  ensureDir(loopDir);

  const sessionPath = path.join(loopDir, `loop_session_${sessionTs}.json`);
  writeJson(sessionPath, {
    startedAt: new Date().toISOString(),
    dataRoot: dataRoot.getDataRoot(),
    loopDir,
    scriptPath: scriptFull,
    mode: args.expanded ? 'expanded' : 'standard',
    expanded: args.expanded,
    cycles: args.infinite ? 'infinite' : args.cycles,
    sleepSec: args.sleepSec,
    continueOnError: args.continueOnError,
  });

  console.log('Continuous Research Loop');
  console.log(`  Data root: ${dataRoot.getDataRoot()}`);
  console.log(`  Loop dir: ${loopDir}`);
  console.log(`  Session: ${sessionPath}`);
  console.log(`  Script: ${path.relative(projectRoot, scriptFull)}`);
  console.log(`  Mode: ${args.expanded ? 'expanded' : 'standard'}`);
  console.log(`  Cycles: ${args.infinite ? 'infinite' : args.cycles}`);
  console.log(`  Sleep: ${args.sleepSec} s`);
  console.log(`  Continue on error: ${args.continueOnError}`);
  console.log('');

  const maxCycles = args.infinite ? Infinity : args.cycles;
  let cycle = 1;

  while (cycle <= maxCycles) {
    const report = await runOneCycle(cycle, maxCycles, scriptFull, projectRoot);
    const reportPath = path.join(loopDir, `loop_run_${tsCompact()}_cycle${cycle}.json`);
    writeJson(reportPath, report);

    if (report.code === 0) {
      console.log(`Done. Pipeline global terminé.`);
      console.log(`  Report: ${reportPath}`);
    } else {
      console.error(`[ERROR] Cycle ${cycle} failed with code ${report.code}`);
      console.error(`  Report: ${reportPath}`);
      if (!args.continueOnError) {
        console.error('Stopping because --stopOnError is enabled.');
        process.exit(report.code || 1);
      }
    }

    cycle += 1;

    if (cycle <= maxCycles || args.infinite) {
      if (args.sleepSec > 0) {
        console.log(`  Sleeping ${args.sleepSec}s...`);
        await sleep(args.sleepSec * 1000);
      }
    }

    if (!args.infinite && cycle > maxCycles) break;
  }

  console.log('');
  console.log('Continuous Research Loop finished.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Continuous Research crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveScriptPath,
  runOneCycle,
};
