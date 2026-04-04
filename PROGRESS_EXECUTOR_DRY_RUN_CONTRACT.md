# Progress Executor Dry-Run Contract

## 1. Purpose

`progressExecutor` dry-run is a simulation-only evaluator for `phaseActionPlan.actions`.

It must:
- simulate execution admission decisions only
- determine which actions would be eligible for future execution modes
- never perform real mutations

It must not:
- run scripts
- change files
- modify pipeline/runtime state
- call external systems

It exists to validate executor decisioning and safety **before** any real execution mode is introduced.

## 2. Relationship to Phase Action Plan

- `phaseActionPlan` is the planning source of truth consumed by dry-run.
- Dry-run must consume action semantics from the published contract, including:
  - `type`
  - `blockingType`
  - `status`
  - `ownerApprovalRequired`
  - `required` / `current` / `missing`
- Dry-run must not aggressively reinterpret planning semantics.
- If `PHASE_ACTION_PLAN_CONTRACT.md` and implementation diverge, reconcile that mismatch before real executor rollout.

## 3. Non-Goals

Dry-run does **not**:
- execute real actions
- mutate repo/runtime/ops state
- generate strategies
- refresh datasets
- run validation pipelines
- run promotion pipelines
- override governance controls
- auto-resolve owner approvals
- change thresholds
- make live/paper trading decisions

## 4. Allowed Inputs

Allowed inputs:
- `phaseActionPlan` object (primary)
- optional `phaseTracker`
- optional snapshot metadata context (for reporting only)
- optional executor-local config for quotas/cooldowns (if introduced later)

Rules:
- prefer `phaseActionPlan` over re-deriving source artifacts
- if normalized planning data exists, do not recompute planning semantics
- missing inputs must degrade safely and conservatively

## 5. Execution Eligibility Model

Per action, dry-run must classify into:
- `eligible`
- `ineligible`
- `blocked`
- `skipped`
- `informational only`

Eligibility checks must consider:
- `blockingType`
- `ownerApprovalRequired`
- `action.status`
- `action.type`
- quota gates
- cooldown gates
- idempotence checks
- grounded field presence where required by policy

Baseline rules:
- `owner_gated` actions are never autonomously executable
- `ownerApprovalRequired === true` is a hard block
- `informational` actions are non-executable
- only explicitly supported `auto_fixable` action classes may become dry-run eligible
- `mixed` actions must be treated conservatively unless narrowed by a stricter future contract

## 6. Supported Dry-Run Action Classes

### 6.1 Potentially Eligible

Potential dry-run-eligible classes (simulation admission only):
- `data_repair`
- `validation_growth`
- `promotion_growth`
- `execution_recovery`
- `research_expansion`

Notes:
- this is dry-run eligibility only (not execution approval)
- additional safety checks may still block these classes in a given cycle

### 6.2 Never Auto-Executable in Dry-Run Eligibility

Always blocked for autonomous execution:
- `owner_decision`
- any action with `blockingType = owner_gated`
- any action with `ownerApprovalRequired === true`
- any governance action that would imply policy override, threshold override, or approval bypass

Conservative rule:
- ambiguous governance/control actions default to non-executable in dry-run admission.

## 7. Dry-Run Decision Output Schema

This is a **future output contract** for dry-run results.

Top-level:

| Field | Type | Required | Description |
|---|---|---:|---|
| `mode` | string | Yes | Must be `dry_run`. |
| `status` | string | Yes | Top-level dry-run status enum. |
| `summary` | string | Yes | Compact operator-facing summary. |
| `evaluatedActionCount` | number | Yes | Number of actions evaluated. |
| `eligibleActionCount` | number | Yes | Number of actions marked eligible. |
| `blockedActionCount` | number | Yes | Number of blocked actions. |
| `skippedActionCount` | number | Yes | Number of skipped actions. |
| `results` | array | Yes | Ordered per-action decision results. |
| `generatedAt` | string | Yes | ISO timestamp for result generation. |

Per-action result:

| Field | Type | Required | Description |
|---|---|---:|---|
| `id` | string | Yes | Action id from input plan. |
| `type` | string | Yes | Action type from input plan. |
| `gate` | string | Yes | Action gate from input plan. |
| `inputPriority` | number or null | Yes | Input action priority (if present). |
| `decision` | string | Yes | Per-action dry-run decision enum. |
| `reasonCode` | string | Yes | Machine-readable decision reason. |
| `ownerApprovalRequired` | boolean | Yes | Copied from input action. |
| `blockingType` | string | Yes | Copied from input action. |
| `wouldExecute` | boolean | Yes | Simulation-only execution intent flag. |
| `cooldownActive` | boolean | Yes | Whether cooldown blocked this action. |
| `idempotentSkip` | boolean | Yes | Whether action was skipped as idempotent. |
| `quotaBlocked` | boolean | Yes | Whether action was blocked by quota limits. |
| `notes` | string | Yes | Optional compact annotation. |

## 8. Dry-Run Decision Enums

### 8.1 Top-Level Status

Allowed values:
- `dry_run_ready`
- `dry_run_blocked`
- `dry_run_idle`
- `dry_run_unknown`

