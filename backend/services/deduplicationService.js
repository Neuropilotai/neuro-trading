/**
 * Alert Deduplication Service
 * Prevents replay attacks and duplicate order processing
 * 
 * Feature Flag: ENABLE_WEBHOOK_DEDUPE (default: true)
 * 
 * Uses in-memory cache with optional file persistence
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class DeduplicationService {
  constructor() {
    this.enabled = process.env.ENABLE_WEBHOOK_DEDUPE !== 'false';
    this.cache = new Map(); // alert_id -> timestamp
    this.cacheFile = process.env.DEDUPE_CACHE_FILE || './data/alert_cache.json';
    this.ttl = parseInt(process.env.DEDUPE_TTL_SECONDS || '3600', 10); // 1 hour default
    
    // Load cache from file on startup
    this.loadCache().catch(err => {
      console.warn('⚠️  Could not load deduplication cache:', err.message);
    });

    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Generate idempotency key from alert data
   * @param {object} alertData - Alert payload
   * @returns {string} - Idempotency key
   */
  generateIdempotencyKey(alertData) {
    // Use alert_id if provided, otherwise generate from content
    if (alertData.alert_id) {
      return `alert_${alertData.alert_id}`;
    }

    // Generate from content hash + timestamp
    const content = JSON.stringify({
      symbol: alertData.symbol,
      action: alertData.action,
      price: alertData.price,
      timestamp: alertData.timestamp || Date.now()
    });

    return `hash_${crypto.createHash('sha256').update(content).digest('hex').substring(0, 16)}`;
  }

  /**
   * Check if alert is duplicate (read-only check, does NOT mark as seen)
   * @param {object} alertData - Alert payload
   * @returns {{isDuplicate: boolean, idempotencyKey: string}} - Check result
   */
  async checkDuplicate(alertData) {
    if (!this.enabled) {
      return { isDuplicate: false, idempotencyKey: null };
    }

    const idempotencyKey = this.generateIdempotencyKey(alertData);
    const now = Date.now();

    // Check cache (read-only)
    const cached = this.cache.get(idempotencyKey);
    
    if (cached) {
      // Check if entry is still valid (within TTL)
      const age = (now - cached) / 1000; // age in seconds
      
      if (age < this.ttl) {
        console.log(`⚠️  Duplicate alert detected: ${idempotencyKey} (age: ${age.toFixed(1)}s)`);
        return { isDuplicate: true, idempotencyKey };
      } else {
        // Entry expired, remove it
        this.cache.delete(idempotencyKey);
      }
    }

    // Not a duplicate (but NOT marked as seen yet - that happens on success)
    return { isDuplicate: false, idempotencyKey };
  }

  /**
   * Mark alert as processed (call this only when request is successfully accepted)
   * Idempotent: safe to call multiple times with the same key (updates timestamp)
   * @param {string} idempotencyKey - Idempotency key to mark as processed
   */
  async markAsProcessed(idempotencyKey) {
    if (!this.enabled || !idempotencyKey) {
      return;
    }

    const now = Date.now();
    
    // Mark as processed (idempotent: if key exists, just update timestamp)
    this.cache.set(idempotencyKey, now);
    
    // Persist to file (async, don't wait, always swallow errors)
    this.saveCache().catch(err => {
      console.warn('⚠️  Could not save deduplication cache:', err.message);
      // Swallow error - in-memory cache is still updated
    });
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [key, timestamp] of this.cache.entries()) {
      const age = (now - timestamp) / 1000;
      if (age >= this.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} expired deduplication entries`);
    }
  }

  /**
   * Load cache from file
   */
  async loadCache() {
    try {
      const data = await fs.readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(data);
      
      // Only load entries that are still within TTL
      const now = Date.now();
      for (const [key, timestamp] of Object.entries(parsed)) {
        const age = (now - timestamp) / 1000;
        if (age < this.ttl) {
          this.cache.set(key, timestamp);
        }
      }

      console.log(`✅ Loaded ${this.cache.size} deduplication entries from cache`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // File doesn't exist yet, that's okay
    }
  }

  /**
   * Save cache to file
   */
  async saveCache() {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.cacheFile);
      await fs.mkdir(dir, { recursive: true });

      // Convert Map to object
      const data = Object.fromEntries(this.cache);
      await fs.writeFile(this.cacheFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('❌ Error saving deduplication cache:', error);
      throw error;
    }
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      enabled: this.enabled,
      size: this.cache.size,
      ttl: this.ttl
    };
  }

  /**
   * Get sample keys from cache (for dev endpoints)
   * @param {number} maxKeys - Maximum number of keys to return
   * @returns {Array<string>} - Array of idempotency keys
   */
  getSampleKeys(maxKeys = 20) {
    const keys = Array.from(this.cache.keys());
    return keys.slice(0, maxKeys);
  }

  /**
   * Clear cache (for dev endpoints)
   * @returns {number} - Number of keys cleared
   */
  clearCache() {
    const count = this.cache.size;
    this.cache.clear();
    return count;
  }

  /**
   * Get cache file path
   * @returns {string} - Cache file path
   */
  getCacheFilePath() {
    return this.cacheFile;
  }
}

// Singleton instance
const deduplicationService = new DeduplicationService();

module.exports = deduplicationService;


