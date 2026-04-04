'use strict';

/**
 * Single place to interpret owner_approval_state.json decisions for gates.
 * Callers must only invoke gates when the recommendation is present in the queue.
 */

/**
 * @param {object | null | undefined} state
 * @param {string} id
 */
function isApproved(state, id) {
  const s = state && state.decisions && state.decisions[id];
  return s && String(s.status) === 'approved';
}

/**
 * @param {object | null | undefined} state
 * @param {string} id
 */
function isBlocked(state, id) {
  const s = state && state.decisions && state.decisions[id];
  return s && String(s.status) === 'blocked';
}

/**
 * True when there is no approval for this id (use only when queue already contains the rec).
 * @param {object | null | undefined} state
 * @param {string} id
 */
function shouldBlock(state, id) {
  return !isApproved(state, id);
}

module.exports = {
  isApproved,
  isBlocked,
  shouldBlock,
};
