'use strict';

/**
 * wf_upstream_audit.json is used only to enrich observability of walk-forward / NO_VALIDATION_SIBLING context.
 * It must never influence promotion eligibility, dedupe, blocking, or execution logic.
 */

const fs = require('fs');
const path = require('path');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} diagnosis - raw diagnosis from wf_upstream_audit cases[].diagnosis
 * @returns {{ diagnosticCode: string, diagnosticMessage: string, upstreamAuditReason: string }}
 */
function projectionFromUpstreamDiagnosis(diagnosis) {
  const d = diagnosis != null ? String(diagnosis) : '';
  const table = {
    VALIDATION_DROPPED_BY_FILTER: {
      diagnosticCode: 'NO_VALIDATION_SIBLING_FILTERED',
      diagnosticMessage:
        'Validation split row exists upstream for the same promotionKey but was excluded from the promotable pool (isPromotable), so it is not visible as a sibling for WF merge.',
    },
    VALIDATION_NOT_GENERATED: {
      diagnosticCode: 'NO_VALIDATION_SIBLING_NOT_GENERATED',
      diagnosticMessage:
        'No validation row was found in batch JSON for this promotionKey / setup (upstream audit).',
    },
    VALIDATION_WRITTEN_BUT_KEY_MISMATCH: {
      diagnosticCode: 'NO_VALIDATION_SIBLING_KEY_MISMATCH',
      diagnosticMessage:
        'A validation row exists for this setupId but under a different promotionKey than the train winner (rules/parent/mutation mismatch).',
    },
    UNKNOWN_UPSTREAM_GAP: {
      diagnosticCode: 'NO_VALIDATION_SIBLING_UNKNOWN_UPSTREAM_GAP',
      diagnosticMessage:
        'Upstream audit could not classify why a validation sibling is missing from the promotable map.',
    },
    VALIDATION_GENERATED_NOT_WRITTEN: {
      diagnosticCode: 'NO_VALIDATION_SIBLING_GENERATED_NOT_WRITTEN',
      diagnosticMessage:
        'Upstream audit indicates validation may be generated but not present in the written batch result set (reserved bucket).',
    },
  };
  const row = table[d];
  if (row) {
    return {
      diagnosticCode: row.diagnosticCode,
      diagnosticMessage: row.diagnosticMessage,
      upstreamAuditReason: d,
    };
  }
  return {
    diagnosticCode: 'NO_VALIDATION_SIBLING_UNKNOWN_UPSTREAM_GAP',
    diagnosticMessage: `Unmapped upstream diagnosis: ${d || 'empty'}`,
    upstreamAuditReason: d || 'UNKNOWN',
  };
}

/**
 * @param {object|null} report - parsed wf_upstream_audit.json or in-memory report from runWfUpstreamAudit
 * @returns {Map<string, object>|null}
 */
function buildIndexFromUpstreamReport(report) {
  if (!report || typeof report !== 'object') return null;
  const cases = Array.isArray(report.cases)
    ? report.cases
    : Array.isArray(report.items)
      ? report.items
      : Array.isArray(report.entries)
        ? report.entries
        : null;
  if (!cases || cases.length === 0) return null;
  const m = new Map();
  for (const c of cases) {
    if (c && typeof c === 'object' && c.promotionKey != null && !m.has(String(c.promotionKey))) {
      m.set(String(c.promotionKey), c);
    }
  }
  return m.size > 0 ? m : null;
}

/**
 * Read discovery/wf_upstream_audit.json only — no batch scan.
 * @param {string} discoveryDir
 * @returns {Map<string, object>|null}
 */
function loadWfUpstreamAuditIndex(discoveryDir) {
  if (!discoveryDir || !String(discoveryDir).trim()) return null;
  const p = path.join(discoveryDir, 'wf_upstream_audit.json');
  if (!fs.existsSync(p)) return null;
  const j = safeReadJson(p);
  return buildIndexFromUpstreamReport(j);
}

