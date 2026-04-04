#!/usr/bin/env node
'use strict';

/**
 * CLI writeback (same files as Owner Ops API).
 * Usage (from neuropilot_trading_v2):
 *   node engine/execution/ownerApprovalCli.js record <recommendationId> <action>
 * Example:
 *   node engine/execution/ownerApprovalCli.js record rec_governance_allow_next_cycle approved
 */

const { applyOwnerApprovalDecision } = require('./ownerApprovalPersistence');

const args = process.argv.slice(2);
if (args[0] !== 'record' || args.length < 3) {
  console.error('Usage: node ownerApprovalCli.js record <recommendationId> <action>');
  process.exit(1);
}

const recommendationId = String(args[1]).trim();
const action = String(args[2]).trim();

try {
  applyOwnerApprovalDecision({
    recommendationId,
    action,
    actor: 'cli',
  });
  console.log('OK — owner approval recorded');
  process.exit(0);
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}
