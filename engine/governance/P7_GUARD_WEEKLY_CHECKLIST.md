# P7 Guard V1 — Weekly Decision Checklist

**Scope**: decide objectively whether a **P7 Guard V2** is warranted, using observed runs only (no speculative tuning).

**Cadence**: weekly (recommended every Friday after latest dashboard refresh).

---

## 1) Guard Usage Volume

Source:
- `governance/p7_guard_metrics.json`

Track:
- `skipRate`
- `attenuateRate`
- `eventsConsidered` (N)

Interpretation:
- `skipRate ~= 0%` and `attenuateRate ~= 0%` -> guard likely unused; V2 likely unnecessary.
- `skipRate > 5-10%` or `attenuateRate > 15-20%` -> meaningful usage; continue analysis.

---

## 2) P7 Alert Mix

Sources:
- `governance/p7_metrics.json` (`lastAlertReason`)
- `governance_dashboard.json` (`p7Health`, `governanceAlertDigest`)

Track distribution (%):
- `low_report_coverage`
- `empty_window`
- `apply_zero_unexpected`
- `parse_errors`

Interpretation:
- Warning-dominant mix -> V2 may focus on calibration (thresholds or attenuation factor).
- Non-negligible critical share -> guard value is plausible; V2 can be justified.

---

## 3) Correlation With Governor Stability

Sources:
- `governance_dashboard.json` (`governorHealth`, `governanceAlertDigest`)
- Governor history tails if needed

For runs where guard action is `skip` or `attenuate`, track:
- `governorHealth.lastAlertReason`
- presence/frequency of `decision_flap` or `invalid_decision`

Interpretation:
- Fewer governor anomalies when guard is active -> positive value signal.
- No visible change -> guard may be too conservative or low-impact.

---

## 4) Policy Impact

Sources:
- policy metrics / dashboard fields (`policyHealth`)
- `mutation_policy.json` snapshots if deeper diff needed

Compare runs with vs without guard activity:
- `explorationWeight` / `exploitationWeight` behavior
- any `invalid_weights` / drift-related anomalies

Interpretation:
- More stable weights under guard activity -> positive signal.
- No measurable difference -> limited practical impact.

---

## 5) Global Trend Signal

Source:
- `governance_dashboard.json` (`governanceAlertDigest`)

Track:
- `recentTrend`
- `activeAlerts.length` variation

Interpretation:
- Improving trend correlated with guard usage -> V2 candidate.
- Stable/worsening trend -> revisit mapping before V2.

---

## Weekly Decision Rule (Simple)

### V2 = NO (keep V1 as-is)
- `skipRate < 5%` and `attenuateRate < 10%`
- and no observable improvement on Governor/Policy dimensions

### V2 = YES (targeted only)
- `skipRate >= 5-10%` or `attenuateRate >= 15-20%`
- and at least one concrete improvement signal
  - fewer alerts
  - fewer flaps / invalid decisions
  - more stable policy behavior

---

## Output Format (recommended)

Use one compact weekly JSON summary (manual or scripted):

```json
{
  "week": "2026-W12",
  "skipRate": 0.08,
  "attenuateRate": 0.21,
  "eventsConsidered": 84,
  "topP7Alerts": {
    "low_report_coverage": 0.6,
    "empty_window": 0.3,
    "apply_zero_unexpected": 0.1
  },
  "governorImprovement": true,
  "policyStabilityImprovement": true,
  "decision": "consider_v2"
}
```

Decision values (recommended):
- `hold_v1`
- `consider_v2`
- `v2_not_justified_yet`

Automation helper (optional, minimal):

```bash
node engine/governance/p7GuardWeeklySummary.js --days 7
```

Default output:
- `<dataRoot>/governance/p7_guard_weekly_summary.json`

---

## Notes

- Keep V2 scope bounded (single lever change, single measurable hypothesis, smoke + non-regression).
- Do not tune thresholds mid-week; evaluate only at checkpoint.
