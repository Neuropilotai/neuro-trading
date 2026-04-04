# Phase Action Plan Contract

## 1. Purpose

`phaseActionPlan` is a passive planning artifact exported by ops snapshot generation.

It is used to expose actionable progression gaps in a deterministic structure.

It is **not** an execution engine. It:
- does not execute actions
- does not alter trading/research/promotion/execution behavior
- does not change thresholds in runtime decision logic

## 2. Artifact Location

Current export location:
- top-level field in `ops-snapshot/latest.json` (`phaseActionPlan`)

Downstream availability:
- present in governance artifacts that consume `latest.json` (for example `ops-snapshot/governance_dashboard.json` currently includes it)

## 3. Top-Level Schema

| Field | Type | Required | Description |
|---|---|---:|---|
| `mode` | string | Yes | Planning mode. Current value is `passive_planning`. |
| `status` | string | Yes | Plan state derived from action mix and blockers. |
| `currentPhase` | string | Yes | Current phase label (from `phaseTracker` when available). |
| `nextPhase` | string | Yes | Next phase label (from `phaseTracker` when available). |
| `goal` | string | Yes | Unlock objective string (`unlock_<nextPhase>` or `unlock_next_phase`). |
| `summary` | string | Yes | Compact human-readable plan summary. |
| `primaryObjective` | object or null | Yes | First prioritized action object, or `null` when no action exists. |
| `autoFixable` | boolean | Yes | True when blocking actions are auto-fixable/mixed only. |
| `ownerApprovalRequired` | boolean | Yes | True when at least one action requires owner decision. |
| `recommendedActionCount` | number | Yes | Number of planned actions (`actions.length`). |
| `actions` | array | Yes | Ordered list of action objects. Max 8 in current implementation. |
| `generatedAt` | string | Yes | ISO timestamp generated during snapshot export. |

### 3.1 `phaseTracker` companion (`latest.json`)

`phaseActionPlan` is derived alongside `phaseTracker` in `ops-snapshot/latest.json`. The tracker’s **validation** gate uses `strategyValidation.summary.promotableCount` (strict **paper** `promote_candidate` tier from `governance/paper_trades.jsonl`). The **governance** gate summarizes **batch/WF promotion guard** results from promoted-children evaluation — a separate metric from the paper tier.

| Field | Type | Required | Description |
|---|---|---:|---|
| `semanticHints` | object | No | Additive, read-only strings for operator-facing clarity (`validationGate`, `governanceGate`). Omitted in older snapshots. |

## 4. Action Schema

| Field | Type | Required | Description |
|---|---|---:|---|
| `id` | string | Yes | Stable action identifier. |
| `type` | string | Yes | Action family/category. |
| `title` | string | Yes | Short operator-facing title. |
| `reasonCode` | string | Yes | Machine-readable reason code. |
| `gate` | string | Yes | Gate/domain associated with the action. |
| `priority` | number | Yes | Final deterministic priority (1 = highest urgency). |
| `blockingType` | string | Yes | Blocking model classification. |
| `ownerApprovalRequired` | boolean | Yes | Whether owner workflow is required for this action. |
| `status` | string | Yes | Action planning state. |
| `required` | number or null | Yes | Required target count/value for the gap domain. |
| `current` | number or null | Yes | Current observed count/value. |
| `missing` | number or null | Yes | Gap size to close (non-negative when numeric). |
| `unit` | string | Yes | Unit for required/current/missing. |
| `action` | string | Yes | Suggested operation label (planning-only). |
| `suggestedSteps` | string[] | Yes | Ordered, compact next steps (max 3 currently). |
| `successCondition` | string | Yes | Condition indicating action objective is met. |
| `notes` | string | Yes | Optional short annotation. Empty string when none. |

## 5. Enumerated Values

### 5.1 Plan Status

Current values emitted by implementation:
- `blocked_by_owner`
- `ready_for_auto_progress`
- `monitoring`
- `idle`
- `unknown`

### 5.2 Action Type

Current values used by implementation:
- `data_repair`
- `validation_growth`
- `promotion_growth`
- `governance_resolution`
- `owner_decision`
- `execution_recovery`
- `research_expansion` (default fallback type)

### 5.3 Blocking Type

Current values:
- `auto_fixable`
- `owner_gated`
- `mixed`
- `informational`

### 5.4 Action Status

Current values:
- `planned`
- `blocked_pending_owner`

### 5.5 Gate Names

Current values:
- `dataFreshness`
- `validation`
- `governance`
- `ownerApproval`
- `execution`
- `unknown` (default fallback gate)

## 6. Gap Semantics

`required`, `current`, and `missing` are planning-oriented operational gap fields.

Semantics:
- `required`: target value to unlock/resolve the gate condition.
- `current`: observed value from current artifacts.
- `missing`: remaining gap.

When both `required` and `current` are grounded numerics:
- `missing = max(0, required - current)`.

When exact counts are unavailable:
- `required`, `current`, and/or `missing` may be `null`.

Rules:
- `missing` must never be negative when numeric.
- `unit` must match the gap domain (for example `strategies`, `promotions`, `critical_stale_datasets`, `pending_approvals`).
- these fields are not direct trading performance metrics.

