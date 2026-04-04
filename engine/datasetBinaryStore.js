'use strict';

/**
 * NeuroPilot — Binary OHLC Store
 *
 * Fixed-record binary format for OHLCV. Replaces CSV for ~5×–20× faster load and lets the
 * M3 Pro analyze 5M–10M strategies per night without cloud. Same API shape as datasetLoader output.
 *
 * Format:
 *   Header (52 bytes): magic "NPOHLC1" + count (UInt32LE) + symbol (32B) + timeframe (8B)
 *   Record (32 bytes each): time Float64LE, open/high/low/close Float32LE, volume Float64LE
 *
 * Usage:
 *   const { writeBinaryStore, readBinaryStore } = require('./engine/datasetBinaryStore');
 *   await writeBinaryStore('datasets/spy/spy_5m.bin', { symbol: 'SPY', timeframe: '5m', candles });
 *   const data = await readBinaryStore('datasets/spy/spy_5m.bin');
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const MAGIC = Buffer.from('NPOHLC1\0', 'utf8');
const HEADER_SIZE = 52;
const SYMBOL_LEN = 32;
const TIMEFRAME_LEN = 8;
const RECORD_SIZE = 8 + 4 * 4 + 8; // time(8) + o,h,l,c(4 each) + volume(8) = 32

/**
 * Write normalized candles to a binary store file.
 *
 * @param {string} filePath - Output path (e.g. datasets/spy/spy_5m.bin)
 * @param {{ symbol: string, timeframe: string, candles: Array<{ time, open, high, low, close, volume }> }} data
 * @returns {Promise<{ path: string, bytes: number, count: number }>}
 */
async function writeBinaryStore(filePath, data) {
  const symbol = String(data.symbol || '').slice(0, SYMBOL_LEN).padEnd(SYMBOL_LEN, '\0');
  const timeframe = String(data.timeframe || '').slice(0, TIMEFRAME_LEN).padEnd(TIMEFRAME_LEN, '\0');
  const candles = Array.isArray(data.candles) ? data.candles : [];
  const count = candles.length;

  const buf = Buffer.allocUnsafe(HEADER_SIZE + count * RECORD_SIZE);
  let offset = 0;
  MAGIC.copy(buf, offset); offset += MAGIC.length;
  buf.writeUInt32LE(count, offset); offset += 4;
  buf.write(symbol, offset, SYMBOL_LEN, 'utf8'); offset += SYMBOL_LEN;
  buf.write(timeframe, offset, TIMEFRAME_LEN, 'utf8'); offset += TIMEFRAME_LEN;

  for (const c of candles) {
    const t = Number(c.time ?? c.t ?? 0);
    const o = Number(c.open ?? c.o ?? 0);
    const h = Number(c.high ?? c.h ?? 0);
    const l = Number(c.low ?? c.l ?? 0);
    const cl = Number(c.close ?? c.c ?? 0);
    const v = Number(c.volume ?? c.v ?? 0);
    buf.writeDoubleLE(t, offset); offset += 8;
    buf.writeFloatLE(o, offset); offset += 4;
    buf.writeFloatLE(h, offset); offset += 4;
    buf.writeFloatLE(l, offset); offset += 4;
    buf.writeFloatLE(cl, offset); offset += 4;
    buf.writeDoubleLE(v, offset); offset += 8;
  }

  const dir = path.dirname(filePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await fsPromises.writeFile(filePath, buf);
  return { path: filePath, bytes: buf.length, count };
}

/**
 * Read a binary store and return { symbol, timeframe, candles } in the same shape as datasetLoader.
 *
 * @param {string} filePath - Path to .bin file
 * @returns {Promise<{ symbol: string, timeframe: string, candles: Array<{ time, open, high, low, close, volume }> }>}
 */
async function readBinaryStore(filePath) {
  const buf = await fsPromises.readFile(filePath);
  if (buf.length < HEADER_SIZE) throw new Error('Binary store file too short');
  if (buf.compare(MAGIC, 0, MAGIC.length, 0, MAGIC.length) !== 0) {
    throw new Error('Invalid binary store: bad magic');
  }
  let offset = MAGIC.length;
  const count = buf.readUInt32LE(offset); offset += 4;
  const symbol = buf.toString('utf8', offset, offset + SYMBOL_LEN).replace(/\0+$/, ''); offset += SYMBOL_LEN;
  const timeframe = buf.toString('utf8', offset, offset + TIMEFRAME_LEN).replace(/\0+$/, ''); offset += TIMEFRAME_LEN;

  const expected = HEADER_SIZE + count * RECORD_SIZE;
  if (buf.length < expected) throw new Error(`Binary store truncated: expected ${expected} bytes, got ${buf.length}`);

  const candles = [];
  for (let i = 0; i < count; i++) {
    candles.push({
      time: buf.readDoubleLE(offset),
      open: buf.readFloatLE(offset + 8),
      high: buf.readFloatLE(offset + 12),
      low: buf.readFloatLE(offset + 16),
      close: buf.readFloatLE(offset + 20),
      volume: buf.readDoubleLE(offset + 24),
    });
    offset += RECORD_SIZE;
  }
  return { symbol: symbol || 'SPY', timeframe: timeframe || '5m', candles };
}

/**
 * Synchronous read for hot paths that prefer no async (e.g. repeated loads in a loop).
 * Same return shape as readBinaryStore.
 *
 * @param {string} filePath - Path to .bin file
 * @returns {{ symbol: string, timeframe: string, candles: Array }}
 */
function readBinaryStoreSync(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < HEADER_SIZE) throw new Error('Binary store file too short');
  if (buf.compare(MAGIC, 0, MAGIC.length, 0, MAGIC.length) !== 0) {
    throw new Error('Invalid binary store: bad magic');
  }
  let offset = MAGIC.length;
  const count = buf.readUInt32LE(offset); offset += 4;
  const symbol = buf.toString('utf8', offset, offset + SYMBOL_LEN).replace(/\0+$/, ''); offset += SYMBOL_LEN;
  const timeframe = buf.toString('utf8', offset, offset + TIMEFRAME_LEN).replace(/\0+$/, ''); offset += TIMEFRAME_LEN;

  const expected = HEADER_SIZE + count * RECORD_SIZE;
  if (buf.length < expected) throw new Error(`Binary store truncated: expected ${expected} bytes, got ${buf.length}`);

  const candles = [];
  for (let i = 0; i < count; i++) {
    candles.push({
      time: buf.readDoubleLE(offset),
      open: buf.readFloatLE(offset + 8),
      high: buf.readFloatLE(offset + 12),
      low: buf.readFloatLE(offset + 16),
      close: buf.readFloatLE(offset + 20),
      volume: buf.readDoubleLE(offset + 24),
    });
    offset += RECORD_SIZE;
  }
  return { symbol: symbol || 'SPY', timeframe: timeframe || '5m', candles };
}

module.exports = { writeBinaryStore, readBinaryStore, readBinaryStoreSync, HEADER_SIZE, RECORD_SIZE };
