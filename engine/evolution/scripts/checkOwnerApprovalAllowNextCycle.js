#!/usr/bin/env node
'use strict';

/**
 * Back-compat entry: same as checkOwnerApprovalEvolutionGates.js (reconcile deep + allow next bundle).
 */

const { runEvolutionOwnerApprovalGateCheck } = require('./checkOwnerApprovalEvolutionGates');
runEvolutionOwnerApprovalGateCheck();
