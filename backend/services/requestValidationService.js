'use strict';

const REASON = {
  INVALID_PAYLOAD_SCHEMA: 'invalid_payload_schema',
  INVALID_ACTION: 'invalid_action',
  INVALID_QUANTITY: 'invalid_quantity',
  INVALID_PRICE: 'invalid_price',
  INVALID_SYMBOL: 'invalid_symbol',
};

function normalizeSymbol(sym) {
  return String(sym || '')
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '')
    .trim();
}

/**
 * Strict webhook payload validation (canonical codes).
 */
function validateWebhookStrict(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: REASON.INVALID_PAYLOAD_SCHEMA, errors: ['body_not_object'] };
  }

  const required = ['symbol', 'action', 'price', 'quantity', 'alert_id', 'timestamp'];
  for (const f of required) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      errors.push(`missing_${f}`);
    }
  }

  const sym = normalizeSymbol(body.symbol);
  if (!sym || sym.length < 3) {
    errors.push('invalid_symbol');
  }

  const action = String(body.action || '').toUpperCase().trim();
  if (!['BUY', 'SELL', 'CLOSE'].includes(action)) {
    errors.push('invalid_action');
  }

  const qty = parseFloat(body.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    errors.push('invalid_quantity');
  }

  const price = parseFloat(body.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1e9) {
    errors.push('invalid_price');
  }

  if (errors.length) {
    const primary =
      errors.find((e) => e.startsWith('invalid')) || errors[0] || 'invalid_payload_schema';
    const code =
      primary === 'invalid_action'
        ? REASON.INVALID_ACTION
        : primary === 'invalid_quantity'
          ? REASON.INVALID_QUANTITY
          : primary === 'invalid_price'
            ? REASON.INVALID_PRICE
            : primary === 'invalid_symbol'
              ? REASON.INVALID_SYMBOL
              : REASON.INVALID_PAYLOAD_SCHEMA;

    return { ok: false, reason: code, errors: [...new Set(errors)] };
  }

  return { ok: true, normalized: { ...body, symbol: sym, action } };
}

function validateEmptyBodyAllowed(body) {
  if (body == null) return { ok: false, reason: REASON.INVALID_PAYLOAD_SCHEMA };
  return { ok: true };
}

module.exports = {
  REASON,
  normalizeSymbol,
  validateWebhookStrict,
  validateEmptyBodyAllowed,
};
