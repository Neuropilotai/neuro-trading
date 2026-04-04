#!/usr/bin/env node
'use strict';

/**
 * Example: run Feature Engine on synthetic OHLCV and print output.
 * Run from repo root: node neuropilot_trading_v2/engine/features/example.js
 */
const { compute } = require('./index');

// Synthetic candles (e.g. 60 bars, slight uptrend + volume spike on last bar)
const base = 2640;
const candles = [];
for (let i = 0; i < 60; i++) {
  const o = base + i * 0.5 + (Math.random() - 0.5) * 4;
  const c = o + (Math.random() - 0.4) * 6;
  const h = Math.max(o, c) + Math.random() * 3;
  const l = Math.min(o, c) - Math.random() * 3;
  const v = 1000 + Math.floor(Math.random() * 500);
  candles.push({ open: o, high: h, low: l, close: c, volume: v });
}
// Last bar: higher volume, price above prior
candles[candles.length - 1].volume = 4000;
candles[candles.length - 1].close = base + 58 * 0.5 + 8;

const features = compute(candles);
console.log('Feature Engine output (example):');
console.log(JSON.stringify(features, null, 2));
