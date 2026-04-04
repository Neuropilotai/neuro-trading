/**
 * Environment Bootstrap for CLI Scripts
 * 
 * Loads .env files from multiple possible locations in deterministic order:
 * 1. repo root .env (lowest priority, loaded first)
 * 2. trading/.env
 * 3. cwd/.env (highest priority, loaded last)
 * 
 * Normalizes environment variable aliases to canonical names:
 * - OANDA_API_KEY, OANDA_TOKEN, OANDA_KEY, OANDA_ACCESS_TOKEN → OANDA_API_TOKEN
 *   (if OANDA_API_TOKEN missing, use first available alias)
 * 
 * IMPORTANT: This file NEVER logs, prints, or leaks environment variables.
 * It only loads them silently. Use DEBUG_ENV=1 to enable safe debug logs.
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Get the directory where this bootstrap file is located
const bootstrapDir = __dirname;

/**
 * Find repo root by looking for .git directory (most reliable indicator)
 * Falls back to package.json if .git not found
 * @param {string} startDir - Directory to start search from
 * @returns {string|null} - Repo root path or null
 */
function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  
  // First, look for .git (most reliable)
  while (current !== root) {
    const gitDir = path.join(current, '.git');
    if (fs.existsSync(gitDir)) {
      return current;
    }
    current = path.dirname(current);
  }
  
  // Fallback: look for package.json, but prefer the one closest to filesystem root
  // (in case trading/ has its own package.json)
  current = path.resolve(startDir);
  let lastPackageJsonDir = null;
  while (current !== root) {
    const packageJson = path.join(current, 'package.json');
    if (fs.existsSync(packageJson)) {
      lastPackageJsonDir = current;
    }
    current = path.dirname(current);
  }
  
  // If we found a package.json, use it, but prefer going up one level if trading/ has package.json
  // This handles case where trading/ is a submodule or has its own package.json
  if (lastPackageJsonDir) {
    // If we're in trading/ and trading/ has package.json, try parent
    if (bootstrapDir.includes('trading') && lastPackageJsonDir.endsWith('trading')) {
      const parent = path.dirname(lastPackageJsonDir);
      if (fs.existsSync(path.join(parent, 'package.json')) || fs.existsSync(path.join(parent, '.git'))) {
        return parent;
      }
    }
    return lastPackageJsonDir;
  }
  
  return null;
}

// Detect repo root
const repoRoot = findRepoRoot(bootstrapDir) || path.resolve(bootstrapDir, '../..');
const cwd = process.cwd();
const tradingDir = path.resolve(bootstrapDir, '..');

// Determine load order based on ENV_OVERRIDE flag
// Default: don't override existing env vars (respect system/env)
const override = process.env.ENV_OVERRIDE === '1';

// Load order (later files override earlier ones, unless override=false)
// Order: repo root → trading → cwd (cwd has highest priority)
const envFiles = [
  // Repo root (lowest priority, loaded first)
  path.join(repoRoot, '.env'),
  // Trading directory
  path.join(tradingDir, '.env'),
  // Current working directory (highest priority, loaded last)
  path.join(cwd, '.env')
];

// Load each .env file (skip if doesn't exist)
let loadedFiles = [];
for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    const result = dotenv.config({ path: envFile, override });
    if (!result.error) {
      loadedFiles.push(envFile);
    }
  }
}

// Normalize OANDA token aliases to canonical OANDA_API_TOKEN
// Supported aliases: OANDA_API_KEY, OANDA_TOKEN, OANDA_KEY, OANDA_ACCESS_TOKEN
// If OANDA_API_TOKEN is missing, use first available alias
const oandaAliases = [
  'OANDA_API_KEY',
  'OANDA_TOKEN',
  'OANDA_KEY',
  'OANDA_ACCESS_TOKEN'
];

if (!process.env.OANDA_API_TOKEN) {
  // Find first available alias
  for (const alias of oandaAliases) {
    if (process.env[alias]) {
      process.env.OANDA_API_TOKEN = process.env[alias];
      // Clear alias to avoid confusion
      delete process.env[alias];
      break;
    }
  }
}

// Safe debug logging (only if DEBUG_ENV=1)
if (process.env.DEBUG_ENV === '1') {
  console.log('DEBUG_ENV: process.cwd() =', cwd);
  console.log('DEBUG_ENV: bootstrapDir =', bootstrapDir);
  console.log('DEBUG_ENV: repoRoot =', repoRoot);
  console.log('DEBUG_ENV: tradingDir =', tradingDir);
  console.log('DEBUG_ENV: loaded .env files:', loadedFiles);
  const tokenPresent = !!process.env.OANDA_API_TOKEN;
  console.log('DEBUG_ENV: OANDA_API_TOKEN present:', tokenPresent);
  if (tokenPresent) {
    const tokenLength = process.env.OANDA_API_TOKEN.length;
    console.log('DEBUG_ENV: OANDA_API_TOKEN length:', tokenLength);
  }
}

/**
 * Preflight environment check (returns booleans only, no values)
 * @returns {object} Object with boolean flags for required env vars
 */
function preflightEnv() {
  return {
    oandaTokenPresent: !!process.env.OANDA_API_TOKEN,
    oandaEnvPresent: !!(process.env.OANDA_ENV || process.env.OANDA_ENVIRONMENT),
    accountIdPresent: !!process.env.OANDA_ACCOUNT_ID // Optional, but useful to know
  };
}

// IMPORTANT: Never log process.env here or anywhere else.
// Only validate presence if needed (boolean check only).
module.exports = { preflightEnv };

