const DATA_PATH = "../ops-snapshot";
const REFRESH_MS = 5000;
/** Max points for sparkline (matches export default trend window order of magnitude) */
const SPARKLINE_MAX_POINTS = 50;

/** System score (aligned with exportOpsSnapshot / monitor thresholds where applicable) */
const SCORE_DELTA_SEVERE = -0.003;
const SCORE_WILDCARD_HORIZON = 10;
const SCORE_STALE_SNAPSHOT_MS = 30000;
const SCORE_MAX_FAMILY_OK = 4;

let isRefreshing = false;
let lastSuccessTs = null;
let lastSeenGeneratedAt = null;
let staleSinceTs = null;
let strategyModeView = "promotion";
/** Last successful `latest.json` payload (for banner between refreshes) */
let lastGoodLatest = null;

const DATA_FRESH_WARN_MS = 15000;
const DATA_FRESH_STALL_MS = 30000;

// JSON lives next to this folder: neuropilot_trading_v2/ops-snapshot/
// Run HTTP server from neuropilot_trading_v2 (parent), then open:
//   http://localhost:8080/ops-dashboard/

async function loadJSON(file) {
  const url = new URL(`${DATA_PATH}/${file}`, window.location.href);
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${file} (${res.status})`);
  return res.json();
}

/** Same as loadJSON but returns null on missing/non-OK (e.g. older snapshot exports). */
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatLaggingPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${(value * 100).toFixed(1)}%`;
}

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(4) : "n/a";
}

/** Same block chars as engine/evolution/monitor.js */
function sparklineFromDeltas(values) {
  const chars = "▁▂▃▄▅▆▇█";
  const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!nums.length) {
    return { line: "", min: null, max: null, last: null };
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const last = nums[nums.length - 1];
  if (max === min) {
    return { line: "▁".repeat(nums.length), min, max, last };
  }
  const line = nums
    .map((v) => {
      const norm = (v - min) / (max - min);
      const idx = Math.floor(norm * (chars.length - 1));
      return chars[idx];
    })
    .join("");
  return { line, min, max, last };
}

function renderDeltaSparkline(data) {
  const rows = (data.rows || []).slice(-SPARKLINE_MAX_POINTS);
  const deltas = rows.map((r) => r.delta);
  const { line, min, max, last } = sparklineFromDeltas(deltas);
  const pre = document.getElementById("deltaSparkline");
  const meta = document.getElementById("deltaSparklineMeta");
  if (!rows.length || !line) {
    pre.textContent = "—";
    meta.innerHTML = '<span class="muted">No trend rows</span>';
    return;
  }
  pre.textContent = line;
  meta.innerHTML = `
    <span>min <b>${fmt(min)}</b></span>
    <span>max <b>${fmt(max)}</b></span>
    <span>last <b>${fmt(last)}</b></span>
    <span><b>${rows.length}</b> points</span>
  `;
}

function nowStr() {
  return new Date().toLocaleTimeString();
}

function formatPipelineTs(ts) {
  if (ts == null || ts === "") return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function formatDurationSeconds(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function setHealthHttp(ok) {
  const el = document.getElementById("healthHttp");
  if (!el) return;
  if (ok) {
    el.textContent = "OK";
    el.className = "health-v health-ok";
  } else {
    el.textContent = "ERROR";
    el.className = "health-v health-error";
  }
}

function setHealthData(text, level) {
  const el = document.getElementById("healthData");
  if (!el) return;
  el.textContent = text;
  const cls =
    level === "ok"
      ? "health-v health-ok"
      : level === "warn"
        ? "health-v health-warn"
        : level === "error"
          ? "health-v health-error"
          : "health-v health-neutral";
  el.className = cls;
}

/** Updates pipeline time, snapshot age, data freshness; HTTP set via setHealthHttp */
function refreshHealthBanner() {
  const pipeEl = document.getElementById("healthPipeline");
  const ageEl = document.getElementById("healthSnapshotAge");
  if (!pipeEl || !ageEl) return;

  if (!lastGoodLatest) {
    pipeEl.textContent = "—";
    ageEl.textContent = "—";
    setHealthData("—", "neutral");
    return;
  }

  pipeEl.textContent = formatPipelineTs(lastGoodLatest.ts);

  const genAt = lastGoodLatest.generatedAt
    ? new Date(lastGoodLatest.generatedAt).getTime()
    : NaN;
  if (Number.isFinite(genAt)) {
    const sec = (Date.now() - genAt) / 1000;
    ageEl.textContent = formatDurationSeconds(sec);
  } else {
    ageEl.textContent = "—";
  }

  const now = Date.now();
  if (staleSinceTs == null) {
    setHealthData("OK", "ok");
  } else {
    const staleDiff = now - staleSinceTs;
    if (staleDiff > DATA_FRESH_STALL_MS) {
      setHealthData("STALLED", "error");
    } else if (staleDiff > DATA_FRESH_WARN_MS) {
      setHealthData("WARNING", "warn");
    } else {
      setHealthData("OK", "ok");
    }
  }
}

function setStatus(message, cls = "") {
  const el = document.getElementById("statusBox");
  el.className = cls;
  el.textContent = message;
}

function freshnessRowClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "degraded") return "freshness-degraded";
  if (s === "lagging") return "freshness-lagging";
  return "freshness-healthy";
}

/**
 * Projection only — uses laggingSummary + lagging_pressure alerts from snapshot JSON.
 * Does not recompute freshness, thresholds, ratios, or alerts.
 */
