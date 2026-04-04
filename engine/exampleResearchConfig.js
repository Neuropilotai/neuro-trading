#!/usr/bin/env node
'use strict';

/**
 * Example: research config — default account, dataset groups, helpers.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleResearchConfig.js
 */
const researchConfig = require('./researchConfig');

console.log('DEFAULT_ACCOUNT:', researchConfig.DEFAULT_ACCOUNT);
console.log('listDatasetGroups():', researchConfig.listDatasetGroups());

console.log('\ngetDatasetGroup("qqq_only"):');
console.log(JSON.stringify(researchConfig.getDatasetGroup('qqq_only'), null, 2));

console.log('\ngetDatasetGroup("us_indices_core"):');
console.log(JSON.stringify(researchConfig.getDatasetGroup('us_indices_core'), null, 2));

console.log('\ndefinitionsForSymbol("IWM", ["1m", "5m"]):');
console.log(JSON.stringify(researchConfig.definitionsForSymbol('IWM', ['1m', '5m']), null, 2));

console.log('\ngetDatasetGroup("unknown"):', researchConfig.getDatasetGroup('unknown'));