/**
 * Prefer in-memory report from current run, else JSON on disk.
 */
function resolveUpstreamIndex(discoveryDir, wfUpstreamAuditReport) {
  const fromReport = buildIndexFromUpstreamReport(wfUpstreamAuditReport);
  if (fromReport) return fromReport;
  return loadWfUpstreamAuditIndex(discoveryDir);
}

/**
 * Enrich REJECT_WALKFORWARD_MISSING reason objects; set per-rejection diagnostic code on guard rows.
 * READ-ONLY: mutates only observability fields on rejection records.
 */
function enrichGuardRejectionsFromUpstreamIndex(params) {
  const {
    guardRejected,
    index,
    wfUpstreamAuditPath,
  } = params;

  const summary = {};
  let enrichedCount = 0;

  if (!index || !(index instanceof Map) || index.size === 0) {
    return { summary, enrichedCount };
  }

  for (const gr of guardRejected || []) {
    const reasons = Array.isArray(gr.reasons) ? gr.reasons : [];
    const hasMissing = reasons.some((r) => r && r.code === 'REJECT_WALKFORWARD_MISSING');
    if (!hasMissing) continue;

    const pk = gr.promotionKey != null ? String(gr.promotionKey) : null;
    if (!pk) continue;

    const caseRow = index.get(pk);
    if (!caseRow || typeof caseRow !== 'object') continue;

    const proj = projectionFromUpstreamDiagnosis(caseRow.diagnosis);
    const reason = reasons.find((r) => r && r.code === 'REJECT_WALKFORWARD_MISSING');
    if (reason && typeof reason === 'object') {
      Object.assign(reason, {
        diagnosticCode: proj.diagnosticCode,
        diagnosticSource: 'wf_upstream_audit',
        upstreamAuditReason: proj.upstreamAuditReason,
        diagnosticMessage: proj.diagnosticMessage,
        upstreamAuditFound: true,
        wfUpstreamAuditPath: wfUpstreamAuditPath || null,
      });
    }

    gr.wfMissingDiagnostic = proj.diagnosticCode;
    // wfMissingSemantic is kept as a deprecated compatibility mirror of wfMissingDiagnostic.
    gr.wfMissingSemantic = proj.diagnosticCode;
    enrichedCount += 1;
    summary[proj.diagnosticCode] = (summary[proj.diagnosticCode] || 0) + 1;
  }

  return { summary, enrichedCount };
}

/**
 * Enrich wf_missing_audit samples in bucket NO_VALIDATION_SIBLING (mutates report in place).
 */
function enrichWfMissingAuditNoValidationSiblingSamples(wfMissingAuditReport, index, wfUpstreamAuditPath) {
  if (!wfMissingAuditReport || !index || !(index instanceof Map) || index.size === 0) return;
  const samples = wfMissingAuditReport.samplesByBucket && wfMissingAuditReport.samplesByBucket.NO_VALIDATION_SIBLING;
  if (!Array.isArray(samples)) return;

  for (const s of samples) {
    if (!s || typeof s !== 'object' || !s.promotionKey) continue;
    const c = index.get(String(s.promotionKey));
    if (!c) continue;
    const proj = projectionFromUpstreamDiagnosis(c.diagnosis);
    s.upstreamDiagnostic = {
      diagnosticCode: proj.diagnosticCode,
      diagnosticMessage: proj.diagnosticMessage,
      upstreamAuditReason: proj.upstreamAuditReason,
      diagnosticSource: 'wf_upstream_audit',
      upstreamAuditFound: true,
      wfUpstreamAuditPath: wfUpstreamAuditPath || null,
    };
  }
}

module.exports = {
  projectionFromUpstreamDiagnosis,
  buildIndexFromUpstreamReport,
  loadWfUpstreamAuditIndex,
  resolveUpstreamIndex,
  enrichGuardRejectionsFromUpstreamIndex,
  enrichWfMissingAuditNoValidationSiblingSamples,
};