function renderLaggingPressureCard(freshness, ownerAlerts) {
  const container = document.getElementById("laggingPressure");
  if (!container) return;

  const laggingSummary = freshness?.laggingSummary || null;
  const laggingAlerts = (ownerAlerts?.alerts || []).filter(
    (a) => a && String(a.code || "") === "lagging_pressure"
  );

  const hasSummary = (laggingSummary?.count || 0) > 0;
  const hasAlerts = laggingAlerts.length > 0;

  const disclaimer =
    '<div class="lagging-disclaimer">Lagging is non-blocking. Only degraded datasets affect execution.</div>';

  let body = "";

  if (hasSummary) {
    const topKeys = Array.isArray(laggingSummary.keys)
      ? laggingSummary.keys.slice(0, 3)
      : [];

    const metrics = [];

    const countNum = Number(laggingSummary.count);
    if (Number.isFinite(countNum)) {
      metrics.push(
        `<li><strong>Count:</strong> <span class="lagging-badge">${escapeHtml(String(countNum))}</span></li>`
      );
    }

    const maxLagMin = laggingSummary.maxLagMinutes;
    if (maxLagMin != null && Number.isFinite(Number(maxLagMin))) {
      metrics.push(
        `<li><strong>Max lag:</strong> ${escapeHtml(String(maxLagMin))} min</li>`
      );
    }

    if (laggingSummary.worstKey != null && laggingSummary.worstKey !== "") {
      metrics.push(
        `<li><strong>Worst key:</strong> <code>${escapeHtml(String(laggingSummary.worstKey))}</code></li>`
      );
    }

    const worstRatioStr = formatLaggingPercent(laggingSummary.worstRatio);
    if (worstRatioStr) {
      metrics.push(`<li><strong>Worst ratio:</strong> ${escapeHtml(worstRatioStr)}</li>`);
    }

    if (topKeys.length > 0) {
      metrics.push(
        `<li><strong>Top keys:</strong> ${topKeys
          .map((k) => `<code>${escapeHtml(String(k))}</code>`)
          .join(", ")}</li>`
      );
    }

    body += `
      <p class="lagging-summary">Lagging datasets detected from existing snapshot data.</p>
      <ul class="lagging-summary-metrics">
        ${metrics.join("")}
      </ul>
    `;
  }

  if (hasAlerts) {
    body += `
      <p class="lagging-alert-hint">Owner alerts</p>
      <ul class="lagging-alert-lines">
        ${laggingAlerts
          .map((a) => `<li>${escapeHtml(a.message != null ? String(a.message) : "")}</li>`)
          .join("")}
      </ul>
    `;
  }

  if (!hasSummary && !hasAlerts) {
    if (freshness == null && ownerAlerts == null) {
      body += '<p class="muted">No data available.</p>';
    } else {
      body += '<p class="lagging-summary">No lagging datasets</p>';
    }
  }

  container.innerHTML = `<div class="lagging-card"><div class="lagging-card-body">${body}${disclaimer}</div></div>`;
}

function renderDatasetFreshness(data) {
  const el = document.getElementById("datasetFreshness");
  if (!el) return;

  const rows = data && Array.isArray(data.datasets) ? data.datasets : [];
  if (!rows.length) {
    el.innerHTML =
      '<span class="muted">No manifest datasets — run <code>node engine/evolution/scripts/exportOpsSnapshot.js</code> after <code>datasets_manifest.json</code> exists.</span>';
    return;
  }

  const sorted = rows.slice().sort((a, b) => {
    const ax = Number(a.dataset_age_minutes);
    const bx = Number(b.dataset_age_minutes);
    if (!Number.isFinite(ax) && !Number.isFinite(bx)) return 0;
    if (!Number.isFinite(ax)) return 1;
    if (!Number.isFinite(bx)) return -1;
    return bx - ax;
  });

  const body = sorted
    .map((d) => {
      const age = d.dataset_age_minutes;
      const st = d.status != null ? String(d.status) : "";
      const trClass = ` class="${freshnessRowClass(st)}"`;
      const lastTs = d.dataset_last_candle_ts;
      const lastStr =
        lastTs != null && Number.isFinite(Number(lastTs))
          ? new Date(Number(lastTs)).toLocaleString()
          : "—";
      const ageStr =
        typeof age === "number" && Number.isFinite(age) ? `${age} min` : "—";
      const lb = d.last_bootstrap && typeof d.last_bootstrap === "object" ? d.last_bootstrap : null;
      const bootMode = lb && lb.mode != null ? escapeHtml(String(lb.mode)) : "—";
      const rep =
        lb != null && lb.replacedBars != null && Number.isFinite(Number(lb.replacedBars))
          ? escapeHtml(String(lb.replacedBars))
          : "—";
      const statusLabel = st ? escapeHtml(st) : "—";
      return `<tr${trClass}><td><code>${escapeHtml(d.key)}</code></td><td>${statusLabel}</td><td>${escapeHtml(d.provider_used ?? "—")}</td><td>${bootMode}</td><td>${rep}</td><td>${escapeHtml(lastStr)}</td><td>${escapeHtml(ageStr)}</td><td>${escapeHtml(String(d.rows ?? "—"))}</td></tr>`;
    })
    .join("");

  el.innerHTML = `
    <table class="freshness-table">
      <thead><tr><th>Dataset</th><th>Status</th><th>Provider</th><th>Bootstrap mode</th><th>Replaced</th><th>Last candle (local)</th><th>Age</th><th>Rows</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="muted freshness-meta">Evaluated: ${escapeHtml(data.generatedAt || "—")}</p>
  `;
}

function renderLatest(data) {
  document.getElementById("generatedAt").innerText =
    "Generated: " + new Date(data.generatedAt).toLocaleString();

  document.getElementById("latest").innerHTML = `
    <div class="grid">
      <div><b>Delta</b>: ${fmt(data.delta)}</div>
      <div><b>Champions</b>: ${data.champions}</div>
      <div><b>Validated</b>: ${data.validated}</div>
      <div><b>Wildcard</b>: ${data.wildcardPromotions}</div>
      <div><b>Diversity Cap</b>: ${data.diversityCapped}</div>
      <div><b>Max Family</b>: ${data.maxChampionsInOneFamily}</div>
      <div><b>Audit</b>: ${data.consistencyOk ? "OK" : "FAIL"}</div>
    </div>
  `;
}

function renderTrend(data) {
  const lagLine =
    data.laggingCount != null && Number.isFinite(Number(data.laggingCount))
      ? `Lagging datasets (snapshot): ${data.laggingCount}\n`
      : "";
  const rows = (data.rows || []).slice(-20).map(r => {
    const ts = String(r.ts || "").split("T")[1]?.split(".")[0] || r.ts;
    return `${ts} | Δ ${fmt(r.delta)} | WC ${r.wildcardPromotions}`;
  });

  document.getElementById("trend").innerText = lagLine + rows.join("\n");
}

