'use strict';

/**
 * READ-ONLY upstream audit: why NO_VALIDATION_SIBLING — batch rows vs promotionKey / isPromotable.
 * Invoked from buildPromotedChildren when NEUROPILOT_WF_UPSTREAM_AUDIT=1.
 */

const fs = require('fs');
const path = require('path');

const PRIORITY_PARENTS = [
  'mut_2eaa21_open_ecfe4b',
  'familyexp_mut_2eaa21_open_ecfe4b_forced_family_shift_cabca7',
  'mut_dcb4bf_open_04394a',
  'mut_8ed5cc_open_b2ea9a',
  'mut_ab2ee9_open_7051ba',
  'mut_8cfd2c_open_e43db7',
];

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listBatchJsonFiles(batchDir) {
  if (!batchDir || !fs.existsSync(batchDir)) return [];
  return fs
    .readdirSync(batchDir)
    .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
    .map((f) => path.join(batchDir, f));
}

/**
 * @returns {{ row: object, file: string }[]}
 */
function scanAllBatchRows(batchDir) {
  const out = [];
  for (const file of listBatchJsonFiles(batchDir)) {
    const json = safeReadJson(file);
    if (!json || !Array.isArray(json.results)) continue;
    const base = path.basename(file);
    for (const row of json.results) {
      if (row && typeof row === 'object') out.push({ row, file: base });
    }
  }
  return out;
}

function batchWalkforwardMeta(batchDir) {
  const files = listBatchJsonFiles(batchDir);
  for (const file of files) {
    const j = safeReadJson(file);
    if (j && j.walkforward && typeof j.walkforward === 'object') {
      return {
        file: path.basename(file),
        walkforward: j.walkforward,
      };
    }
  }
  return { file: null, walkforward: null };
}

function loadMissingAuditSamples(discoveryDir, wfMissingAuditReport) {
  if (wfMissingAuditReport && wfMissingAuditReport.samplesByBucket) {
    return wfMissingAuditReport.samplesByBucket.NO_VALIDATION_SIBLING || [];
  }
  const p = path.join(discoveryDir, 'wf_missing_audit.json');
  if (!fs.existsSync(p)) return [];
  const j = safeReadJson(p);
  if (!j || !j.samplesByBucket) return [];
  return j.samplesByBucket.NO_VALIDATION_SIBLING || [];
}

function analyzeOneCase(
  caseInput,
  allRows,
  deps
) {
  const {
    buildPromotionKey,
    isWalkForwardValidationRow,
    isPromotable,
    num,
    promotableOpts,
  } = deps;

  const promotionKey = caseInput.promotionKey;
  const winnerStrategyId = caseInput.winnerStrategyId != null ? String(caseInput.winnerStrategyId) : null;
  const parentSetupId = caseInput.parentSetupId != null ? String(caseInput.parentSetupId) : null;
  const mutationType = caseInput.mutationType != null ? String(caseInput.mutationType) : null;
  const winnerRules = caseInput.winnerRules != null ? caseInput.winnerRules : null;

  const matchingKey = allRows.filter(({ row }) => buildPromotionKey(row) === promotionKey);

  const trainRowsFound = matchingKey.filter(({ row }) => {
    const s = String(row.walkforwardSplit || row.datasetSplit || '').toLowerCase();
    return s === 'train';
  }).length;

  const validationRowsFound = matchingKey.filter(({ row }) => isWalkForwardValidationRow(row)).length;

  const validationPromotableCount = matchingKey.filter(
    ({ row }) => isWalkForwardValidationRow(row) && isPromotable(row, promotableOpts)
  ).length;

  const sameSetupRows = winnerStrategyId
    ? allRows.filter(({ row }) => row && String(row.setupId) === winnerStrategyId)
    : [];

  const keysForWinnerSetup = [
    ...new Set(sameSetupRows.map(({ row }) => buildPromotionKey(row))),
  ];

  const validationRowsSameSetupAnyKey = sameSetupRows.filter(({ row }) =>
    isWalkForwardValidationRow(row)
  );

  const trainRowsSameSetupAnyKey = sameSetupRows.filter(({ row }) => {
    const s = String(row.walkforwardSplit || row.datasetSplit || '').toLowerCase();
    return s === 'train';
  });

  let keyMismatchSuspected = keysForWinnerSetup.length > 1;
  let diagnosis = 'UNKNOWN_UPSTREAM_GAP';
  let dropStage = null;

  const validationWrittenToBatch = validationRowsFound > 0;
  const validationBuiltInMemory = null;

  if (validationRowsFound > 0) {
    if (validationPromotableCount > 0) {
      diagnosis = 'UNKNOWN_UPSTREAM_GAP';
      dropStage = 'promotable_validation_same_key_exists_in_batch';
    } else {
      diagnosis = 'VALIDATION_DROPPED_BY_FILTER';
      dropStage = 'isPromotable';
    }
  } else if (validationRowsSameSetupAnyKey.length > 0) {
    diagnosis = 'VALIDATION_WRITTEN_BUT_KEY_MISMATCH';
    keyMismatchSuspected = true;
  } else if (trainRowsFound > 0 || trainRowsSameSetupAnyKey.length > 0) {
    diagnosis = 'VALIDATION_NOT_GENERATED';
  } else {
    diagnosis = 'UNKNOWN_UPSTREAM_GAP';
  }

  return {
    promotionKey,
    parentSetupId,
    mutationType,
    winnerStrategyId,
    winnerRules,
    trainRowsFound,
    validationRowsFound,
    validationPromotableInBatch: validationPromotableCount,
    validationExpected: true,
    validationBuiltInMemory,
    validationWrittenToBatch,
    keyMismatchSuspected,
    keysSeenForWinnerSetup: keysForWinnerSetup.slice(0, 8),
    validationRowsForWinnerSetupAnyKey: validationRowsSameSetupAnyKey.length,
    trainRowsForWinnerSetupAnyKey: trainRowsSameSetupAnyKey.length,
    dropStage,
    diagnosis,
  };
}

