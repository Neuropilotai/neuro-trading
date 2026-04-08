'use strict';

module.exports = {
  enabled: false,

  /** Explicit null so server checks `drive !== null` stay correct (undefined would wrongly pass). */
  drive: null,
  folderId: null,
  lastSyncAt: null,
  connected: false,
  lastError: null,

  getStatus() {
    return {
      enabled: false,
      available: false,
      reason: 'stub_not_configured',
    };
  },

  async healthCheck() {
    return {
      enabled: false,
      available: false,
      reason: 'stub_not_configured',
    };
  },

  async listRecentPatterns() {
    return [];
  },

  async savePattern() {
    return { ok: false, saved: false, reason: 'stub_not_configured' };
  },

  async loadPattern() {
    return null;
  },

  async syncToDrive() {
    return { success: false, reason: 'stub_not_configured' };
  },

  async initialize() {
    return false;
  },
};
