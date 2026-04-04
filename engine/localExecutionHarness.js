'use strict';

/**
 * NeuroPilot Quant Engine v1 — Local Execution Harness
 *
 * Runs the full adaptive quant pipeline locally, converts the signal to a webhook request,
 * sends POST to the running neuropilot_trading_v2 server, and returns a structured result.
 * Only side effect: one HTTP POST to the webhook URL.
 *
 * Inputs:
 *   - candles, account, ranking, symbol
 *   - config: optional { baseUrl, secret, pipeline, adaptive, adapter, webhook, index }
 *
 * Output:
 *   - { valid, adaptiveSignal, executionPayload, webhookRequest, httpStatus, responseBody }
 */

const adaptivePipeline = require('./adaptivePipeline');
const signalAdapter = require('./signalAdapter');
const webhookBridge = require('./webhookBridge');

/** Default base URL for local server. */
const DEFAULT_BASE_URL = 'http://localhost:3014';

/**
 * Send POST request using native fetch. Returns { status, body } or throws.
 * @param {string} url
 * @param {object} headers
 * @param {object} body
 * @returns {Promise<{ status: number, body: object|string }>}
 */
async function sendWebhookPost(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: headers || { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type');
  let responseBody;
  const text = await res.text();
  if (contentType && contentType.includes('application/json') && text) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = { raw: text };
    }
  } else {
    responseBody = text || null;
  }
  return { status: res.status, body: responseBody };
}

/**
 * Run full pipeline: adaptive → payload → webhook request → POST. Returns structured result.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {object} account - Account state
 * @param {object} ranking - Strategy ranking from strategyRanking.rank()
 * @param {string} symbol - Instrument symbol (e.g. "XAUUSD")
 * @param {object} [config] - { baseUrl, secret, pipeline, adaptive, adapter, webhook, index }
 * @returns {Promise<object>} { valid, adaptiveSignal, executionPayload, webhookRequest, httpStatus, responseBody }
 */
async function run(candles, account, ranking, symbol, config = {}) {
  const opts = config || {};
  const index = typeof opts.index === 'number' ? opts.index : (Array.isArray(candles) ? candles.length - 1 : 0);
  const baseUrl = opts.baseUrl != null ? opts.baseUrl : DEFAULT_BASE_URL;
  const webhookConfig = {
    baseUrl,
    secret: opts.secret,
    ...(opts.webhook || {}),
  };

  // 1. Run adaptive pipeline
  const adaptiveSignal = adaptivePipeline.run(candles, account, ranking, {
    pipeline: opts.pipeline,
    adaptive: opts.adaptive,
  }, index);

  const noSendResult = {
    valid: false,
    adaptiveSignal,
    executionPayload: null,
    webhookRequest: null,
    httpStatus: null,
    responseBody: null,
  };

  if (!adaptiveSignal || adaptiveSignal.valid !== true || adaptiveSignal.shouldTrade !== true) {
    noSendResult.responseBody = { error: 'No request sent: adaptive signal invalid or shouldTrade false' };
    return noSendResult;
  }

  // 2. Convert to execution payload
  const executionPayload = signalAdapter.toPayload(adaptiveSignal, symbol, opts.adapter || {});
  if (!executionPayload || executionPayload.valid !== true) {
    noSendResult.executionPayload = executionPayload;
    noSendResult.responseBody = { error: 'No request sent: execution payload invalid' };
    return noSendResult;
  }

  // 3. Convert to webhook request
  const webhookRequest = webhookBridge.toWebhookRequest(executionPayload, webhookConfig);
  if (!webhookRequest || webhookRequest.valid !== true || !webhookRequest.body) {
    noSendResult.executionPayload = executionPayload;
    noSendResult.webhookRequest = webhookRequest;
    noSendResult.responseBody = { error: 'No request sent: webhook request invalid' };
    return noSendResult;
  }

  // 4. Send POST request
  let httpStatus = null;
  let responseBody = null;
  try {
    const res = await sendWebhookPost(webhookRequest.url, webhookRequest.headers, webhookRequest.body);
    httpStatus = res.status;
    responseBody = res.body;
  } catch (err) {
    httpStatus = 0;
    responseBody = { error: err && err.message ? err.message : 'Request failed' };
  }

  return {
    valid: executionPayload.valid === true && webhookRequest.valid === true,
    adaptiveSignal,
    executionPayload,
    webhookRequest,
    httpStatus,
    responseBody,
  };
}

module.exports = {
  run,
  sendWebhookPost,
  DEFAULT_BASE_URL,
};