function renderAlerts(data) {
  const container = document.getElementById("alerts");
  const items = Array.isArray(data.items) ? data.items : [];

  if (!items.length) {
    container.innerHTML = `<div class="ok">No alerts</div>`;
    return;
  }

  container.innerHTML = items.map(a => {
    const cls = a.status === "alert" ? "alert" : "ok";
    return `<div class="${cls}">${a.type}: ${a.message}</div>`;
  }).join("");
}

function renderMilestones(data) {
  document.getElementById("milestones").innerHTML = `
    <div><b>First Wildcard:</b> ${data.firstWildcardTs || "none"}</div>
    <div><b>Best Delta:</b> ${fmt(data.bestDelta)}</div>
    <div><b>Worst Delta:</b> ${fmt(data.worstDelta)}</div>
    <div><b>Max Champions:</b> ${data.maxChampions}</div>
    <div><b>Max Family Concentration:</b> ${data.maxFamilyConcentration}</div>
  `;
}

function renderStrategyModeRows(modeRows) {
  if (!Array.isArray(modeRows) || modeRows.length === 0) {
    return '<div class="muted">No rows for selected mode.</div>';
  }
  const top = modeRows.slice(0, 12);
  return `<table class="freshness-table">
    <thead><tr><th>Strategy</th><th>Tier</th><th>Excluded</th><th>Score</th><th>Trades</th><th>PF</th><th>Expectancy</th><th>Hard fails</th><th>Warnings</th></tr></thead>
    <tbody>
      ${top.map((r) => {
        const hf = Array.isArray(r.hardFails) && r.hardFails.length ? r.hardFails.join(", ") : "—";
        const w = Array.isArray(r.warnings) && r.warnings.length ? r.warnings.join(", ") : "—";
        const ex = Array.isArray(r.excludedReasons) && r.excludedReasons.length ? r.excludedReasons.join(", ") : "—";
        const tier = String(r.tier ?? "—");
        const tierClass =
          tier === "promote_candidate"
            ? "np-tag np-tag-green"
            : tier === "needs_more_data"
              ? "np-tag np-tag-yellow"
              : tier === "watchlist"
                ? "np-tag np-tag-orange"
                : "np-tag np-tag-gray";
        return `<tr><td><code>${escapeHtml(r.strategyId)}</code></td><td><span class="${tierClass}">${escapeHtml(tier)}</span></td><td>${escapeHtml(ex)}</td><td>${escapeHtml(String(r.score ?? "—"))}</td><td>${escapeHtml(String(r.trades ?? "—"))}</td><td>${escapeHtml(String(r.profitFactor ?? "—"))}</td><td>${escapeHtml(String(r.expectancy ?? "—"))}</td><td>${escapeHtml(hf)}</td><td>${escapeHtml(w)}</td></tr>`;
      }).join("")}
    </tbody>
  </table>`;
}

function readinessTagClass(pct) {
  const x = Number(pct);
  if (!Number.isFinite(x)) return "np-tag np-tag-gray";
  if (x >= 75) return "np-tag np-tag-green";
  if (x >= 50) return "np-tag np-tag-yellow";
  return "np-tag np-tag-orange";
}

/** Per-criterion gap badge: green = met target, yellow = close, orange = far. */
function gapClassTrades(remaining, tradesTarget) {
  const r = Math.max(0, Number(remaining) || 0);
  const t = Math.max(1, Number(tradesTarget) || 100);
  if (r === 0) return "np-gap np-gap-green";
  const close = Math.max(12, Math.ceil(t * 0.2));
  if (r <= close) return "np-gap np-gap-yellow";
  return "np-gap np-gap-orange";
}

function gapClassMarkets(remaining, marketsTarget) {
  const r = Math.max(0, Number(remaining) || 0);
  const t = Math.max(1, Number(marketsTarget) || 1);
  if (r === 0) return "np-gap np-gap-green";
  if (t >= 2 && r === 1) return "np-gap np-gap-yellow";
  return "np-gap np-gap-orange";
}

function formatPromotionGapHtml(r, promotionRules) {
  const minTrades = Math.max(1, Number(promotionRules?.minTrades) || 100);
  const needMulti = !!promotionRules?.multiMarketRequiredForPromotion;
  const marketsTarget = needMulti ? 2 : 1;
  let remT = Number(r.tradesToPromotionTarget);
  if (!Number.isFinite(remT)) {
    const tr = Number(r.trades) || 0;
    remT = Math.max(0, minTrades - tr);
  } else {
    remT = Math.max(0, remT);
  }
  let remM = Number(r.marketsToPromotionTarget);
  if (!Number.isFinite(remM)) {
    const sc = Number(r.symbolCount) || 0;
    remM = Math.max(0, marketsTarget - sc);
  } else {
    remM = Math.max(0, remM);
  }
  const tCls = gapClassTrades(remT, minTrades);
  const mCls = gapClassMarkets(remM, marketsTarget);
  return `<span class="readiness-gap-line"><span class="${tCls}">${escapeHtml(`${remT}T`)}</span><span class="readiness-gap-sep"> / </span><span class="${mCls}">${escapeHtml(`${remM}M`)}</span><span class="readiness-gap-suffix muted"> remaining</span></span>`;
}

function humanizeNextMilestone(raw, row) {
  const s = String(raw || "").trim();
  if (!s) return "—";
  if (s === "ready_for_promotion_review") return "Ready for promotion review";
  if (s === "improve_quality_metrics") return "Improve quality metrics";
  if (s === "rename_or_remove_non_production_strategy") return "Blocked by non-production naming";

  const mt = s.match(/^need_(\d+)_more_trades$/);
  if (mt) {
    const n = Number(mt[1]);
    if (Number.isFinite(n)) return `Need ${n} more ${n === 1 ? "trade" : "trades"}`;
  }
  const mm = s.match(/^need_(\d+)_more_markets$/);
  if (mm) {
    const n = Number(mm[1]);
    if (Number.isFinite(n)) return `Run on ${n} more ${n === 1 ? "market" : "markets"}`;
  }

  const hardFails = Array.isArray(row?.hardFails) ? row.hardFails : [];
  if (hardFails.length > 0) return "Blocked by hard fail";
  return s.replace(/_/g, " ");
}

