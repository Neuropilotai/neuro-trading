'use strict';

/**
 * Single source of truth for parsing governance/paper_trades.jsonl (Paper Execution V1 lines).
 * Malformed lines increment parseErrors; valid trades must have paperExecutionSchemaVersion + finite pnl.
 */

/**
 * @param {string|null|undefined} content
 * @returns {{ trades: object[], parseErrors: number, lineCount: number }}
 */
function parsePaperTradesJsonlContent(content) {
  const lines =
    content == null || content === ''
      ? []
      : content.split(/\r?\n/).filter((l) => l.trim() !== '');
  let parseErrors = 0;
  const trades = [];

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }
    if (!o || typeof o !== 'object') {
      parseErrors++;
      continue;
    }
    if (o.reason === 'skip') continue;
    if (o.paperExecutionSchemaVersion == null || String(o.paperExecutionSchemaVersion).trim() === '') {
      parseErrors++;
      continue;
    }
    if (typeof o.pnl !== 'number' || !Number.isFinite(o.pnl)) {
      parseErrors++;
      continue;
    }
    trades.push(o);
  }

  return { trades, parseErrors, lineCount: lines.length };
}

module.exports = { parsePaperTradesJsonlContent };