## 7. Prioritization Rules

Current deterministic priority class order:
1. owner decision blockers
2. governance blockers
3. validation blockers
4. data freshness blockers
5. promotion growth blockers
6. execution recovery blockers
7. informational / fallback actions

Tie-break rules within the same class:
1. larger numeric `missing` first (`null` treated as lowest)
2. lexical `id` ascending

Final assignment:
- actions are sorted deterministically
- `priority` is reassigned sequentially from 1
- lower `priority` number means higher urgency

## 8. Blocking Model

Action-level `blockingType`:
- `auto_fixable`: suitable for future autonomous remediation flow
- `owner_gated`: requires owner workflow/human decision
- `mixed`: remediation may involve both automated and governance/operator work
- `informational`: planning signal, not a direct blocker remediation task

Plan-level booleans:
- `ownerApprovalRequired`: true if any action has `ownerApprovalRequired === true`
- `autoFixable`: true only when all blocking actions are `auto_fixable` or `mixed`

Important:
- a plan may include both owner-gated and auto-fixable actions
- owner-gated actions must not be auto-executed without explicit owner control flow

## 9. Determinism and Stability Guarantees

Expected guarantees for consumers:
- action ordering is deterministic for the same input artifacts
- field presence is stable for documented fields
- additive evolution is preferred over breaking changes
- consumers must tolerate documented `null` values
- enum expansion is additive and requires review

`phaseActionPlan` is the planning interface boundary for future runtime integrations.

## 10. Compatibility Rules

- Existing documented fields must not be silently renamed.
- Existing field semantics must not silently drift.
- Field removal requires explicit migration coordination.
- Adding new fields is allowed when additive and backward-compatible.
- Adding enum values requires review (downstream allowlists may exist).
- `phaseActionPlan` remains planning-only unless a separate execution contract is introduced.

## 11. Non-Goals

`phaseActionPlan` does **not**:
- execute actions
- mutate pipeline state
- change strategy eligibility
- change promotion outcomes
- override governance thresholds
- replace source artifacts (validation, freshness, execution, owner queue, etc.)
- serve as source of truth for trade logic

## 12. Minimal Example

```json
{
  "phaseActionPlan": {
    "mode": "passive_planning",
    "status": "blocked_by_owner",
    "currentPhase": "validation",
    "nextPhase": "governance",
    "goal": "unlock_governance",
    "summary": "Next phase blocked by 1 pending owner approval",
    "primaryObjective": {
      "id": "owner_approval_gap",
      "type": "owner_decision",
      "title": "Obtain owner approval",
      "reasonCode": "OWNER_APPROVAL_PENDING",
      "gate": "ownerApproval",
      "priority": 1,
      "blockingType": "owner_gated",
      "ownerApprovalRequired": true,
      "status": "blocked_pending_owner",
      "required": 0,
      "current": 1,
      "missing": 1,
      "unit": "pending_approvals",
      "action": "request_owner_decision",
      "suggestedSteps": [
        "Review pending owner approval item",
        "Approve or reject the queued transition",
        "Re-export owner approval snapshot"
      ],
      "successCondition": "No owner approval required for the next phase",
      "notes": ""
    },
    "autoFixable": false,
    "ownerApprovalRequired": true,
    "recommendedActionCount": 2,
    "actions": [
      {
        "id": "owner_approval_gap",
        "type": "owner_decision",
        "title": "Obtain owner approval",
        "reasonCode": "OWNER_APPROVAL_PENDING",
        "gate": "ownerApproval",
        "priority": 1,
        "blockingType": "owner_gated",
        "ownerApprovalRequired": true,
        "status": "blocked_pending_owner",
        "required": 0,
        "current": 1,
        "missing": 1,
        "unit": "pending_approvals",
        "action": "request_owner_decision",
        "suggestedSteps": [
          "Review pending owner approval item",
          "Approve or reject the queued transition",
          "Re-export owner approval snapshot"
        ],
        "successCondition": "No owner approval required for the next phase",
        "notes": ""
      },
      {
        "id": "validation_unknown_gap",
        "type": "validation_growth",
        "title": "Review validation readiness",
        "reasonCode": "VALIDATION_READINESS_REVIEW",
        "gate": "validation",
        "priority": 2,
        "blockingType": "informational",
        "ownerApprovalRequired": false,
        "status": "planned",
        "required": null,
        "current": 0,
        "missing": null,
        "unit": "unknown",
        "action": "inspect_validation_thresholds",
        "suggestedSteps": [
          "Review validation readiness inputs",
          "Determine exact required threshold",
          "Rebuild action plan with grounded counts"
        ],
        "successCondition": "Validation threshold and current state become explicit",
        "notes": "Threshold not explicitly available in current artifacts"
      }
    ],
    "generatedAt": "2026-03-26T00:00:00.000Z"
  }
}
```

## 13. Consumer Guidance

- Dashboards should display this object without reinterpreting semantics aggressively.
- A future `progressExecutor` should only act on explicitly permitted action classes.
- Owner-gated actions require separate owner-control workflow.
- Unknown/null gap fields should be treated conservatively (no implicit auto-execution assumptions).