/** Ascending: strategies closest to clearing volume + market gates first. */
function promotionDistanceScore(r, promotionRules) {
  const minTrades = Math.max(1, Number(promotionRules?.minTrades) || 100);
  const needMulti = !!promotionRules?.multiMarketRequiredForPromotion;
  const marketsTarget = needMulti ? 2 : 1;
  let remT = Number(r.tradesToPromotionTarget);
  if (!Number.isFinite(remT)) remT = Math.max(0, minTrades - (Number(r.trades) || 0));
  else remT = Math.max(0, remT);
  let remM = Number(r.marketsToPromotionTarget);
  if (!Number.isFinite(remM)) remM = Math.max(0, marketsTarget - (Number(r.symbolCount) || 0));
  else remM = Math.max(0, remM);
  const mWeight = Math.max(15, Math.round(minTrades * 0.25));
  return remT + (needMulti ? remM * mWeight : 0);
}

function transitionTagBadge(tag) {
  const t = String(tag || "reject");
  let cls = "np-tag np-tag-gray";
  if (t === "research_watchlist_promotion_reject") cls = "np-tag np-tag-orange";
  else if (t === "needs_more_data_promotion_reject") cls = "np-tag np-tag-yellow";
  else if (t === "promotion_candidate") cls = "np-tag np-tag-green";
  else if (t === "example_or_demo_strategy") cls = "np-tag np-tag-gray";
  return `<span class="${cls}">${escapeHtml(t)}</span>`;
}

function setStrategyMode(mode) {
  strategyModeView = mode === "research" ? "research" : "promotion";
  const wrap = document.getElementById("strategyModeToggle");
  if (wrap) {
    for (const btn of wrap.querySelectorAll("button")) {
      const active = btn.getAttribute("data-mode") === strategyModeView;
      btn.className = active ? "mode-btn mode-btn-active" : "mode-btn";
    }
  }
  const selected = document.getElementById("strategyModeSelected");
  if (selected) selected.textContent = strategyModeView;
}

