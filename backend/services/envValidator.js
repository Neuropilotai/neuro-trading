/**
 * Environment Variable Validator
 * Validates required environment variables at startup
 * Fails fast if critical vars are missing
 */

class EnvValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  /**
   * Validate environment variables based on trading mode
   */
  validate() {
    this.errors = [];
    this.warnings = [];

    const tradingMode = (process.env.TRADING_MODE || 'paper').toLowerCase();
    const broker = (process.env.BROKER || 'paper').toLowerCase();

    // Always required
    if (!process.env.TRADINGVIEW_WEBHOOK_SECRET && !process.env.WEBHOOK_SECRET) {
      this.errors.push('TRADINGVIEW_WEBHOOK_SECRET or WEBHOOK_SECRET must be set');
    }

    // OANDA-specific validation
    if (broker === 'oanda') {
      if (!process.env.OANDA_API_TOKEN && !process.env.OANDA_API_KEY) {
        this.errors.push('OANDA_API_TOKEN or OANDA_API_KEY must be set when BROKER=oanda');
      }
      if (!process.env.OANDA_ACCOUNT_ID) {
        this.errors.push('OANDA_ACCOUNT_ID must be set when BROKER=oanda');
      }
      const oandaEnv = (process.env.OANDA_ENV || 'practice').toLowerCase();
      if (!['practice', 'live'].includes(oandaEnv)) {
        this.errors.push(`OANDA_ENV must be 'practice' or 'live', got: ${oandaEnv}`);
      }
    }

    // Live trading validation
    if (tradingMode === 'live') {
      if (process.env.TRADING_LIVE_CONFIRM !== 'true') {
        this.errors.push('TRADING_LIVE_CONFIRM=true required when TRADING_MODE=live');
      }
      if (broker === 'paper') {
        this.warnings.push('TRADING_MODE=live but BROKER=paper - consider using BROKER=oanda');
      }
    }

    // Warnings (non-fatal)
    if (tradingMode === 'paper' && broker === 'oanda' && process.env.OANDA_PRACTICE_EXECUTION === 'true') {
      // This is fine, just informational
    }

    if (process.env.ALLOWED_SYMBOLS && process.env.ALLOWED_SYMBOLS.trim() === '') {
      this.warnings.push('ALLOWED_SYMBOLS is empty - all symbols will be allowed (not recommended for production)');
    }

    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings
    };
  }

  /**
   * Validate and fail fast if critical errors
   */
  validateAndFailFast() {
    const result = this.validate();

    if (result.warnings.length > 0) {
      console.warn('⚠️  Environment variable warnings:');
      result.warnings.forEach(w => console.warn(`   - ${w}`));
    }

    if (!result.valid) {
      console.error('❌ Environment variable validation failed:');
      result.errors.forEach(e => console.error(`   - ${e}`));
      console.error('\n💡 Fix the errors above and restart the server.');
      process.exit(1);
    }

    return result;
  }
}

module.exports = new EnvValidator();

