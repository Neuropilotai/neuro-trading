/**
 * NeuroPilot Owner Ops — reads static JSON from ../ops-snapshot (no secrets).
 */
const DATA_PATH = "../ops-snapshot";
const REFRESH_MS = 8000;
const LS_APPROVAL_OVERLAY = "np_owner_approval_overlay_v1";
const LS_OWNER_APPROVAL_TOKEN = "np_owner_approval_api_token";
const OWNER_APPROVAL_POST_PATH = "/api/ops/owner-approval";

const STALE_DATASET_MINUTES = 360;
const AGING_DATASET_MINUTES = 120;
const BROKER_AGING_MIN = 15;
const BROKER_WATCH_MIN = 10;
const UNMATCHED_WARN_MIN = 5;

async function loadJSON(file) {
  const url = new URL(`${DATA_PATH}/${file}`, window.location.href);
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${file} (${res.status})`);
  return res.json();
}

async function loadJSONOptional(file) {
  try {
    const url = new URL(`${DATA_PATH}/${file}`, window.location.href);
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Lagging Pressure card — projection only. Uses laggingSummary + lagging_pressure alerts from snapshot JSON.
 * Does not recompute freshness, thresholds, or alerts.
 * @param {object|null|undefined} freshness - datasets_freshness.json (or latest.datasetFreshness)
 * @param {object|null|undefined} transFile - owner_transition_alerts.json
 * @returns {string} HTML fragment
 */
function renderLaggingPressureSection(freshness, transFile) {
  const disclaimer =
    '<p class="lagging-disclaimer">Lagging is non-blocking. Only degraded datasets affect execution.</p>';

  const ls =
    freshness && typeof freshness.laggingSummary === "object" && freshness.laggingSummary !== null
      ? freshness.laggingSummary
      : null;

  const laggingAlerts = (Array.isArray(transFile?.alerts) ? transFile.alerts : []).filter(
    (a) => a && String(a.code || "") === "lagging_pressure"
  );

  const chunks = [];

  if (ls && Number(ls.count) > 0) {
    const n = Number(ls.count);
    const maxL = ls.maxLagMinutes;
    const wk = ls.worstKey != null ? String(ls.worstKey) : "—";
    const ratioPct = Number.isFinite(Number(ls.worstRatio)) ? Math.round(Number(ls.worstRatio) * 100) : null;
    const keysTop = Array.isArray(ls.keys) ? ls.keys.slice(0, 3) : [];
    let block = '<div class="lagging-summary-block"><p class="lagging-summary"><strong>Summary</strong> (datasets_freshness.laggingSummary)</p><ul class="lagging-metrics">';
    block += `<li>Count: <strong>${escapeHtml(String(n))}</strong></li>`;
    block += `<li>Max lag: ${
      maxL != null && Number.isFinite(Number(maxL))
        ? `<strong>${escapeHtml(String(maxL))} min</strong>`
        : "—"
    }</li>`;
    block += `<li>Worst key: <code>${escapeHtml(wk)}</code></li>`;
    if (ratioPct != null) {
      block += `<li>Ratio (worst vs degraded threshold): <strong>${escapeHtml(String(ratioPct))}%</strong></li>`;
    }
    if (keysTop.length) {
      block += `<li>Keys (up to 3): ${keysTop
        .map((k) => `<code>${escapeHtml(String(k))}</code>`)
        .join(", ")}</li>`;
    }
    block += "</ul></div>";
    chunks.push(block);
  }

  if (laggingAlerts.length > 0) {
    chunks.push(
      '<div class="lagging-alert-wrap"><p class="lagging-badge">WARN</p><p class="lagging-alert-label">Transition alerts (owner_transition_alerts.json)</p><ul class="lagging-alert-list">' +
        laggingAlerts
          .map((a) => {
            const msg = a.message != null ? String(a.message) : "";
            return `<li class="lagging-alert-item">${escapeHtml(msg)}</li>`;
          })
          .join("") +
        "</ul></div>"
    );
  }

  if (chunks.length > 0) {
    return chunks.join("") + disclaimer;
  }

  if (freshness == null && transFile == null) {
    return '<p class="muted">No data available.</p>' + disclaimer;
  }

  if (ls && Number(ls.count) === 0 && laggingAlerts.length === 0) {
    return '<p class="lagging-neutral">No lagging datasets.</p>' + disclaimer;
  }

  if (!ls && laggingAlerts.length === 0) {
    return '<p class="muted">No lagging summary or lagging_pressure alerts in snapshot.</p>' + disclaimer;
  }

  return '<p class="muted">No lagging pressure to display.</p>' + disclaimer;
}

function fmtET(iso) {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d) + " ET"
  );
}

/** Raw max age across all manifest rows (truth on disk). */
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
 * Threshold age for owner stale/aging (uses export freshnessContext when present).
 * SYNC: Must match engine/execution/ownerFreshnessEffectiveAge.js — ownerStaleAgeForThreshold (browser copy).
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

function normalizeSeverity(s) {
  const x = String(s || "").toLowerCase();
  if (x === "crit" || x === "critical") return "crit";
  if (x === "warn" || x === "warning") return "warn";
  return "info";
}

/**
 * @returns {{ severity: string, code: string, message: string, source: string }[]}
 */
function buildPersistentConditions(exec, health, freshness) {
  const out = [];
  if (!exec || typeof exec !== "object") {
    out.push({
      severity: "crit",
      code: "ops_snapshot_missing",
      message: "Execution snapshot missing — run exportOpsSnapshot now.",
      source: "persistent",
    });
    return out;
  }

  if (exec.reconciliationDegraded === true) {
    out.push({
      severity: "crit",
      code: "reconciliation_degraded",
      message: "Reconciliation is degraded — review broker read and reconcile logs.",
      source: "persistent",
    });
  }

  if (health && health.staleDataHardFail === true) {
    out.push({
      severity: "crit",
      code: "stale_data_hard_fail",
      message: "Stale data hard fail flagged in run health — refresh data pipeline.",
      source: "persistent",
    });
  }

  const rawMax = rawMaxDatasetAgeMinutes(freshness);
  const ownerAge = ownerStaleAgeForThreshold(freshness);
  if (ownerAge != null && ownerAge > STALE_DATASET_MINUTES) {
    out.push({
      severity: "crit",
      code: "market_data_stale",
      message:
        rawMax != null && Math.round(rawMax) > Math.round(ownerAge)
          ? `Market data stale (open/unknown oldest ~${Math.round(ownerAge)} min; raw oldest ~${Math.round(rawMax)} min).`
          : `Market data stale (oldest dataset ~${Math.round(ownerAge)} min).`,
      source: "persistent",
    });
  } else if (ownerAge != null && ownerAge > AGING_DATASET_MINUTES) {
    out.push({
      severity: "warn",
      code: "market_data_aging",
      message: `Market data aging (oldest dataset ~${Math.round(ownerAge)} min).`,
      source: "persistent",
    });
  }

  const um = Number(exec.unmatchedFillsCount) || 0;
  if (um >= UNMATCHED_WARN_MIN) {
    out.push({
      severity: "warn",
      code: "unmatched_fills_elevated",
      message: `Unmatched fills elevated (${um}) — confirm matching and signal keys.`,
      source: "persistent",
    });
  }

  const brokerAge = Number(exec.brokerSnapshotAgeMinutes);
  if (Number.isFinite(brokerAge) && brokerAge >= BROKER_AGING_MIN && exec.reconciliationHealthy !== true) {
    out.push({
      severity: "warn",
      code: "execution_reconcile_stale",
      message: `Last broker reconciliation ~${brokerAge} min ago; health not OK.`,
      source: "persistent",
    });
  }

  const driftN = Number(exec.driftFlagsCount) || 0;
  if (driftN > 0) {
    out.push({
      severity: "warn",
      code: "drift_flags_present",
      message: `${driftN} drift flag(s) active on book — review governance.`,
      source: "persistent",
    });
  }

  const consec = Number(exec.reconciliationConsecutiveFailures) || 0;
  if (consec >= 3) {
    out.push({
      severity: "crit",
      code: "reconciliation_failures",
      message: `Reconciliation consecutive failures: ${consec}.`,
      source: "persistent",
    });
  }

  return out;
}

const SEV_RANK = { crit: 3, warn: 2, info: 1 };

function mergeAlerts(persistent, transitions) {
  const map = new Map();
  function upsert(a, kind) {
    const code = a.code || "unknown";
    const sev = normalizeSeverity(a.severity);
    const existing = map.get(code);
    const msg = a.message != null ? String(a.message) : "";
    if (!existing) {
      map.set(code, {
        severity: sev,
        code,
        message: msg,
        sources: new Set([kind]),
      });
      return;
    }
    if (SEV_RANK[sev] > SEV_RANK[existing.severity]) {
      existing.severity = sev;
      if (msg) existing.message = msg;
    }
    existing.sources.add(kind);
  }
  for (const p of persistent) upsert(p, "condition");
  for (const t of transitions) {
    if (!t || typeof t !== "object") continue;
    upsert(
      {
        severity: t.severity || t.level,
        code: t.code,
        message: t.message,
      },
      "transition"
    );
  }

  const rows = [];
  for (const v of map.values()) {
    let source = [...v.sources].join(" + ");
    if (v.sources.has("transition") && v.sources.has("condition")) source = "condition + transition";
    rows.push({
      severity: v.severity,
      code: v.code,
      message: v.message,
      source,
    });
  }
  rows.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.code.localeCompare(b.code));
  return rows;
}

function countBySeverity(rows) {
  let crit = 0;
  let warn = 0;
  let info = 0;
  for (const r of rows) {
    if (r.severity === "crit") crit++;
    else if (r.severity === "warn") warn++;
    else info++;
  }
  return { crit, warn, info, total: rows.length };
}

/**
 * Headline / pill / executive copy: align with reconciliation + snapshot + stale,
 * then max() with transition+persistent alert severity so drift/unmatched etc. still lift the pill.
 */
function deriveOperationalHeadlineLevel(exec, health, freshness) {
  if (!exec || typeof exec !== "object") return "CRITICAL";
  const ownerAge = ownerStaleAgeForThreshold(freshness);
  if (health && health.staleDataHardFail === true) return "CRITICAL";
  if (ownerAge != null && ownerAge > STALE_DATASET_MINUTES) return "CRITICAL";
  if (exec.reconciliationDegraded === true || (Number(exec.reconciliationConsecutiveFailures) || 0) >= 3) {
    return "CRITICAL";
  }
  if (exec.reconciliationHealthy !== true) return "DEGRADED";
  const bAge = Number(exec.brokerSnapshotAgeMinutes);
  const brokerStale = Number.isFinite(bAge) && bAge >= BROKER_AGING_MIN;
  if (brokerStale || (ownerAge != null && ownerAge > AGING_DATASET_MINUTES)) return "DEGRADED";
  return "HEALTHY";
}

function alertSeverityLevelFromMerged(merged) {
  const { crit, warn } = countBySeverity(merged);
  if (crit > 0) return "CRITICAL";
  if (warn > 0) return "DEGRADED";
  return "HEALTHY";
}

function levelRank(level) {
  if (level === "CRITICAL") return 3;
  if (level === "DEGRADED") return 2;
  if (level === "WATCH") return 1;
  return 0;
}

function maxHeadlineLevel(a, b) {
  return levelRank(a) >= levelRank(b) ? a : b;
}

function combineHeadlineLevel(opLevel, alertLevel, watchSignals) {
  const base = maxHeadlineLevel(opLevel, alertLevel);
  if (base === "HEALTHY" && watchSignals) return "WATCH";
  return base;
}

/**
 * Single headline source: operational reality (recon / snapshot / freshness) + alert feed, with hard guard
 * so the pill/summary never reads healthier than `deriveOperationalHeadlineLevel`.
 */
function deriveUnifiedHeadline(exec, health, freshness, mergedAlerts, watchSignals) {
  const opLevel = deriveOperationalHeadlineLevel(exec, health, freshness);
  const alertLevel = alertSeverityLevelFromMerged(mergedAlerts);
  let level = combineHeadlineLevel(opLevel, alertLevel, watchSignals);
  if (opLevel === "CRITICAL") level = "CRITICAL";
  else if (opLevel === "DEGRADED" && level === "HEALTHY") level = "DEGRADED";
  return level;
}

function buildExecutiveSummary({ level }) {
  switch (level) {
    case "CRITICAL":
      return "Critical operational issues detected. Immediate validation of reconciliation, data freshness, or snapshot integrity required.";
    case "DEGRADED":
      return "System is operational but degraded. Some core conditions (reconciliation, freshness, or broker state) are not optimal.";
    case "WATCH":
      return "System is stable but requires monitoring. Early signals or transitions detected.";
    default:
      return "System operating within expected parameters.";
  }
}

function buildBusinessImpact({ level }) {
  switch (level) {
    case "CRITICAL":
      return "Operational integrity is at risk. Decisions based on current data may be unreliable.";
    case "DEGRADED":
      return "System reliability is reduced. Some execution or data conditions may affect decision quality.";
    case "WATCH":
      return "No immediate impact, but conditions should be monitored.";
    default:
      return "No material operational impact detected.";
  }
}

/** When feed has no rows but headline is not nominal — kills “0 alerts = all clear”. */
function formatActiveAlertsKPI(total, crit, warn, info, headlineLevel) {
  if (total === 0 && headlineLevel !== "HEALTHY") {
    return {
      value: "0*",
      sub: "No alert rows in feed; headline reflects operational state (recon / snapshot / freshness)",
    };
  }
  return {
    value: String(total),
    sub: `${crit} crit / ${warn} warn / ${info} info`,
  };
}

function recommendedActionsFor(rows, crit, warn, headlineLevel) {
  const codes = new Set(rows.map((r) => r.code));
  const lines = [];

  if (crit > 0) {
    lines.push("Validate latest execution_status.json and ops snapshot export.");
    lines.push("Run exportOpsSnapshot and reload this dashboard.");
    if (codes.has("reconciliation_degraded") || codes.has("reconciliation_failures")) {
      lines.push("Review reconciliation drift and broker connectivity.");
    }
    if (codes.has("stale_data_hard_fail") || codes.has("market_data_stale")) {
      lines.push("Confirm data pipeline freshness and manifest last candle times.");
    }
    if (codes.has("ops_snapshot_missing")) {
      lines.push("Regenerate ops snapshot from the trading v2 root before proceeding.");
    }
    lines.push("Check webhook / notification path if you rely on ops alert CLI.");
    lines.push("Escalate if unresolved on the next scheduled run.");
  } else if (headlineLevel === "CRITICAL") {
    lines.push("Critical KPI state without matching feed rows — inspect execution_status.json, run_health.json, and datasets_freshness.");
    lines.push("Run exportOpsSnapshot from the trading v2 root and re-open this dashboard.");
    lines.push("Escalate if snapshot, reconciliation, or stale-data signals persist.");
  } else if (warn > 0) {
    lines.push("Review warning trend — transient vs persistent.");
    lines.push("Watch the next snapshot transition after export.");
    if (codes.has("drift_flag_new") || codes.has("drift_flags_present")) {
      lines.push("Review governance and drift flags on the book.");
    }
    if (codes.has("unmatched_fills_increase") || codes.has("unmatched_fills_elevated")) {
      lines.push("Confirm whether unmatched fills are structural or one-off.");
    }
    lines.push("Validate ops alert checkpoint logic if warnings repeat.");
  } else if (headlineLevel === "DEGRADED") {
    lines.push("Reconciliation or freshness KPIs are not nominal — confirm expected mode (live vs paper / credentials).");
    lines.push("If this is unexpected, review broker connectivity and last reconcile time on the breakdown panel.");
    lines.push("Schedule or verify ops alerts CLI against the same snapshot directory.");
  } else if (headlineLevel === "WATCH") {
    lines.push("Monitor the next snapshot export and checkpoint transitions.");
    lines.push("Confirm dataset ages stay within your SLO if you rely on near-live bars.");
  } else {
    lines.push("No action required — continue monitoring.");
  }

  return lines;
}

function reconciliationCard(exec) {
  if (!exec) {
    return { value: "FAILING", sub: "No execution snapshot", cls: "kpi-val-bad" };
  }
  if (exec.reconciliationDegraded === true || (Number(exec.reconciliationConsecutiveFailures) || 0) >= 3) {
    return {
      value: "FAILING",
      sub: "Critical: reconciliation degraded or repeated failures",
      cls: "kpi-val-bad",
    };
  }
  if (exec.reconciliationHealthy === true) {
    return { value: "OK", sub: "Matched fills stable", cls: "kpi-val-ok" };
  }
  return {
    value: "DEGRADED",
    sub: "Degraded: review last reconcile time and unmatched fills",
    cls: "kpi-val-warn",
  };
}

function freshnessCard(exec, health, freshness) {
  if (!exec) {
    return { value: "Stale", sub: "Missing execution snapshot", cls: "kpi-val-bad" };
  }
  if (health && health.staleDataHardFail === true) {
    return { value: "Stale", sub: "Critical: stale_data_hard_fail", cls: "kpi-val-bad" };
  }
  const rawMax = rawMaxDatasetAgeMinutes(freshness);
  const ownerAge = ownerStaleAgeForThreshold(freshness);
  if (ownerAge != null && ownerAge > STALE_DATASET_MINUTES) {
    return {
      value: "Stale",
      sub:
        rawMax != null && Math.round(rawMax) > Math.round(ownerAge)
          ? `Open/unknown oldest ~${Math.round(ownerAge)} min (raw ~${Math.round(rawMax)} min)`
          : `Oldest market dataset ~${Math.round(ownerAge)} min`,
      cls: "kpi-val-bad",
    };
  }
  if (
    rawMax != null &&
    ownerAge != null &&
    rawMax > STALE_DATASET_MINUTES &&
    ownerAge <= STALE_DATASET_MINUTES &&
    freshness &&
    freshness.freshnessContext &&
    freshness.freshnessContext.staleSuppressedForClosedSession === true
  ) {
    const why = freshness.freshnessContext.staleSuppressedReason || "closed_anticipated_sessions";
    return {
      value: "Fresh",
      sub: `Session-adjusted OK — raw oldest ~${Math.round(rawMax)} min (${why})`,
      cls: "kpi-val-ok",
    };
  }
  const bAge = Number(exec.brokerSnapshotAgeMinutes);
  const brokerStale = Number.isFinite(bAge) && bAge >= BROKER_AGING_MIN;
  if (brokerStale || (ownerAge != null && ownerAge > AGING_DATASET_MINUTES)) {
    const parts = [];
    if (brokerStale) parts.push(`Execution data ~${Math.round(bAge)} min`);
    if (ownerAge != null && ownerAge > AGING_DATASET_MINUTES) {
      parts.push(`Market data up to ~${Math.round(ownerAge)} min`);
    }
    return { value: "Aging", sub: parts.join(" · "), cls: "kpi-val-warn" };
  }
  const gen = exec.generatedAt ? fmtET(exec.generatedAt) : "—";
  return {
    value: "Fresh",
    sub: `Last refresh ${gen}`,
    cls: "kpi-val-ok",
  };
}

function driftCard(exec, transitionCodes) {
  const hasNew = transitionCodes.has("drift_flag_new");
  const n = exec ? Number(exec.driftFlagsCount) || 0 : 0;
  if (hasNew) {
    return {
      value: "New Drift",
      sub: "Warning: new drift flag vs checkpoint",
      cls: "kpi-val-warn",
    };
  }
  if (n > 0) {
    return {
      value: "Elevated",
      sub: `${n} drift flag(s) on book`,
      cls: "kpi-val-warn",
    };
  }
  return { value: "Stable", sub: "No drift flags", cls: "kpi-val-ok" };
}

function decisionActionLine(status) {
  if (status === "CRITICAL") {
    return "<strong>Recommended action:</strong> open the incident checklist and validate data + execution pipeline now.";
  }
  if (status === "DEGRADED") {
    return "<strong>Recommended action:</strong> review warnings and confirm the trend does not worsen.";
  }
  if (status === "WATCH") {
    return "<strong>Recommended action:</strong> continue monitoring; light signals present.";
  }
  return "<strong>Recommended action:</strong> continue monitoring.";
}

function setPill(status, derivedState) {
  const el = document.getElementById("overallPill");
  if (!el) return;
  el.textContent = status;
  el.className = "status-pill " + status.toLowerCase();
  if (derivedState) el.classList.add("derived-state");
}

function setKpiValue(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = "kpi-value sm " + (cls || "kpi-val-neutral");
}

function renderAlertsTable(rows, generatedAt) {
  const tbody = document.getElementById("alertsTbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty-feed">No active operational conditions in this view.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const sev = r.severity;
      const sevClass = sev === "crit" ? "sev-crit" : sev === "warn" ? "sev-warn" : "sev-info";
      const sevLabel = sev === "crit" ? "CRIT" : sev === "warn" ? "WARN" : "INFO";
      const status =
        r.source && r.source.includes("transition") ? "New" : "Active";
      const action =
        sev === "crit"
          ? "Open runbook"
          : sev === "warn"
            ? "Review"
            : "Monitor";
      const seen = generatedAt ? escapeHtml(fmtET(generatedAt)) : "—";
      return `<tr>
        <td class="${sevClass}">${escapeHtml(sevLabel)}</td>
        <td><code>${escapeHtml(r.code)}</code></td>
        <td>${escapeHtml(r.message)}</td>
        <td>${escapeHtml(r.source)}</td>
        <td>${seen}</td>
        <td>${seen}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(action)}</td>
      </tr>`;
    })
    .join("");
}

function renderList(id, items) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = items.map((t) => `<li>${t}</li>`).join("");
}

function readApprovalOverlay() {
  try {
    const raw = localStorage.getItem(LS_APPROVAL_OVERLAY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function writeApprovalOverlay(obj) {
  localStorage.setItem(LS_APPROVAL_OVERLAY, JSON.stringify(obj));
}

function effectiveApprovalStatus(item, overlay, serverDecisions) {
  const o = overlay[item.id];
  if (o && o.status) return String(o.status);
  const row = serverDecisions && serverDecisions[item.id];
  if (row && row.status) return String(row.status);
  return item.status ? String(item.status) : "pending";
}

async function postOwnerApprovalDecision(id, action) {
  if (typeof window === "undefined") return { ok: false, reason: "no window" };
  if (window.location.protocol === "file:") return { ok: false, reason: "file:// (use HTTP server + API or CLI)" };
  try {
    const token = localStorage.getItem(LS_OWNER_APPROVAL_TOKEN);
    const headers = { "Content-Type": "application/json" };
    if (token && String(token).trim()) {
      headers["X-NeuroPilot-Approval-Token"] = String(token).trim();
    }
    const url = new URL(OWNER_APPROVAL_POST_PATH, window.location.origin).toString();
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ id, action }),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : "network" };
  }
}

function approvalStatusLabel(s) {
  const m = {
    pending: "Pending owner decision",
    approved: "Approved for next run",
    passed: "Passed by owner",
    snoozed: "Deferred",
    blocked: "Blocked",
    need_more_info: "Need more info",
    executed: "Executed",
    expired: "Expired",
  };
  return m[s] || s;
}

function buildApprovalSummaryLine(merged) {
  const need = merged.filter((i) =>
    ["pending", "need_more_info"].includes(i._effective)
  ).length;
  const approved = merged.filter((i) => i._effective === "approved").length;
  if (need > 0) return `${need} recommendation(s) require owner decision.`;
  if (approved > 0) return `${approved} recommendation(s) approved for next run.`;
  return "No owner approval pending.";
}

function approvalPriorityClass(priority) {
  if (priority === "critical") return "critical";
  if (priority === "warn") return "warn";
  return "info";
}

function renderOneApprovalCard(item) {
  const pri = approvalPriorityClass(item.priority);
  const type = String(item.type || "research").toLowerCase();
  const title = escapeHtml(item.title || item.id || "—");
  const reason = escapeHtml(item.reason || "—");
  const impact = escapeHtml(item.impact || "—");
  const confidence = escapeHtml(item.confidence || "—");
  const st = item._effective;
  const stExtra =
    st === "approved"
      ? "status-approved"
      : st === "passed" || st === "blocked"
        ? "status-passed"
        : "";
  const codes = Array.isArray(item.sourceCodes)
    ? item.sourceCodes.map((c) => `<code>${escapeHtml(String(c))}</code>`).join(" ")
    : "—";
  const priLabel = escapeHtml(String(item.priority || "info").toUpperCase());
  const typeLabel = escapeHtml(type);

  return `<article class="approval-card priority-${pri}" data-rec-id="${escapeHtml(item.id)}">
    <div class="approval-card-head">
      <h3 class="approval-card-title">${title}</h3>
      <div class="approval-badges">
        <span class="approval-badge">${priLabel}</span>
        <span class="approval-badge type-${escapeHtml(type)}">${typeLabel}</span>
      </div>
    </div>
    <div class="approval-meta"><strong>Reason:</strong> ${reason}</div>
    <div class="approval-meta"><strong>Impact:</strong> ${impact} · <strong>Confidence:</strong> ${confidence}</div>
    <div class="approval-meta"><strong>Source codes:</strong> ${codes}</div>
    <div class="approval-status-line ${stExtra}"><strong>Status:</strong> ${escapeHtml(
      approvalStatusLabel(st)
    )}</div>
    <div class="approval-card-actions">
      <button type="button" class="btn-primary" data-action="approved">Approve for next run</button>
      <button type="button" data-action="passed">Pass</button>
      <button type="button" data-action="snoozed">Snooze</button>
      <button type="button" data-action="need_more_info">Need more info</button>
      <button type="button" class="btn-danger" data-action="blocked">Block</button>
    </div>
  </article>`;
}

/**
 * @param {object | null | undefined} summary from owner_approval_summary.json
 * @returns {"UNKNOWN" | "ACTION_REQUIRED" | "BLOCKED" | "CLEAR"}
 */
function deriveApprovalHealth(summary) {
  if (!summary || typeof summary !== "object") return "UNKNOWN";
  const pending = Number(summary.pending) || 0;
  const blocked = Number(summary.blocked) || 0;
  if (blocked > 0) return "BLOCKED";
  if (pending > 0) return "ACTION_REQUIRED";
  return "CLEAR";
}

function renderApprovalCenter(queuePayload, serverDecisions, exportedSummary) {
  const items = Array.isArray(queuePayload?.items) ? queuePayload.items : [];
  const decisions =
    serverDecisions && typeof serverDecisions === "object" && serverDecisions !== null
      ? serverDecisions
      : {};
  const overlay = readApprovalOverlay();
  const merged = items.map((item) => ({
    ...item,
    _effective: effectiveApprovalStatus(item, overlay, decisions),
  }));

  const needDecision = merged.filter((i) =>
    ["pending", "need_more_info"].includes(i._effective)
  ).length;
  const approved = merged.filter((i) => i._effective === "approved").length;
  const closed = merged.filter((i) =>
    ["passed", "blocked", "snoozed"].includes(i._effective)
  ).length;

  const kpP = document.getElementById("approvalKpiPending");
  const kpA = document.getElementById("approvalKpiApproved");
  const kpC = document.getElementById("approvalKpiClosed");
  if (kpP) kpP.textContent = String(needDecision);
  if (kpA) kpA.textContent = String(approved);
  if (kpC) kpC.textContent = String(closed);

  const sumEl = document.getElementById("approvalSummaryLine");
  if (sumEl) sumEl.textContent = buildApprovalSummaryLine(merged);

  const snapSumEl = document.getElementById("approvalSnapshotSummary");
  if (snapSumEl) {
    if (exportedSummary && typeof exportedSummary === "object") {
      const p = Number(exportedSummary.pending) || 0;
      const ap = Number(exportedSummary.approved) || 0;
      const bl = Number(exportedSummary.blocked) || 0;
      const last = exportedSummary.lastDecisionAt != null ? fmtET(exportedSummary.lastDecisionAt) : "—";
      snapSumEl.textContent = `Exported owner_approval_summary.json — pending ${p} · approved ${ap} · blocked ${bl} · last decision ${last}`;
    } else {
      snapSumEl.textContent =
        "No owner_approval_summary.json in snapshot — run exportOpsSnapshot to refresh KPIs.";
    }
  }

  const health = deriveApprovalHealth(exportedSummary);
  const pill = document.getElementById("approvalHealthPill");
  if (pill) {
    pill.textContent = health.replace(/_/g, " ");
    pill.className =
      "approval-health-pill " +
      (health === "CLEAR"
        ? "health-clear"
        : health === "ACTION_REQUIRED"
          ? "health-action"
          : health === "BLOCKED"
            ? "health-blocked"
            : "health-unknown");
  }

  const box = document.getElementById("approvalCards");
  if (!box) return;

  if (!merged.length) {
    box.innerHTML =
      '<div class="approval-empty">No recommendations in queue. Export snapshot after conditions change, or operational signals are clear.</div>';
    return;
  }

  box.innerHTML = merged.map(renderOneApprovalCard).join("");
}

function wireApprovalCenterActions() {
  const box = document.getElementById("approvalCards");
  if (box && !box.dataset.wired) {
    box.dataset.wired = "1";
    box.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const card = btn.closest(".approval-card");
      const id = card && card.getAttribute("data-rec-id");
      const action = btn.getAttribute("data-action");
      if (!id || !action) return;
      const apiSt = document.getElementById("approvalApiStatus");
      if (apiSt) apiSt.textContent = "Saving…";
      void (async () => {
        const result = await postOwnerApprovalDecision(id, action);
        const overlay = readApprovalOverlay();
        if (result.ok) {
          delete overlay[id];
          writeApprovalOverlay(overlay);
          if (apiSt) {
            apiSt.textContent =
              "Recorded in owner_approval_state.json + history (server writeback).";
          }
        } else {
          overlay[id] = { status: action, updatedAt: new Date().toISOString() };
          writeApprovalOverlay(overlay);
          if (apiSt) {
            apiSt.textContent = `Server write failed (${result.reason}) — browser only. CLI: npm run ops:owner-approval -- record ${id} ${action}`;
          }
        }
        await refreshOwnerDashboard();
      })();
    });
  }

  const resetBtn = document.getElementById("approvalResetLocal");
  if (resetBtn && !resetBtn.dataset.wired) {
    resetBtn.dataset.wired = "1";
    resetBtn.addEventListener("click", () => {
      localStorage.removeItem(LS_APPROVAL_OVERLAY);
      refreshOwnerDashboard();
    });
  }
}

async function refreshOwnerDashboard() {
  const statusEl = document.getElementById("loadStatus");
  try {
    statusEl.textContent = "Refreshing…";
    statusEl.className = "status-bar";

    const [
      exec,
      latest,
      freshnessFile,
      health,
      transFile,
      approvalQueue,
      approvalStateJson,
      ownerApprovalSummary,
    ] = await Promise.all([
      loadJSONOptional("execution_status.json"),
      loadJSONOptional("latest.json"),
      loadJSONOptional("datasets_freshness.json"),
      loadJSONOptional("run_health.json"),
      loadJSONOptional("owner_transition_alerts.json"),
      loadJSONOptional("owner_approval_queue.json"),
      loadJSONOptional("owner_approval_state.json"),
      loadJSONOptional("owner_approval_summary.json"),
    ]);

    const approvalServerDecisions =
      approvalStateJson &&
      approvalStateJson.decisions &&
      typeof approvalStateJson.decisions === "object"
        ? approvalStateJson.decisions
        : {};

    const freshness = freshnessFile || latest?.datasetFreshness || null;
    const transitions = Array.isArray(transFile?.alerts) ? transFile.alerts : [];
    const baselineOnly = Boolean(transFile?.baselineOnly);

    let persistent = buildPersistentConditions(exec, health, freshness);
    if (transitions.some((t) => t && t.code === "drift_flag_new")) {
      persistent = persistent.filter((p) => p.code !== "drift_flags_present");
    }
    const merged = mergeAlerts(persistent, transitions);
    const { crit, warn, info, total } = countBySeverity(merged);

    const transitionCodes = new Set(transitions.map((t) => t && t.code).filter(Boolean));

    const rawM = rawMaxDatasetAgeMinutes(freshness);
    const ownerA = ownerStaleAgeForThreshold(freshness);
    const bAge = exec ? Number(exec.brokerSnapshotAgeMinutes) : NaN;
    const watchSignals =
      baselineOnly ||
      (Number.isFinite(bAge) && bAge >= BROKER_WATCH_MIN && exec.reconciliationHealthy === true) ||
      (ownerA != null && ownerA > 60 && ownerA <= STALE_DATASET_MINUTES);

    const overall = deriveUnifiedHeadline(exec, health, freshness, merged, watchSignals);
    const derivedPill =
      crit === 0 && warn === 0 && overall !== "HEALTHY";

    const snapTs = latest?.generatedAt || exec?.generatedAt || transFile?.generatedAt || null;
    document.getElementById("lastUpdated").textContent = fmtET(new Date().toISOString());
    document.getElementById("environmentLabel").textContent = exec
      ? `OANDA ${String(exec.oandaEnv || "—")} (snapshot)`
      : "—";

    setPill(overall, derivedPill);

    const alertsKpi = formatActiveAlertsKPI(total, crit, warn, info, overall);
    const kpiAlertsEl = document.getElementById("kpiAlertsTotal");
    const kpiAlertsSubEl = document.getElementById("kpiAlertsSub");
    if (kpiAlertsEl) {
      kpiAlertsEl.textContent = alertsKpi.value;
      kpiAlertsEl.className = "kpi-value" + (alertsKpi.value === "0*" ? " kpi-value-footnote" : "");
    }
    if (kpiAlertsSubEl) kpiAlertsSubEl.textContent = alertsKpi.sub;

    const rc = reconciliationCard(exec);
    setKpiValue("kpiRecon", rc.value, rc.cls);
    document.getElementById("kpiReconSub").textContent = rc.sub;

    const fc = freshnessCard(exec, health, freshness);
    setKpiValue("kpiFresh", fc.value, fc.cls);
    document.getElementById("kpiFreshSub").textContent = fc.sub;

    const dc = driftCard(exec, transitionCodes);
    setKpiValue("kpiDrift", dc.value, dc.cls);
    document.getElementById("kpiDriftSub").textContent = dc.sub;

    if (exec) {
      document.getElementById("kpiSnap").textContent = fmtET(exec.generatedAt);
      const transPart =
        transitions.length > 0
          ? `${transitions.length} new transition(s) vs checkpoint · `
          : baselineOnly
            ? "Checkpoint baseline (no prior compare) · "
            : "";
      document.getElementById("kpiSnapSub").textContent =
        transPart + "Snapshot loaded successfully";
    } else {
      document.getElementById("kpiSnap").textContent = "Missing";
      document.getElementById("kpiSnapSub").textContent = "Missing execution_status.json";
    }

    const pipeTs = latest?.ts || latest?.generatedAt;
    const pipeHint = pipeTs
      ? `Evolution run: ${fmtET(pipeTs)}`
      : "No latest.json — run export after pipeline";
    const snapAgeEl = document.getElementById("snapshotAgeLine");
    if (snapAgeEl) {
      const base = snapTs
        ? `${fmtET(snapTs)} (~${Math.round((Date.now() - new Date(snapTs).getTime()) / 60000)} min ago)`
        : "—";
      snapAgeEl.textContent = `${base} · ${pipeHint}`;
    }

    const execSummary = buildExecutiveSummary({ level: overall });
    document.getElementById("decisionBody").textContent = execSummary;
    document.getElementById("decisionAction").innerHTML = decisionActionLine(overall);

    const laggingBody = document.getElementById("laggingPressureBody");
    if (laggingBody) {
      laggingBody.innerHTML = renderLaggingPressureSection(freshness, transFile);
    }

    renderAlertsTable(merged, snapTs);

    renderApprovalCenter(approvalQueue, approvalServerDecisions, ownerApprovalSummary);
    wireApprovalCenterActions();

    const impact = buildBusinessImpact({ level: overall });
    document.getElementById("businessImpact").textContent = impact;

    const recs = recommendedActionsFor(merged, crit, warn, overall);
    document.getElementById("recommendedActions").innerHTML = `<ul>${recs
      .map((x) => `<li>${escapeHtml(x)}</li>`)
      .join("")}</ul>`;

    const matched = exec ? Number(exec.matchedFillsCount) || 0 : 0;
    const unmatched = exec ? Number(exec.unmatchedFillsCount) || 0 : 0;
    const denom = matched + unmatched;
    const rate = denom > 0 ? Math.round((100 * matched) / denom) : null;

    const execItems = [
      `Execution snapshot present: ${exec ? "Yes" : "No"}`,
      `Last execution update: ${exec?.generatedAt ? fmtET(exec.generatedAt) : "—"}`,
      `Execution state: ${
        !exec ? "Missing" : exec.reconciliationHealthy === true ? "Healthy" : "Delayed / degraded"
      }`,
      `Failed executions (proxy: recon consecutive failures): ${exec ? Number(exec.reconciliationConsecutiveFailures) || 0 : "—"}`,
      `Unmatched fills: ${exec ? unmatched : "—"}`,
      `Execution anomaly trend: ${exec ? "See unmatched + recon failures" : "—"}`,
    ];

    const reconItems = [
      `Reconciliation status: ${rc.value === "OK" ? "Healthy" : rc.value === "DEGRADED" ? "Degraded" : "Critical"}`,
      `Matched fills rate: ${rate != null ? `${rate}%` : "—"}`,
      `Unmatched fills delta vs previous: — (export checkpoint in ops_alert_checkpoint.json)`,
      `Trend: ${exec && exec.reconciliationHealthy ? "Stable" : "Worsening / review"}`,
    ];

    const dataItems = [
      `Market data last updated: ${freshness?.generatedAt ? fmtET(freshness.generatedAt) : "—"}`,
      `Execution data last updated: ${exec?.lastReconciledAt ? fmtET(exec.lastReconciledAt) : "—"}`,
      `Freshness age (datasets): ${
        rawM != null
          ? `raw ~${Math.round(rawM)} min oldest${
              ownerA != null && Math.round(ownerA) !== Math.round(rawM)
                ? ` · session-adjusted ~${Math.round(ownerA)} min`
                : ""
            }`
          : "—"
      }`,
      `Status: ${fc.value} (${fc.sub})`,
    ];

    const driftItems = [
      `New drift flag (transition): ${transitionCodes.has("drift_flag_new") ? "Yes" : "No"}`,
      `Governance snapshot age: — (see governance dashboard export)`,
      `Strategy regime stable: ${latest?.marketRegime != null ? `Last: ${latest.marketRegime}` : "—"}`,
      `Requires review: ${warn + crit > 0 ? "Yes" : "No"}`,
    ];

    renderList("execList", execItems);
    renderList("reconList", reconItems);
    renderList("dataList", dataItems);
    renderList("driftGovList", driftItems);

    statusEl.textContent = "OK — owner view synced";
    statusEl.className = "status-bar";
  } catch (e) {
    statusEl.textContent = `ERROR — ${e && e.message ? e.message : e}`;
    statusEl.className = "status-bar error";
  }
}

document.getElementById("refreshBtn")?.addEventListener("click", refreshOwnerDashboard);
wireApprovalCenterActions();
refreshOwnerDashboard();
setInterval(refreshOwnerDashboard, REFRESH_MS);