function renderStrategyValidation(data, strategyInbox) {
  const el = document.getElementById("strategyValidation");
  if (!el) return;
  if (!data || !Array.isArray(data.rows)) {
    el.innerHTML = '<span class="muted">No strategy validation snapshot yet.</span>';
    return;
  }

  const s = data.summary || {};
  const topPromotable = Array.isArray(data.topPromotable) ? data.topPromotable.slice(0, 6) : [];
  const topWatchlist = Array.isArray(data.topWatchlist) ? data.topWatchlist.slice(0, 6) : [];
  const modes = data.modes && typeof data.modes === "object" ? data.modes : null;
  const researchSummary = modes && modes.research ? modes.research.summary : null;
  const promotionSummary = modes && modes.promotion ? modes.promotion.summary : null;

  const promotableRows = topPromotable.length
    ? `<table class="freshness-table">
        <thead><tr><th>Paper promote_candidate</th><th>Score</th><th>Trades</th><th>Expectancy</th><th>PF</th><th>Win%</th></tr></thead>
        <tbody>
          ${topPromotable.map((r) => `<tr><td><code>${escapeHtml(r.strategyId)}</code></td><td>${escapeHtml(String(r.score ?? "—"))}</td><td>${escapeHtml(String(r.trades ?? "—"))}</td><td>${escapeHtml(String(r.expectancy ?? "—"))}</td><td>${escapeHtml(String(r.profitFactor ?? "—"))}</td><td>${escapeHtml(String(r.winRate ?? "—"))}</td></tr>`).join("")}
        </tbody>
      </table>`
    : '<div class="muted">No paper promote_candidate rows yet (strict tier, paper_trades.jsonl).</div>';

  const watchlistRows = topWatchlist.length
    ? `<table class="freshness-table">
        <thead><tr><th>Watchlist strategy</th><th>Score</th><th>Trades</th><th>Expectancy</th><th>PF</th><th>Win%</th></tr></thead>
        <tbody>
          ${topWatchlist.map((r) => `<tr><td><code>${escapeHtml(r.strategyId)}</code></td><td>${escapeHtml(String(r.score ?? "—"))}</td><td>${escapeHtml(String(r.trades ?? "—"))}</td><td>${escapeHtml(String(r.expectancy ?? "—"))}</td><td>${escapeHtml(String(r.profitFactor ?? "—"))}</td><td>${escapeHtml(String(r.winRate ?? "—"))}</td></tr>`).join("")}
        </tbody>
      </table>`
    : '<div class="muted">No strict-mode watchlist currently.</div>';

  const modeSummaryHtml = modes
    ? `<div class="freshness-meta">
        <span>Default mode: <b>${escapeHtml(data.defaultMode || "promotion")}</b></span>
        <span class="freshness-meta-indent">Research: P ${escapeHtml(String(researchSummary?.promotableCount ?? 0))}, W ${escapeHtml(String(researchSummary?.watchlistCount ?? 0))}, N ${escapeHtml(String(researchSummary?.needsMoreDataCount ?? 0))}, R ${escapeHtml(String(researchSummary?.rejectedCount ?? 0))}</span>
        <span class="freshness-meta-indent">Promotion (paper strict): P ${escapeHtml(String(promotionSummary?.promotableCount ?? 0))}, W ${escapeHtml(String(promotionSummary?.watchlistCount ?? 0))}, R ${escapeHtml(String(promotionSummary?.rejectedCount ?? 0))}</span>
      </div>`
    : "";

  const transitionCandidates = Array.isArray(data.transitionCandidates) ? data.transitionCandidates.slice(0, 6) : [];
  const transitionHtml = transitionCandidates.length
    ? `<table class="freshness-table">
        <thead><tr><th>Strategy</th><th>Transition</th><th>Research tier</th><th>Promotion tier</th><th>Trades</th><th>Score R/P</th></tr></thead>
        <tbody>
          ${transitionCandidates.map((r) => `<tr><td><code>${escapeHtml(r.strategyId)}</code></td><td>${transitionTagBadge(r.transitionTag)}</td><td>${escapeHtml(String(r.researchTier ?? "—"))}</td><td>${escapeHtml(String(r.promotionTier ?? "—"))}</td><td>${escapeHtml(String(r.trades ?? "—"))}</td><td>${escapeHtml(String(r.researchScore ?? "—"))} / ${escapeHtml(String(r.promotionScore ?? "—"))}</td></tr>`).join("")}
        </tbody>
      </table>`
    : '<div class="muted">No research-only transition candidates currently.</div>';

  const selectedModeRows = strategyModeView === "research"
    ? (modes?.research?.rows || [])
    : (modes?.promotion?.rows || data.rows || []);
  const promoRules = data.rules && typeof data.rules === "object" ? data.rules : {};
  const tradesTargetUi = Math.max(1, Number(promoRules.minTrades) || 100);
  const marketsTargetUi = promoRules.multiMarketRequiredForPromotion ? 2 : 1;
  const readinessRows = (modes?.promotion?.rows || data.rows || [])
    .filter((r) => !r.excludedFromRanking)
    .sort((a, b) => {
      const da = promotionDistanceScore(a, promoRules);
      const db = promotionDistanceScore(b, promoRules);
      if (da !== db) return da - db;
      return Number(b.readinessPct || 0) - Number(a.readinessPct || 0);
    })
    .slice(0, 10);
  const readinessHtml = readinessRows.length
    ? `<table class="freshness-table">
        <thead><tr><th>Strategy</th><th>Ready</th><th>To target</th><th>Trades</th><th>Markets</th><th>Tier</th><th>Blocking reason</th><th>Next milestone</th></tr></thead>
        <tbody>
          ${readinessRows.map((r) => {
            const blockers = Array.isArray(r.blockingReasons) && r.blockingReasons.length ? r.blockingReasons.join(", ") : "—";
            const ready = Number(r.readinessPct);
            const gapHtml = formatPromotionGapHtml(r, promoRules);
            const milestoneHuman = humanizeNextMilestone(r.nextMilestone, r);
            return `<tr><td><code>${escapeHtml(r.strategyId)}</code></td><td><span class="${readinessTagClass(ready)}">${escapeHtml(Number.isFinite(ready) ? `${ready}%` : "—")}</span></td><td>${gapHtml}</td><td>${escapeHtml(String(r.trades ?? "—"))} / ${escapeHtml(String(tradesTargetUi))}</td><td>${escapeHtml(String(r.symbolCount ?? "—"))} / ${escapeHtml(String(marketsTargetUi))}</td><td>${escapeHtml(String(r.tier ?? "—"))}</td><td>${escapeHtml(blockers)}</td><td title="${escapeHtml(String(r.nextMilestone ?? "—"))}">${escapeHtml(milestoneHuman)}</td></tr>`;
          }).join("")}
        </tbody>
      </table>`
    : '<div class="muted">No promotion readiness rows yet.</div>';

  const blockers = data.whatBlocksPromotion && typeof data.whatBlocksPromotion === "object"
    ? data.whatBlocksPromotion
    : {};
  const blockersHtml = `<div class="grid">
      <div><b>Insufficient sample</b>: ${escapeHtml(String(blockers.insufficient_sample_for_promotion ?? 0))}</div>
      <div><b>Single market</b>: ${escapeHtml(String(blockers.single_market_only ?? 0))}</div>
      <div><b>Low PF</b>: ${escapeHtml(String(blockers.low_profit_factor ?? 0))}</div>
      <div><b>Negative expectancy</b>: ${escapeHtml(String(blockers.negative_expectancy ?? 0))}</div>
      <div><b>Non-prod excluded</b>: ${escapeHtml(String(blockers.non_production_name_hard_exclude ?? 0))}</div>
      <div><b>Suspicious winrate</b>: ${escapeHtml(String(blockers.suspicious_high_win_rate_small_sample ?? 0))}</div>
    </div>`;

  const funnel = data.validationFunnel && typeof data.validationFunnel === "object" ? data.validationFunnel : null;
  const funnelHtml = funnel
    ? `<div class="grid">
        <div><b>Detected</b>: ${escapeHtml(String(funnel.detected ?? 0))}</div>
        <div><b>Research active</b>: ${escapeHtml(String(funnel.researchActive ?? 0))}</div>
        <div><b>Watchlist</b>: ${escapeHtml(String(funnel.watchlist ?? 0))}</div>
        <div><b>Needs more data</b>: ${escapeHtml(String(funnel.needsMoreData ?? 0))}</div>
        <div><b>Promotion candidate</b>: ${escapeHtml(String(funnel.promotionCandidate ?? 0))}</div>
        <div><b>Excluded</b>: ${escapeHtml(String(funnel.excluded ?? 0))}</div>
      </div>`
    : '<div class="muted">No funnel yet.</div>';

  const inboxItems = strategyInbox && Array.isArray(strategyInbox.items) ? strategyInbox.items : [];
  const inboxHtml = inboxItems.length
    ? `<table class="freshness-table">
        <thead><tr><th>Strategy</th><th>Status</th><th>Priority</th><th>Added</th><th>Source</th><th>Notes</th></tr></thead>
        <tbody>
          ${inboxItems.slice(0, 20).map((it) => `<tr><td><code>${escapeHtml(it.strategyId ?? "unknown")}</code></td><td>${escapeHtml(it.status ?? "pending_review")}</td><td>${escapeHtml(it.priority ?? "normal")}</td><td>${escapeHtml(it.addedAt ?? "—")}</td><td>${escapeHtml(it.source ?? "—")}</td><td>${escapeHtml(it.notes ?? "—")}</td></tr>`).join("")}
        </tbody>
      </table>`
    : '<div class="muted">No pending strategy in inbox. Add entries to <code>engine/governance/strategy_inbox.json</code>.</div>';

  const trendApply = data.trendMemoryApply && typeof data.trendMemoryApply === "object"
    ? data.trendMemoryApply
    : null;
  const promoRowsForTrend = modes?.promotion?.rows || data.rows || [];
  let trendAppliedCount = 0;
  let trendSkippedLowSampleCount = 0;
  let trendSkippedLowConfidenceCount = 0;
  for (const r of promoRowsForTrend) {
    if (r && r.trendAdjustmentApplied === true) {
      trendAppliedCount += 1;
      continue;
    }
    const reason = String(r?.trendApplyReason || "");
    if (reason === "trend_apply_skipped_low_sample") trendSkippedLowSampleCount += 1;
    else if (reason === "trend_apply_skipped_low_confidence") trendSkippedLowConfidenceCount += 1;
  }
  const trendApplyHtml = trendApply
    ? `<div class="grid">
        <div><b>Enabled</b>: ${trendApply.enabled ? "yes" : "no"}</div>
        <div><b>Min sample</b>: ${escapeHtml(String(trendApply.minSampleForTrendApply ?? "—"))}</div>
        <div><b>Min confidence</b>: ${escapeHtml(String(trendApply.minTrendConfidenceForApply ?? "—"))}</div>
        <div><b>Max penalty</b>: ${escapeHtml(String(trendApply.maxTrendPenaltyPts ?? "—"))}</div>
        <div><b>Max bonus</b>: ${escapeHtml(String(trendApply.maxTrendBonusPts ?? "—"))}</div>
        <div><b>Direction / confidence</b>: ${escapeHtml(String(trendApply.trendDirection ?? "flat"))} / ${escapeHtml(String(trendApply.trendConfidence ?? "—"))}</div>
        <div><b>Applied</b>: ${escapeHtml(String(trendAppliedCount))}</div>
        <div><b>Skipped (low sample)</b>: ${escapeHtml(String(trendSkippedLowSampleCount))}</div>
        <div><b>Skipped (low confidence)</b>: ${escapeHtml(String(trendSkippedLowConfidenceCount))}</div>
      </div>
      <p class="muted freshness-meta">Reason: ${escapeHtml(String(trendApply.reason ?? "—"))}</p>`
    : '<div class="muted">No trend apply context found in strategy validation payload.</div>';

  el.innerHTML = `
    <div class="grid">
      <div><b>Total</b>: ${escapeHtml(String(s.strategiesTotal ?? 0))}</div>
      <div><b>Paper promote_candidate</b>: ${escapeHtml(String(s.promotableCount ?? 0))}</div>
      <div><b>Watchlist</b>: ${escapeHtml(String(s.watchlistCount ?? 0))}</div>
      <div><b>Rejected</b>: ${escapeHtml(String(s.rejectedCount ?? 0))}</div>
    </div>
    <p class="muted freshness-meta">Paper strict tier (promote_candidate) from paper_trades.jsonl — not batch/WF promotionGuard.passed.</p>
    ${modeSummaryHtml}
    <div id="strategyModeToggle" class="mode-toggle">
      <span class="muted">Rows mode:</span>
      <button class="${strategyModeView === "promotion" ? "mode-btn mode-btn-active" : "mode-btn"}" data-mode="promotion" onclick="window.__npSetStrategyMode('promotion')">Promotion</button>
      <button class="${strategyModeView === "research" ? "mode-btn mode-btn-active" : "mode-btn"}" data-mode="research" onclick="window.__npSetStrategyMode('research')">Research</button>
      <span class="muted">selected: <b id="strategyModeSelected">${escapeHtml(strategyModeView)}</b></span>
    </div>
    ${promotableRows}
    ${watchlistRows}
    <h3>Promotion readiness</h3>
    ${readinessHtml}
    <h3>Validation funnel</h3>
    ${funnelHtml}
    <h3>What blocks promotion</h3>
    ${blockersHtml}
    <h3>Trend apply status</h3>
    ${trendApplyHtml}
    <h3>Transition candidates</h3>
    ${transitionHtml}
    <h3>Strategy inbox</h3>
    ${inboxHtml}
    <h3>Detailed rows (selected mode)</h3>
    ${renderStrategyModeRows(selectedModeRows)}
    <p class="muted freshness-meta">Generated: ${escapeHtml(data.generatedAt || "—")}</p>
  `;
  setStrategyMode(strategyModeView);
}

