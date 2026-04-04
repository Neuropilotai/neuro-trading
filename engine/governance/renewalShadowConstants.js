'use strict';

/**
 * Shadow renewal lane artefacts — ISOLATED from live paper_exec / paper_trades.
 * Do not glob-merge `*_renewal_shadow*` paths into live dashboards or official trade aggregates.
 */

/** Must match consumers in runPaperExecutionV1 (promoted-like path) and buildRenewalShadowSignals. */
const PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE = 'promoted_manifest_renewal_shadow';

/** Bumps when injected signal shape / audit contract changes (jq / desk tooling). */
const RENEWAL_SHADOW_SIGNAL_SOURCE_VERSION = 1;

/** Stable id for injected rows (no RNG). */
const RENEWAL_SHADOW_INJECTION_BUILD_ID = 'renewal_shadow_inject_v1';

const PAPER_TRADES_RENEWAL_SHADOW_JSONL = 'paper_trades_renewal_shadow.jsonl';
const PAPER_EXEC_SEEN_KEYS_RENEWAL_SHADOW_JSON = 'paper_exec_seen_keys_renewal_shadow.json';
const PAPER_EXEC_V1_LAST_RUN_SHADOW_JSON = 'paper_exec_v1_last_run_shadow.json';
const PAPER_EXECUTION_V1_SIGNALS_RENEWAL_SHADOW_JSON = 'paper_execution_v1_signals_renewal_shadow.json';

module.exports = {
  PROMOTED_MANIFEST_RENEWAL_SHADOW_SIGNAL_SOURCE,
  RENEWAL_SHADOW_SIGNAL_SOURCE_VERSION,
  RENEWAL_SHADOW_INJECTION_BUILD_ID,
  PAPER_TRADES_RENEWAL_SHADOW_JSONL,
  PAPER_EXEC_SEEN_KEYS_RENEWAL_SHADOW_JSON,
  PAPER_EXEC_V1_LAST_RUN_SHADOW_JSON,
  PAPER_EXECUTION_V1_SIGNALS_RENEWAL_SHADOW_JSON,
};
