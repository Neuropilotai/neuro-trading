#!/usr/bin/env node
'use strict';

/**
 * NeuroPilot Lab Control Server — Local API for Start / Stop / Status of the nightly lab.
 * Dashboard → fetch(this server) → exec start_lab.sh / stop_lab.sh / status_lab.sh
 *
 * Usage: node tools/labControlServer.js
 * Port: 7788 (LAB_CONTROL_PORT env to override)
 */

const path = require('path');
const { exec } = require('child_process');
const express = require('express');

const app = express();
const PORT = Number(process.env.LAB_CONTROL_PORT || 7788);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = {
  start: path.join(PROJECT_ROOT, 'scripts', 'start_lab.sh'),
  stop: path.join(PROJECT_ROOT, 'scripts', 'stop_lab.sh'),
  status: path.join(PROJECT_ROOT, 'scripts', 'status_lab.sh'),
};

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

function runScript(name, res) {
  const script = SCRIPTS[name];
  if (!script) return res.status(404).json({ error: 'Unknown action' });
  exec(`bash "${script}"`, { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    if (name === 'start') {
      res.json({ started: true, output: output || null, error: err ? (err.message || String(err)) : null });
    } else if (name === 'stop') {
      res.json({ stopped: true, output: output || null, error: err ? (err.message || String(err)) : null });
    } else {
      res.json({ status: output || 'No output', raw: stdout || '', error: err ? (err.message || String(err)) : null });
    }
  });
}

app.get('/lab/start', (req, res) => runScript('start', res));
app.get('/lab/stop', (req, res) => runScript('stop', res));
app.get('/lab/status', (req, res) => runScript('status', res));

app.get('/lab/health', (req, res) => {
  res.json({ ok: true, service: 'NeuroPilot Lab Control', port: PORT });
});

app.listen(PORT, () => {
  console.log(`NeuroPilot Lab Control running on http://localhost:${PORT}`);
  console.log('  GET /lab/start   — start nightly lab (launchctl bootstrap + kickstart)');
  console.log('  GET /lab/stop    — stop nightly lab (launchctl bootout)');
  console.log('  GET /lab/status  — show launchd status');
});