/**
 * Synthetic operator score: base 100, penalties/bonuses, clamp [0, 100].
 * @param {{ latest: object, trend: object, staleSinceTs: number | null, nowMs: number }} p
 */
function computeSystemScore({ latest, trend, staleSinceTs, nowMs }) {
  const lines = [];
  let score = 100;

  const delta = Number(latest?.delta);
  const deltaOk = Number.isFinite(delta);
  const maxFam = Number(latest?.maxChampionsInOneFamily);
  const maxFamOk = Number.isFinite(maxFam);

  if (latest?.consistencyOk === false) {
    score -= 20;
    lines.push("−20 audit fail (consistencyOk)");
  }

  if (deltaOk && delta < SCORE_DELTA_SEVERE) {
    score -= 15;
    lines.push("−15 delta < −0.003");
  }
  if (deltaOk && delta < 0) {
    score -= 8;
    lines.push("−8 delta < 0");
  }

  if (maxFamOk && maxFam > SCORE_MAX_FAMILY_OK) {
    score -= 10;
    lines.push(`−10 max family > ${SCORE_MAX_FAMILY_OK} (${maxFam})`);
  }

  const wcRows = (trend?.rows || []).slice(-SCORE_WILDCARD_HORIZON);
  if (
    wcRows.length >= SCORE_WILDCARD_HORIZON &&
    wcRows.every((r) => (r.wildcardPromotions || 0) === 0)
  ) {
    score -= 8;
    lines.push(
      `−8 wildcard inactive (last ${SCORE_WILDCARD_HORIZON} runs)`
    );
  }

  if (
    staleSinceTs != null &&
    nowMs - staleSinceTs > SCORE_STALE_SNAPSHOT_MS
  ) {
    score -= 15;
    lines.push("−15 snapshot stale > 30s (generatedAt/ts unchanged)");
  }

  if (deltaOk && delta > 0) {
    score += 5;
    lines.push("+5 delta > 0");
  }

  if (maxFamOk && maxFam <= SCORE_MAX_FAMILY_OK) {
    score += 3;
    lines.push("+3 diversity stable (max family ≤ 4)");
  }

  score = Math.round(score);
  score = Math.max(0, Math.min(100, score));

  let label;
  let labelClass;
  if (score >= 85) {
    label = "Excellent (≥ 85)";
    labelClass = "score-excellent";
  } else if (score >= 70) {
    label = "Healthy (≥ 70)";
    labelClass = "score-healthy";
  } else if (score >= 50) {
    label = "Watch (≥ 50)";
    labelClass = "score-watch";
  } else {
    label = "Critical (< 50)";
    labelClass = "score-critical";
  }

  return { score, label, labelClass, lines };
}

