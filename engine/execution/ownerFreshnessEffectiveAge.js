'use strict';

/**
 * Reads datasets_freshness.json: raw max age vs export-produced freshnessContext.effective max for owner gates.
 * Owner / approval-queue consumers only — not for execution, learning, promotion, or dataset guards.
 *
 * SYNC: `ownerStaleAgeForThreshold` is duplicated in ops-dashboard/owner-app.js (browser, no require).
 * Change both when adjusting fallback / effective-max semantics.
 */

function rawMaxDatasetAgeMinutes(freshness) {
  const rows = freshness && Array.isArray(freshness.datasets) ? freshness.datasets : [];
  let max = 0;
  let has = false;
  for (const d of rows) {
    const a = Number(d.dataset_age_minutes);
    if (Number.isFinite(a)) {
      has = true;
      if (a > max) max = a;
    }
  }
  return has ? max : null;
}

/**
 * Age used for owner stale / aging thresholds (session-adjusted when freshnessContext present).
 * Fail-soft: missing context, missing key, or null/NaN effective → raw max (historical behavior).
 * Note: Number(null) is 0 in JS — must not treat null effective as numeric zero.
 * @returns {number|null}
 */
function ownerStaleAgeForThreshold(freshness) {
  const ctx = freshness && freshness.freshnessContext;
  if (!ctx || !Object.prototype.hasOwnProperty.call(ctx, 'effectiveMaxDatasetAgeMinutesForOwner')) {
    return rawMaxDatasetAgeMinutes(freshness);
  }
  const v = ctx.effectiveMaxDatasetAgeMinutesForOwner;
  if (v != null && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return rawMaxDatasetAgeMinutes(freshness);
}

module.exports = {
  rawMaxDatasetAgeMinutes,
  ownerStaleAgeForThreshold,
};
