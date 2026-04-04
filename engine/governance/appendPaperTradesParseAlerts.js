'use strict';

/**
 * Append a single line to governance/paper_trades_alerts.log when JSONL parse errors occur.
 * Idempotent per metrics snapshot: caller should only invoke when parseErrors > 0.
 */

const fs = require('fs');
const path = require('path');

function appendPaperTradesParseAlert(governanceDir, metrics) {
  if (!metrics || typeof metrics.parseErrors !== 'number' || metrics.parseErrors <= 0) return;
  if (!governanceDir) return;
  const line = `${metrics.generatedAt || new Date().toISOString()}\tparseErrors=${metrics.parseErrors}\tvalidTradeCount=${metrics.validTradeCount ?? 0}\tsource=${metrics.sourceJsonl || 'n/a'}\n`;
  const filePath = path.join(governanceDir, 'paper_trades_alerts.log');
  fs.mkdirSync(governanceDir, { recursive: true });
  fs.appendFileSync(filePath, line, 'utf8');
}

module.exports = { appendPaperTradesParseAlert };