function renderExecutionStatus(raw) {
  const box = document.getElementById("executionStatus");
  if (!box) return;
  if (!raw || typeof raw !== "object") {
    box.innerHTML =
      '<p class="muted">No execution snapshot — run <code>node engine/evolution/scripts/exportOpsSnapshot.js</code></p>';
    return;
  }

  const mode = escapeHtml(raw.mode || "—");
  const kill = raw.killSwitchOn ? '<span class="score-critical">ON</span>' : '<span class="score-ok">off</span>';
  const tradesLive = raw.tradesTodayLive != null ? escapeHtml(String(raw.tradesTodayLive)) : "—";
  const shadowN = raw.shadowEventsToday != null ? escapeHtml(String(raw.shadowEventsToday)) : "—";
  const pnl =
    raw.livePnlApprox != null && Number.isFinite(Number(raw.livePnlApprox))
      ? escapeHtml(Number(raw.livePnlApprox).toFixed(4))
      : "n/a";
  const creds = raw.oandaCredentialsPresent ? "configured" : "missing";
  const credsClass = raw.oandaCredentialsPresent ? "score-ok" : "score-watch";

  let lastOrderHtml = '<span class="muted">None</span>';
  const lo = raw.lastOrder;
  if (lo && typeof lo === "object") {
    const parts = [];
    if (lo.liveOrderId) parts.push(`id <code>${escapeHtml(lo.liveOrderId)}</code>`);
    if (lo.instrument) parts.push(escapeHtml(lo.instrument));
    if (lo.side) parts.push(escapeHtml(lo.side));
    if (lo.strategyId) parts.push(`strat ${escapeHtml(lo.strategyId)}`);
    if (lo.shadowAt) parts.push(`shadow ${escapeHtml(lo.shadowAt)}`);
    if (parts.length) lastOrderHtml = parts.join(" · ");
  }

  let errHtml = '<span class="muted">None</span>';
  const er = raw.lastError;
  if (er && er.message) {
    errHtml = `<span class="score-critical">${escapeHtml(er.message)}</span>`;
    if (er.at) errHtml += ` <span class="muted">(${escapeHtml(er.at)})</span>`;
  }

  const wl = Array.isArray(raw.whitelistStrategyIds)
    ? raw.whitelistStrategyIds.map((s) => escapeHtml(String(s))).join(", ")
    : "—";

  const dedupeOff = raw.dedupeDisabled === true;
  const dedupeLine = dedupeOff
    ? '<span class="score-critical">disabled</span> (lab only)'
    : '<span class="score-ok">on</span>';
  const keyCount =
    raw.executedKeysTodayCount != null ? escapeHtml(String(raw.executedKeysTodayCount)) : "—";

  const pnlSource = escapeHtml(raw.pnlSource || "none");
  const pnlNote =
    raw.pnlNote != null ? `<span class="muted">${escapeHtml(String(raw.pnlNote))}</span>` : "";
  const acctPl =
    raw.accountPlLifetime != null && Number.isFinite(Number(raw.accountPlLifetime))
      ? escapeHtml(Number(raw.accountPlLifetime).toFixed(4))
      : "n/a";

  const reconOk = raw.reconciliationHealthy === true;
  const reconLine = reconOk
    ? '<span class="score-ok">healthy</span>'
    : '<span class="score-watch">degraded or stale</span>';
  const brokerConn =
    raw.brokerConnected === true
      ? '<span class="score-ok">yes</span>'
      : '<span class="muted">no</span>';
  const driftN = raw.driftFlagsCount != null ? escapeHtml(String(raw.driftFlagsCount)) : "—";
  const driftList = Array.isArray(raw.driftFlags)
    ? raw.driftFlags.map((f) => escapeHtml(String(f))).join(", ")
    : "";
  const reconFail =
    raw.reconciliationLastFailureMessage != null
      ? escapeHtml(String(raw.reconciliationLastFailureMessage))
      : "";

  const periodSrc = escapeHtml(raw.periodPnlSource || "none");
  const periodWin =
    raw.periodPnlWindow === "utc_day"
      ? "UTC day"
      : escapeHtml(raw.periodPnlWindow || "utc_day");
  const periodFills =
    raw.periodPnlFillsCount != null && raw.periodPnlMatchedCount != null
      ? `${escapeHtml(String(raw.periodPnlMatchedCount))}/${escapeHtml(String(raw.periodPnlFillsCount))} matched`
      : "—";
  let periodPnlLine = "n/a";
  if (
    raw.periodPnlCorrelated != null &&
    Number.isFinite(Number(raw.periodPnlCorrelated)) &&
    raw.periodPnlSource === "correlated_fills"
  ) {
    const v = Number(raw.periodPnlCorrelated);
    const sign = v > 0 ? "+" : "";
    periodPnlLine = `${sign}${escapeHtml(v.toFixed(4))}`;
  }
  const periodFees =
    raw.periodPnlFees != null && Number.isFinite(Number(raw.periodPnlFees))
      ? escapeHtml(Number(raw.periodPnlFees).toFixed(4))
      : "n/a";

  box.innerHTML = `
    <dl class="execution-dl">
      <dt>PnL period (correlated)</dt><dd><b>${periodPnlLine}</b> · <span class="muted">source</span> <code>${periodSrc}</code> · <span class="muted">window</span> ${periodWin} · <span class="muted">fills</span> ${periodFills} · <span class="muted">fees</span> ${periodFees}<br/><small class="muted">${raw.periodPnlNote != null ? escapeHtml(String(raw.periodPnlNote)) : ""}</small></dd>
      <dt>Mode</dt><dd><code>${mode}</code> · kill switch ${kill}</dd>
      <dt>OANDA</dt><dd>env <code>${escapeHtml(raw.oandaEnv || "—")}</code> · creds <span class="${credsClass}">${creds}</span></dd>
      <dt>Trades today (live)</dt><dd>${tradesLive}</dd>
      <dt>Shadow events today</dt><dd>${shadowN}</dd>
      <dt>Live PnL (approx)</dt><dd>${pnl} <small>${pnlNote}</small><br/><span class="muted">pnlSource</span> <code>${pnlSource}</code> · <span class="muted">account pl (lifetime)</span> ${acctPl}</dd>
      <dt>Reconciliation</dt><dd>${reconLine} · broker connected ${brokerConn}<br/>
        <span class="muted">last</span> ${escapeHtml(raw.lastReconciledAt || "—")} · <span class="muted">age min</span> ${escapeHtml(String(raw.brokerSnapshotAgeMinutes ?? "—"))}<br/>
        <span class="muted">positions / trades / pending</span> ${escapeHtml(String(raw.openPositionsCount ?? "—"))} / ${escapeHtml(String(raw.openTradesCount ?? "—"))} / ${escapeHtml(String(raw.pendingOrdersCount ?? "—"))}<br/>
        <span class="muted">fills ledger</span> ${escapeHtml(String(raw.fillsLedgerCount ?? "—"))} · <span class="muted">matched / unmatched</span> ${escapeHtml(String(raw.matchedFillsCount ?? "—"))} / ${escapeHtml(String(raw.unmatchedFillsCount ?? "—"))}<br/>
        <span class="muted">fills w/ signal key</span> ${escapeHtml(String(raw.fillsWithSignalKeyCount ?? "—"))} · <span class="muted">without key</span> ${escapeHtml(String(raw.fillsWithoutSignalKeyCount ?? "—"))}<br/>
        <span class="muted">drift flags</span> ${driftN}${driftList ? ` (${driftList})` : ""}<br/>
        ${reconFail ? `<span class="score-critical">${reconFail}</span>` : ""}
      </dd>
      <dt>Last order / sim</dt><dd>${lastOrderHtml}</dd>
      <dt>Last error</dt><dd>${errHtml}</dd>
      <dt>Whitelist</dt><dd><code>${wl}</code> · max/day ${escapeHtml(String(raw.maxTradesPerDay ?? "—"))}</dd>
      <dt>Idempotence</dt><dd>${dedupeLine} · keys today (UTC) ${keyCount}</dd>
    </dl>
  `;
}

