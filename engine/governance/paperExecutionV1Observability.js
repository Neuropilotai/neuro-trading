'use strict';

/**
 * Read-only observability for Paper Execution V1 throttles (last run summary + seen-keys store).
 */

const fs = require('fs');
const path = require('path');

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function buildPaperExecutionV1Observability(governanceDir) {
  const lastRunPath = path.join(governanceDir, 'paper_exec_v1_last_run.json');
  const seenPath = path.join(governanceDir, 'paper_exec_seen_keys.json');
  const last = safeReadJson(lastRunPath);
  const seenDoc = safeReadJson(seenPath);
  const keysObj =
    seenDoc && seenDoc.keys && typeof seenDoc.keys === 'object' && !Array.isArray(seenDoc.keys)
      ? seenDoc.keys
      : {};
  const seenKeysCount = Object.keys(keysObj).length;

  return {
    paperExecLastRunPresent: last != null,
    paperExecSeenKeysStorePresent: fs.existsSync(seenPath),
    seenKeysCount,
    paperExecPersistentThrottleEnabled:
      last && last.paperExecPersistentThrottleEnabled != null
        ? last.paperExecPersistentThrottleEnabled
        : null,
    paperExecBarThrottleEnabled:
      last && last.paperExecBarThrottleEnabled != null ? last.paperExecBarThrottleEnabled : null,
    duplicateSkippedRunLastRun:
      last && last.duplicateSkippedRun != null ? last.duplicateSkippedRun : null,
    duplicateSkippedPersistentLastRun:
      last && last.duplicateSkippedPersistent != null ? last.duplicateSkippedPersistent : null,
    effectiveAppendedLastRun:
      last && last.effectiveAppended != null ? last.effectiveAppended : null,
    writtenAt: last && last.writtenAt ? last.writtenAt : null,
    seenKeysStorePath: seenPath,
    lastRunPath,
    note:
      'Last-run counters are from the most recent runner invocation. Skipped duplicates are not in paper_trades.jsonl.',
  };
}

function attachPaperExecutionV1ToMetrics(metrics, governanceDir) {
  return {
    ...metrics,
    paperExecutionV1Observability: buildPaperExecutionV1Observability(governanceDir),
  };
}

function mergePaperExecutionV1IntoV2Full(full, governanceDir) {
  return {
    ...full,
    paperExecutionV1Observability: buildPaperExecutionV1Observability(governanceDir),
  };
}

module.exports = {
  buildPaperExecutionV1Observability,
  attachPaperExecutionV1ToMetrics,
  mergePaperExecutionV1IntoV2Full,
};
