'use strict';

/**
 * Signal Queue — In-memory queue of signals waiting to be scored and routed (paper or live).
 *
 * Optional: persist to disk for replay or recovery. For now, in-memory only.
 */

const MAX_QUEUE_SIZE = 500;

const _queue = [];

/**
 * Push one or more signals onto the queue. Drops oldest if over MAX_QUEUE_SIZE.
 */
function push(signalOrSignals) {
  const list = Array.isArray(signalOrSignals) ? signalOrSignals : [signalOrSignals];
  for (const s of list) {
    _queue.push({ ...s, queuedAt: Date.now() });
  }
  while (_queue.length > MAX_QUEUE_SIZE) {
    _queue.shift();
  }
  return _queue.length;
}

/**
 * Pop the next signal (FIFO). Returns undefined if empty.
 */
function pop() {
  return _queue.shift();
}

/**
 * Peek at the next signal without removing.
 */
function peek() {
  return _queue[0];
}

/**
 * Return all queued signals (copy). Optionally clear after.
 */
function getAll(clearAfter = false) {
  const out = _queue.map((s) => ({ ...s }));
  if (clearAfter) _queue.length = 0;
  return out;
}

/**
 * Current queue length.
 */
function length() {
  return _queue.length;
}

/**
 * Clear the queue.
 */
function clear() {
  _queue.length = 0;
}

module.exports = {
  push,
  pop,
  peek,
  getAll,
  length,
  clear,
  MAX_QUEUE_SIZE,
};