/**
 * @param {object} params
 * @param {string} params.batchDir
 * @param {string} params.discoveryDir
 * @param {object} params.opts - same knobs as buildPromotedChildren for isPromotable
 * @param {function} params.buildPromotionKey
 * @param {function} params.isWalkForwardValidationRow
 * @param {function} params.isPromotable
 * @param {function} params.num
 * @param {object|null} [params.wfMissingAuditReport]
 * @param {{ row: object, file: string }[]|null} [params.allRows] — reuse scan from enrich (optional)
 */
function runWfUpstreamAudit(params) {
  const {
    batchDir,
    discoveryDir,
    opts = {},
    buildPromotionKey,
    isWalkForwardValidationRow,
    isPromotable,
    num,
    wfMissingAuditReport,
    allRows: allRowsParam,
  } = params;

  const promotableOpts = {
    minTrades: Math.max(1, num(opts.minTrades, 50)),
    minScore: num(opts.minScore, 0),
    minExpectancy: num(opts.minExpectancy, 0),
  };

  const allRows = Array.isArray(allRowsParam) ? allRowsParam : scanAllBatchRows(batchDir);
  const wfMeta = batchWalkforwardMeta(batchDir);

  const samples = loadMissingAuditSamples(discoveryDir, wfMissingAuditReport);
  const caseInputs = [];
  const seenKeys = new Set();

  function pushCase(c) {
    if (!c || !c.promotionKey) return;
    if (seenKeys.has(c.promotionKey)) return;
    seenKeys.add(c.promotionKey);
    caseInputs.push({
      promotionKey: c.promotionKey,
      parentSetupId: c.parentSetupId,
      mutationType: c.mutationType,
      winnerStrategyId: c.winnerStrategyId != null ? c.winnerStrategyId : null,
      winnerRules: c.winnerRules != null ? c.winnerRules : null,
    });
  }

  for (const s of samples.slice(0, 35)) {
    pushCase({
      promotionKey: s.promotionKey,
      parentSetupId: s.parentSetupId,
      mutationType: s.mutationType,
      winnerStrategyId: s.strategyId,
      winnerRules: null,
    });
  }

  for (const parentId of PRIORITY_PARENTS) {
    const hits = allRows.filter(
      ({ row }) => row && String(row.parentSetupId || '') === parentId
    );
    const keys = [...new Set(hits.map(({ row }) => buildPromotionKey(row)))];
    for (const pk of keys.slice(0, 5)) {
      const one = hits.find(({ row }) => buildPromotionKey(row) === pk);
      pushCase({
        promotionKey: pk,
        parentSetupId: parentId,
        mutationType: one && one.row ? one.row.mutationType : null,
        winnerStrategyId: one && one.row ? one.row.setupId : null,
        winnerRules: one && one.row && one.row.rules ? one.row.rules : null,
      });
    }
  }

  const deps = {
    buildPromotionKey,
    isWalkForwardValidationRow,
    isPromotable,
    num,
    promotableOpts,
  };

  const cases = caseInputs.map((ci) =>
    analyzeOneCase(
      {
        promotionKey: ci.promotionKey,
        parentSetupId: ci.parentSetupId,
        mutationType: ci.mutationType,
        winnerStrategyId: ci.winnerStrategyId,
        winnerRules: ci.winnerRules,
      },
      allRows,
      deps
    )
  );

  const summaryCounts = {
    VALIDATION_NOT_GENERATED: 0,
    VALIDATION_GENERATED_NOT_WRITTEN: 0,
    VALIDATION_WRITTEN_BUT_KEY_MISMATCH: 0,
    VALIDATION_DROPPED_BY_FILTER: 0,
    UNKNOWN_UPSTREAM_GAP: 0,
  };

  for (const c of cases) {
    const d = c.diagnosis;
    if (summaryCounts[d] !== undefined) summaryCounts[d] += 1;
    else summaryCounts.UNKNOWN_UPSTREAM_GAP += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    auditNote:
      'rowsByPromotionKey in buildPromotedChildren only contains isPromotable rows. ' +
      'VALIDATION_DROPPED_BY_FILTER means validation split rows exist in batch JSON for the same promotionKey but fail isPromotable, so they never appear as siblings in the dedupe map.',
    batchWalkforwardMeta: wfMeta,
    totalBatchRowsScanned: allRows.length,
    batchFilesScanned: listBatchJsonFiles(batchDir).length,
    sampledPromotionKeys: [...seenKeys],
    sampledParents: PRIORITY_PARENTS,
    cases,
    summaryCounts,
  };
}

module.exports = {
  runWfUpstreamAudit,
  scanAllBatchRows,
  PRIORITY_PARENTS,
};
