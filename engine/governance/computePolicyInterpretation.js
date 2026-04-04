'use strict';

/**
 * Read-only operator hint: when policy:fallback_frequent is expected vs needs investigation.
 * See POLICY_FALLBACK_WHEN_TREND_APPLY_DISABLED.md
 */

const POLICY_INTERPRETATION_SCHEMA_VERSION = '1.0.0';

/**
 * @param {object} input
 * @param {object} [input.policyHealth]
 * @param {object|null} [input.miniReport] — raw governance_mini_report.json (needs trendMemoryApply)
 */
function computePolicyInterpretation(input = {}) {
  const policyHealth =
    input.policyHealth && typeof input.policyHealth === 'object' ? input.policyHealth : {};
  const mini = input.miniReport && typeof input.miniReport === 'object' ? input.miniReport : null;

  const lastAlert =
    policyHealth.lastAlertReason != null && String(policyHealth.lastAlertReason).trim() !== ''
      ? String(policyHealth.lastAlertReason).trim()
      : null;
  const fallbackFrequent = lastAlert === 'fallback_frequent';

  const tma =
    mini && mini.trendMemoryApply && typeof mini.trendMemoryApply === 'object'
      ? mini.trendMemoryApply
      : null;
  const miniHasTma = tma != null;
  const envEnabledExplicit =
    miniHasTma && typeof tma.envEnabled === 'boolean' ? tma.envEnabled : null;

  let status = 'normal';
  let reason = null;
  let userHint = null;

  if (fallbackFrequent) {
    if (!miniHasTma) {
      status = 'unknown';
      reason = 'missing_trend_memory_apply_on_mini_report';
      userHint =
        'policy:fallback_frequent present but governance_mini_report has no trendMemoryApply block — verify mini report version / path.';
    } else if (envEnabledExplicit === false) {
      status = 'expected_by_config';
      reason = 'fallback_under_trend_apply_disabled';
      userHint =
        'Consistent with TREND_MEMORY_APPLY disabled (suggestive-only). Not a default engine fault — see POLICY_FALLBACK_WHEN_TREND_APPLY_DISABLED.md.';
    } else if (envEnabledExplicit === true) {
      status = 'investigate';
      reason = 'fallback_frequent_with_apply_enabled';
      userHint =
        'Fallback frequent while trend memory apply is enabled — investigate policy metrics, pipeline, and guards.';
    } else {
      status = 'unknown';
      reason = 'trend_apply_env_enabled_indeterminate';
      userHint =
        'policy:fallback_frequent present but trendMemoryApply.envEnabled is missing or not a boolean — refresh mini report or inspect governance_mini_report.json.';
    }
  }

  return {
    policyInterpretationSchemaVersion: POLICY_INTERPRETATION_SCHEMA_VERSION,
    status,
    reason,
    envTrendMemoryApplyEnabled: envEnabledExplicit,
    policyLastAlertReason: lastAlert,
    userHint,
  };
}

module.exports = {
  computePolicyInterpretation,
  POLICY_INTERPRETATION_SCHEMA_VERSION,
};