### 8.2 Per-Action Decision

Allowed values:
- `eligible`
- `blocked_owner`
- `blocked_policy`
- `blocked_cooldown`
- `blocked_quota`
- `skipped_informational`
- `skipped_idempotent`
- `skipped_unsupported`
- `unknown`

### 8.3 Reason Codes

Reason codes must be:
- explicit
- machine-readable
- deterministic
- additive over time

Representative examples:
- `OWNER_APPROVAL_REQUIRED`
- `BLOCKING_TYPE_OWNER_GATED`
- `ACTION_TYPE_UNSUPPORTED`
- `ACTION_STATUS_NOT_PLANNED`
- `COOLDOWN_ACTIVE`
- `QUOTA_REACHED`
- `IDEMPOTENT_ALREADY_SATISFIED`
- `INFORMATIONAL_ONLY`

## 9. Quotas and Execution Limits

Quotas are simulation admission controls in dry-run, not real execution controls.

Contract requirements:
- enforce per-cycle quotas deterministically
- default to conservative behavior
- if quota config is missing/invalid, degrade safely to stricter admission
- owner-gated actions never count as executable
- do not mark all actions eligible by default

Conservative default policy expectations:
- cap total eligible actions per cycle
- optionally cap one eligible action per gate in ambiguous cycles
- apply quotas after hard safety blocks

## 10. Cooldown and Retry Model

Dry-run must model cooldown/retry conservatively:
- repeated attempts for the same `action.id` are cooldown-controlled
- cooldown prevents thrash on unchanged blockers
- if attempt history is unavailable, do not assume unrestricted retry
- retry eligibility must not be inferred without state
- owner-gated actions do not become eligible by retry

## 11. Idempotence Rules

Idempotence requirements:
- same plan + same executor state => same dry-run decisions
- already-satisfied/duplicate actions are skippable as idempotent
- duplicate `action.id` values must not produce duplicate eligibility
- evaluation order and outputs must be deterministic under unchanged inputs

## 12. Owner-Gated Safety Rules

Mandatory rules:
- owner-gated actions are never auto-executable
- `ownerApprovalRequired === true` is a hard autonomous stop
- dry-run may report/priority-rank these actions as blocked
- dry-run must not simulate approval as satisfied without explicit approved state in inputs
- owner workflow remains external to executor

## 13. Safety Guarantees

Dry-run must guarantee:
- no mutation
- no external side effects
- no policy bypass
- no implicit threshold override
- no owner-approval bypass
- deterministic evaluation order
- safe behavior on partial/missing artifacts
- conservative fallback on ambiguity

## 14. Compatibility Rules

- This contract depends on `phaseActionPlan` contract semantics.
- Changes to consumed enums/field semantics require review.
- Additive fields are preferred over breaking changes.
- Field rename/removal requires explicit migration.
- Unknown future action types degrade to `skipped_unsupported` (or equivalent conservative decision).
- Executor implementation must not silently reinterpret legacy action types with new semantics.

## 15. Minimal Example

```json
{
  "mode": "dry_run",
  "status": "dry_run_blocked",
  "summary": "1 eligible, 1 owner-blocked, 1 informational skipped",
  "evaluatedActionCount": 3,
  "eligibleActionCount": 1,
  "blockedActionCount": 1,
  "skippedActionCount": 1,
  "results": [
    {
      "id": "data_freshness_gap",
      "type": "data_repair",
      "gate": "dataFreshness",
      "inputPriority": 2,
      "decision": "eligible",
      "reasonCode": "AUTO_FIXABLE_SUPPORTED",
      "ownerApprovalRequired": false,
      "blockingType": "auto_fixable",
      "wouldExecute": false,
      "cooldownActive": false,
      "idempotentSkip": false,
      "quotaBlocked": false,
      "notes": "Dry-run only; no execution performed"
    },
    {
      "id": "owner_approval_gap",
      "type": "owner_decision",
      "gate": "ownerApproval",
      "inputPriority": 1,
      "decision": "blocked_owner",
      "reasonCode": "OWNER_APPROVAL_REQUIRED",
      "ownerApprovalRequired": true,
      "blockingType": "owner_gated",
      "wouldExecute": false,
      "cooldownActive": false,
      "idempotentSkip": false,
      "quotaBlocked": false,
      "notes": "Owner workflow required"
    },
    {
      "id": "validation_unknown_gap",
      "type": "validation_growth",
      "gate": "validation",
      "inputPriority": 3,
      "decision": "skipped_informational",
      "reasonCode": "INFORMATIONAL_ONLY",
      "ownerApprovalRequired": false,
      "blockingType": "informational",
      "wouldExecute": false,
      "cooldownActive": false,
      "idempotentSkip": false,
      "quotaBlocked": false,
      "notes": "Grounding required before eligibility"
    }
  ],
  "generatedAt": "2026-03-26T00:00:00.000Z"
}
```

## 16. Consumer Guidance

- Dashboards must label dry-run output as simulation only.
- Orchestration layers must not equate `eligible` with `executed`.
- Real execution requires a separate execution contract.
- Owner-gated blocked actions should be surfaced clearly to operators.
- Unknown/unsupported action types should be handled conservatively.