function renderSystemScore({ score, label, labelClass, lines }) {
  document.getElementById("systemScore").textContent = `${score} / 100`;
  const labelEl = document.getElementById("systemScoreLabel");
  labelEl.textContent = label;
  labelEl.className = `system-score-label ${labelClass}`;
  const ul = document.getElementById("systemScoreBreakdown");
  if (!lines.length) {
    ul.innerHTML = '<li class="muted">No adjustments (base 100, clamped)</li>';
    return;
  }
  ul.innerHTML = lines.map((l) => `<li>${l}</li>`).join("");
}

async function refreshDashboard() {
  if (isRefreshing) return;

  isRefreshing = true;

  try {
    setStatus("Refreshing…", "status-loading");

    const [
      latest,
      trend,
      alerts,
      milestones,
      freshnessFile,
      ownerTransitionAlertsFile,
      strategyValidation,
      strategyInbox,
      executionStatusFile,
    ] = await Promise.all([
      loadJSON("latest.json"),
      loadJSON("trend.json"),
      loadJSON("alerts.json"),
      loadJSON("milestones.json"),
      loadJSONOptional("datasets_freshness.json"),
      loadJSONOptional("owner_transition_alerts.json"),
      loadJSONOptional("strategy_validation.json"),
      loadJSONOptional("strategy_inbox.json"),
      loadJSONOptional("execution_status.json"),
    ]);

    const freshness = freshnessFile || latest.datasetFreshness || null;
    renderDatasetFreshness(freshness);
    renderLaggingPressureCard(freshness, ownerTransitionAlertsFile);
    renderStrategyValidation(strategyValidation, strategyInbox || latest.strategyInbox || null);

    renderExecutionStatus(executionStatusFile || latest.executionStatus || null);

    renderLatest(latest);
    renderDeltaSparkline(trend);
    renderTrend(trend);
    renderAlerts(alerts);
    renderMilestones(milestones);

    lastGoodLatest = latest;
    setHealthHttp(true);

    lastSuccessTs = Date.now();
    const snapshotMarker = latest.generatedAt || latest.ts || null;
    if (snapshotMarker) {
      if (snapshotMarker !== lastSeenGeneratedAt) {
        lastSeenGeneratedAt = snapshotMarker;
        staleSinceTs = null;
      } else if (!staleSinceTs) {
        staleSinceTs = Date.now();
      }
    }

    const nowMs = Date.now();
    renderSystemScore(
      computeSystemScore({
        latest,
        trend,
        staleSinceTs,
        nowMs,
      })
    );

    document.getElementById("lastRefresh").innerText =
      "Last refresh: " + nowStr();

    refreshHealthBanner();

    setStatus("OK — dashboard synced", "status-ok");
  } catch (err) {
    setHealthHttp(false);
    refreshHealthBanner();
    setStatus(`ERROR — ${err.message}`, "status-error");
  } finally {
    isRefreshing = false;
  }
}

document.getElementById("refreshBtn")?.addEventListener("click", refreshDashboard);
window.__npSetStrategyMode = function (mode) {
  setStrategyMode(mode);
  refreshDashboard();
};

refreshDashboard();
setInterval(refreshDashboard, REFRESH_MS);

// Live-updating snapshot age + data freshness (no extra fetch)
setInterval(refreshHealthBanner, 1000);

// ---------- WATCHDOG ----------
setInterval(() => {
  if (!lastSuccessTs) return;

  const now = Date.now();
  const httpDiff = now - lastSuccessTs;

  // HTTP/data access freshness: dashboard cannot sync JSON
  if (httpDiff > 30000) {
    setStatus("ALERT — dashboard cannot refresh JSON > 30s", "status-error");
    return;
  }
  if (httpDiff > 15000) {
    setStatus("WARNING — dashboard refresh lag > 15s", "status-loading");
    return;
  }

  // Business freshness: JSON is reachable but snapshot is not changing.
  if (!staleSinceTs) return;
  const staleDiff = now - staleSinceTs;
  if (staleDiff > 30000) {
    setStatus("ALERT — snapshot not changing > 30s", "status-error");
    return;
  }
  if (staleDiff > 15000) {
    setStatus("WARNING — snapshot not changing > 15s", "status-loading");
  }
}, 5000);
