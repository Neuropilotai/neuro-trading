(function () {
  'use strict';

  const TOKEN_KEY = 'np_operator_bearer_token';
  const REFRESH_MS = 12000;

  const state = {
    lastUpdated: null,
    overview: null,
    execHealth: null,
    autoHistory: null,
    autoRejections: null,
    autoOpen: null,
    securityStatus: null,
    securityAudit: null,
    errors: {},
  };

  function $(id) {
    return document.getElementById(id);
  }

  function getToken() {
    return (localStorage.getItem(TOKEN_KEY) || '').trim();
  }

  function saveToken() {
    const v = ($('tokenInput') && $('tokenInput').value) || '';
    localStorage.setItem(TOKEN_KEY, v.trim());
  }

  function pill(text, kind) {
    const k = kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : kind === 'bad' ? 'bad' : 'neutral';
    return `<span class="pill ${k}">${escapeHtml(String(text))}</span>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function fetchJson(path, options) {
    const headers = Object.assign({ Accept: 'application/json' }, (options && options.headers) || {});
    const tok = getToken();
    if (tok && options && options.auth !== false) {
      headers.Authorization = 'Bearer ' + tok;
    }
    const r = await fetch(path, { headers, method: (options && options.method) || 'GET', body: (options && options.body) || undefined });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error(`Non-JSON ${r.status}: ${text.slice(0, 200)}`);
    }
    if (!r.ok) {
      const msg = (json && (json.error || json.message)) || r.statusText || 'HTTP ' + r.status;
      const err = new Error(msg);
      err.status = r.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  function fmtNum(x) {
    if (x == null || x === '') return '—';
    const n = Number(x);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : escapeHtml(String(x));
  }

  function fmtIso(t) {
    if (!t) return '—';
    try {
      return new Date(t).toLocaleString();
    } catch (e) {
      return String(t);
    }
  }

  function healthKind(ok, warn) {
    if (ok === false) return 'bad';
    if (warn) return 'warn';
    return 'ok';
  }

  function deriveBlockers() {
    const out = [];
    const o = state.overview && state.overview.sections;
    if (!o) return ['Overview not loaded yet'];

    const cap = o.capitalSafety && o.capitalSafety.ok && o.capitalSafety.data;
    if (cap) {
      if (cap.globalKillSwitch) out.push('GLOBAL_TRADING_KILL_SWITCH is active');
      if (cap.autonomousKillSwitch) out.push('AUTONOMOUS_TRADING_KILL_SWITCH is active');
    }

    const h = o.health && o.health.ok && o.health.data;
    if (h) {
      if (h.killSwitch) out.push('Execution kill switch / emergency path active');
      if (h.tradingMode && String(h.tradingMode).toLowerCase() === 'live') out.push('TRADING_MODE is live (review execution guards)');
    }

    const auto = o.autonomous && o.autonomous.ok && o.autonomous.data;
    if (auto) {
      if (auto.enabled && !auto.running) out.push('Autonomous engine enabled but not running');
      if (auto.lastNoCandidateSummary && auto.lastNoCandidateSummary.summary) {
        auto.lastNoCandidateSummary.summary.forEach((row) => {
          const parts = [];
          if (row.br && row.br.length) parts.push('breakout: ' + row.br.join('; '));
          if (row.pb && row.pb.length) parts.push('pullback: ' + row.pb.join('; '));
          if (parts.length) out.push('No candidates (' + row.symbol + '): ' + parts.join(' | '));
        });
      }
      if ((auto.candidatesSeen || 0) === 0 && auto.running && (auto.metrics && auto.metrics.lastScan && auto.metrics.lastScan.rawCandidatesDetected === 0)) {
        out.push('Engine running but detector emitted 0 raw candidates (see diagnostics / price window)');
      }
    }

    const pol = o.policy && o.policy.ok && o.policy.data;
    if (pol && pol.globalPolicy) {
      const mode = String(pol.globalPolicy.portfolioRiskMode || '').toLowerCase();
      if (mode === 'defensive' || mode === 'degraded') out.push('Policy portfolio mode is ' + mode);
    }

    if (out.length === 0) return ['No obvious blockers detected (still verify governance + risk).'];
    return out;
  }

  function renderSystemOverview() {
    const el = $('sectionA');
    const o = state.overview && state.overview.sections;
    if (!state.overview) {
      el.innerHTML = '<div class="hint">Loading…</div>';
      return;
    }
    if (!state.overview.ok) {
      el.innerHTML = '<div class="errbox">' + escapeHtml(state.overview.error || 'overview failed') + '</div>';
      return;
    }

    const h = o.health && o.health.ok && o.health.data;
    const cap = o.capitalSafety && o.capitalSafety.ok && o.capitalSafety.data;
    const acc = h && h.account ? h.account : {};
    const blockers = deriveBlockers();

    const mode = h ? String(h.tradingMode || '—') : '—';
    const paperOnly = cap && cap.paperOnlyEnforced;
    const capOk = !(cap && (cap.globalKillSwitch || cap.autonomousKillSwitch));

    el.innerHTML = `
      <div class="grid cols-4">
        <div class="card">
          <h3>Service</h3>
          <div class="metric"><span class="k">Trading mode</span><span class="v">${pill(mode, mode === 'paper' ? 'ok' : 'warn')}</span></div>
          <div class="metric"><span class="k">Broker</span><span class="v">${escapeHtml(String(h && h.brokerType || '—'))}</span></div>
          <div class="metric"><span class="k">Broker connected</span><span class="v">${h && h.brokerConnected != null ? pill(h.brokerConnected ? 'yes' : 'no', h.brokerConnected ? 'ok' : 'warn') : '—'}</span></div>
          <div class="metric"><span class="k">Kill switch</span><span class="v">${pill(h && h.killSwitch ? 'ON' : 'off', h && h.killSwitch ? 'bad' : 'ok')}</span></div>
          <div class="metric"><span class="k">Learning</span><span class="v">${pill(h && h.learningEnabled ? 'on' : 'off', h && h.learningEnabled ? 'ok' : 'neutral')}</span></div>
          <div class="metric"><span class="k">Autonomous (env)</span><span class="v">${pill(h && h.autonomousEnabled ? 'enabled' : 'disabled', h && h.autonomousEnabled ? 'ok' : 'neutral')}</span></div>
        </div>
        <div class="card">
          <h3>Account</h3>
          <div class="metric"><span class="k">Equity</span><span class="v">${fmtNum(acc.equity)}</span></div>
          <div class="metric"><span class="k">Balance</span><span class="v">${fmtNum(acc.balance)}</span></div>
          <div class="metric"><span class="k">Total PnL</span><span class="v">${fmtNum(acc.totalPnL)}</span></div>
          <div class="metric"><span class="k">Daily PnL</span><span class="v">${fmtNum(acc.dailyPnL)}</span></div>
          <div class="metric"><span class="k">Open positions</span><span class="v">${fmtNum((acc.positions || []).length)}</span></div>
          <div class="metric"><span class="k">Unrealized PnL</span><span class="v">${fmtNum(acc.unrealizedPnL)}</span></div>
        </div>
        <div class="card">
          <h3>Pricing</h3>
          <div class="metric"><span class="k">MTM quote path</span><span class="v">${escapeHtml(String((h && h.pricing && h.pricing.pricingMode) || '—'))}</span></div>
          <div class="metric"><span class="k">Latency (ms)</span><span class="v">${fmtNum(h && h.pricing && h.pricing.priceLatency)}</span></div>
        </div>
        <div class="card">
          <h3>Safety</h3>
          <div class="metric"><span class="k">Execution mode</span><span class="v">${escapeHtml(String(cap && cap.executionMode || '—'))}</span></div>
          <div class="metric"><span class="k">Live enabled</span><span class="v">${pill(cap && cap.liveExecutionEnabled ? 'yes' : 'no', cap && !cap.liveExecutionEnabled ? 'ok' : 'warn')}</span></div>
          <div class="metric"><span class="k">Paper enforced</span><span class="v">${pill(paperOnly ? 'yes' : 'no', paperOnly ? 'ok' : 'warn')}</span></div>
          <div class="metric"><span class="k">Global kill</span><span class="v">${pill(cap && cap.globalKillSwitch ? 'ON' : 'off', cap && cap.globalKillSwitch ? 'bad' : 'ok')}</span></div>
          <div class="metric"><span class="k">Autonomous kill</span><span class="v">${pill(cap && cap.autonomousKillSwitch ? 'ON' : 'off', cap && cap.autonomousKillSwitch ? 'bad' : 'ok')}</span></div>
          <div class="metric"><span class="k">Capital safety</span><span class="v">${pill(capOk ? 'healthy' : 'BLOCKED', capOk ? 'ok' : 'bad')}</span></div>
        </div>
      </div>
      <div class="blockers" style="margin-top:12px">
        <strong>Why might trades be blocked?</strong>
        <ul>${blockers.map((b) => '<li>' + escapeHtml(b) + '</li>').join('')}</ul>
      </div>
    `;
  }

  function renderAutonomous() {
    const el = $('sectionB');
    const o = state.overview && state.overview.sections;
    const auto = o && o.autonomous && o.autonomous.ok && o.autonomous.data;
    if (!auto) {
      el.innerHTML = '<div class="hint">No autonomous data</div>';
      return;
    }

    const sc = auto.safetyChecks || {};
    const det = (auto.metrics && auto.metrics.lastScan && auto.metrics.lastScan.detectorDiagnostics) || [];
    const open =
      (state.autoOpen && state.autoOpen.positions) ||
      (Array.isArray(state.autoOpen) ? state.autoOpen : []) ||
      [];

    el.innerHTML = `
      <div class="grid cols-3">
        <div class="card">
          <h3>Engine</h3>
          <div class="metric"><span class="k">Enabled</span><span class="v">${pill(auto.enabled, auto.enabled ? 'ok' : 'neutral')}</span></div>
          <div class="metric"><span class="k">Running</span><span class="v">${pill(auto.running, auto.running ? 'ok' : 'warn')}</span></div>
          <div class="metric"><span class="k">Scan interval</span><span class="v">${fmtNum(auto.scanIntervalSeconds)}s</span></div>
          <div class="metric"><span class="k">Exit interval</span><span class="v">${fmtNum(auto.exitIntervalSeconds)}s</span></div>
          <div class="metric"><span class="k">Symbols</span><span class="v">${escapeHtml((auto.symbols || []).join(', '))}</span></div>
          <div class="metric"><span class="k">Last scan</span><span class="v">${fmtIso(auto.lastScanAt)}</span></div>
          <div class="metric"><span class="k">Last exit check</span><span class="v">${fmtIso(auto.lastExitCheckAt)}</span></div>
          <div class="metric"><span class="k">Last execution</span><span class="v">${fmtIso(auto.lastExecutionAt)}</span></div>
        </div>
        <div class="card">
          <h3>Throughput</h3>
          <div class="metric"><span class="k">Candidates seen</span><span class="v">${fmtNum(auto.candidatesSeen)}</span></div>
          <div class="metric"><span class="k">Accepted</span><span class="v">${fmtNum(auto.candidatesAccepted)}</span></div>
          <div class="metric"><span class="k">Rejected</span><span class="v">${fmtNum(auto.candidatesRejected)}</span></div>
          <div class="metric"><span class="k">Entries executed</span><span class="v">${fmtNum(auto.entriesExecuted)}</span></div>
          <div class="metric"><span class="k">Exits executed</span><span class="v">${fmtNum(auto.exitsExecuted)}</span></div>
          <div class="metric"><span class="k">Open autonomous</span><span class="v">${fmtNum(auto.currentOpenAutonomousPositions)}</span></div>
        </div>
        <div class="card">
          <h3>Detectors / safety</h3>
          <div class="metric"><span class="k">Breakout</span><span class="v">${auto.detectorEnabled && auto.detectorEnabled.breakout ? pill('on', 'ok') : pill('off', 'neutral')}</span></div>
          <div class="metric"><span class="k">Pullback</span><span class="v">${auto.detectorEnabled && auto.detectorEnabled.pullback ? pill('on', 'ok') : pill('off', 'neutral')}</span></div>
          <div class="metric"><span class="k">paperOnlyEnforced</span><span class="v">${pill(auto.paperOnlyEnforced ? 'yes' : 'no', 'ok')}</span></div>
          <div class="metric"><span class="k">safetyChecks</span><span class="v"><pre class="json" style="max-height:120px">${escapeHtml(JSON.stringify(sc, null, 2))}</pre></span></div>
        </div>
      </div>
      <h3 class="hint" style="margin:12px 0 6px">Last no-candidate summary</h3>
      <pre class="json">${escapeHtml(JSON.stringify(auto.lastNoCandidateSummary || null, null, 2))}</pre>
      <h3 class="hint" style="margin:12px 0 6px">Last rejection summary</h3>
      <pre class="json">${escapeHtml(JSON.stringify(auto.lastRejectionSummary || null, null, 2))}</pre>
      <h3 class="hint" style="margin:12px 0 6px">Detector diagnostics (latest scan)</h3>
      <pre class="json">${escapeHtml(JSON.stringify(det, null, 2))}</pre>
      <h3 class="hint" style="margin:12px 0 6px">Autonomous open positions (detail)</h3>
      ${tableFromRows(
        ['Symbol', 'Qty', 'Avg', 'Strategy', 'Autonomous', 'Max hold'],
        open.map((p) => [
          p.symbol,
          p.quantity,
          p.avgPrice,
          p.strategy || p.autonomousStrategy || '—',
          p.autonomousTag ? 'yes' : 'no',
          p.maxHoldingMinutes != null ? p.maxHoldingMinutes : '—',
        ])
      )}
    `;
  }

  function tableFromRows(headers, rows) {
    if (!rows || !rows.length) return '<p class="hint">No rows</p>';
    const th = headers.map((h) => '<th>' + escapeHtml(h) + '</th>').join('');
    const tr = rows
      .map((r) => '<tr>' + r.map((c) => '<td>' + escapeHtml(String(c == null ? '—' : c)) + '</td>').join('') + '</tr>')
      .join('');
    return `<table class="data"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  }

  function renderGovernance() {
    const el = $('sectionC');
    const o = state.overview && state.overview.sections;
    if (!o || !state.overview.ok) {
      el.innerHTML = '';
      return;
    }
    const pol = o.policy && o.policy.ok && o.policy.data;
    const alloc = o.allocation && o.allocation.ok && o.allocation.data;
    const ov = o.overlap && o.overlap.ok && o.overlap.data;
    const stab = o.stability && o.stability.ok && o.stability.data;
    const learn = o.learning && o.learning.ok && o.learning.data;

    const gp = pol && pol.globalPolicy ? pol.globalPolicy : {};

    el.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h3>Policy</h3>
          <div class="metric"><span class="k">Version</span><span class="v">${escapeHtml(String(pol && pol.policyVersion != null ? pol.policyVersion : '—'))}</span></div>
          <div class="metric"><span class="k">Generated</span><span class="v">${fmtIso(pol && pol.generatedAt)}</span></div>
          <div class="metric"><span class="k">Health score</span><span class="v">${fmtNum(pol && pol.policyHealthScore)}</span></div>
          <div class="metric"><span class="k">Cost-adjusted health</span><span class="v">${fmtNum(pol && pol.costAdjustedPolicyHealthScore)}</span></div>
          <div class="metric"><span class="k">Exec realism warnings</span><span class="v">${escapeHtml(JSON.stringify(pol && pol.executionRealismWarnings || []))}</span></div>
          <div class="metric"><span class="k">Net edge gap (gross−net)</span><span class="v">${fmtNum(pol && pol.netEdgeDegradation)}</span></div>
          <div class="metric"><span class="k">Portfolio mode</span><span class="v">${escapeHtml(String(gp.portfolioRiskMode || '—'))}</span></div>
          <div class="metric"><span class="k">Stability flags</span><span class="v">${escapeHtml(JSON.stringify(pol && pol.stabilityFlags || []))}</span></div>
          <div class="metric"><span class="k">Top promoted</span><span class="v"><pre class="json" style="max-height:80px">${escapeHtml(JSON.stringify((pol && pol.topPromoted) || [], null, 2))}</pre></span></div>
        </div>
        <div class="card">
          <h3>Allocation</h3>
          <div class="metric"><span class="k">Version</span><span class="v">${escapeHtml(String(alloc && alloc.allocationVersion || '—'))}</span></div>
          <div class="metric"><span class="k">Generated</span><span class="v">${fmtIso(alloc && alloc.generatedAt)}</span></div>
          <div class="metric"><span class="k">Deployable %</span><span class="v">${fmtNum(alloc && alloc.deployableCapitalPct)}</span></div>
          <div class="metric"><span class="k">Min cash reserve %</span><span class="v">${fmtNum(alloc && alloc.minCashReservePct)}</span></div>
          <div class="metric"><span class="k">Crowding adjusted</span><span class="v">${alloc && alloc.crowdingAdjusted ? pill('yes', 'warn') : pill('no', 'ok')}</span></div>
          <div class="metric"><span class="k">Binding readiness</span><span class="v">${fmtNum(alloc && alloc.bindingReadinessScore)}</span></div>
          <div class="metric"><span class="k">Capital efficiency</span><span class="v">${fmtNum(alloc && alloc.capitalEfficiencyScore)}</span></div>
          <pre class="json">${escapeHtml(JSON.stringify((alloc && alloc.allocationWarnings) || [], null, 2))}</pre>
        </div>
        <div class="card">
          <h3>Overlap / crowding</h3>
          <div class="metric"><span class="k">Total crowding</span><span class="v">${fmtNum(ov && ov.totalCrowdingScore)}</span></div>
          <div class="metric"><span class="k">Symbol / strategy</span><span class="v">${fmtNum(ov && ov.symbolCrowdingScore)} / ${fmtNum(ov && ov.strategyCrowdingScore)}</span></div>
          <div class="metric"><span class="k">False diversification</span><span class="v">${fmtNum(ov && ov.falseDiversificationScore)}</span></div>
          <div class="metric"><span class="k">Duplicate edge</span><span class="v">${fmtNum(ov && ov.duplicateEdgeScore)}</span></div>
          <pre class="json">${escapeHtml(JSON.stringify((ov && ov.topCrowdedClusters) || [], null, 2))}</pre>
        </div>
        <div class="card">
          <h3>Stability / learning</h3>
          <div class="metric"><span class="k">Overall stability</span><span class="v">${fmtNum(stab && (stab.summary && stab.summary.overallStabilityScore))}</span></div>
          <div class="metric"><span class="k">Instability flags</span><span class="v">${escapeHtml(JSON.stringify((stab && stab.summary && stab.summary.instabilityFlags) || []))}</span></div>
          <pre class="json">${escapeHtml(JSON.stringify(learn || {}, null, 2))}</pre>
        </div>
      </div>
    `;
  }

  function renderExecution() {
    const el = $('sectionG');
    const o = state.overview && state.overview.sections;
    if (!el) return;
    if (!o || !state.overview.ok) {
      el.innerHTML = '<div class="hint">Loading…</div>';
      return;
    }
    const ex = o.execution && o.execution.ok && o.execution.data;
    if (!ex) {
      el.innerHTML =
        '<div class="hint">Execution realism unavailable (section failed soft). Enable closed-trade analytics.</div>';
      return;
    }
    const ws = ex.executionRealismWarnings || [];
    el.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h3>Costs &amp; quality</h3>
          <div class="metric"><span class="k">Trades used</span><span class="v">${fmtNum(ex.tradesUsed)}</span></div>
          <div class="metric"><span class="k">Avg total exec cost (bps)</span><span class="v">${fmtNum(ex.avgTotalExecutionCostBps)}</span></div>
          <div class="metric"><span class="k">Avg spread / slip / fee (bps)</span><span class="v">${fmtNum(ex.avgSpreadCostBps)} / ${fmtNum(ex.avgSlippageCostBps)} / ${fmtNum(ex.avgFeeCostBps)}</span></div>
          <div class="metric"><span class="k">Gross vs net PnL gap</span><span class="v">${fmtNum(ex.grossVsNetPnLGap)}</span></div>
          <div class="metric"><span class="k">Gross win % / net win %</span><span class="v">${fmtNum(ex.grossWinRate)} / ${fmtNum(ex.costAdjustedWinRate)}</span></div>
          <div class="metric"><span class="k">Cost flips win→loss %</span><span class="v">${fmtNum(ex.percentTradesWhereCostsFlippedGrossWinToNetLoss)}</span></div>
          <div class="metric"><span class="k">Poor fill %</span><span class="v">${fmtNum(ex.percentTradesWithPoorFillQuality)}</span></div>
          <div class="metric"><span class="k">Open book (entry leg)</span><span class="v">${ex.openBookExecution && ex.openBookExecution.openPositionCount ? fmtNum(ex.openBookExecution.openPositionCount) + ' pos, ' + fmtNum(ex.openBookExecution.positionsWithFriction) + ' w/ friction' : '—'}</span></div>
          <div class="metric"><span class="k">Gap fill from open book</span><span class="v">${ex.openBookFillsSummaryGaps ? pill('yes', 'warn') : pill('no', 'ok')}</span></div>
        </div>
        <div class="card">
          <h3>Warnings &amp; worst actors</h3>
          <div class="metric"><span class="k">Flags</span><span class="v">${ws.length ? ws.map((w) => pill(w, 'warn')).join(' ') : pill('none', 'ok')}</span></div>
          <pre class="json" style="max-height:120px">${escapeHtml(JSON.stringify(ex.worstExecutionSymbols || [], null, 2))}</pre>
          <pre class="json" style="max-height:120px">${escapeHtml(JSON.stringify(ex.worstExecutionStrategies || [], null, 2))}</pre>
        </div>
      </div>
      <p class="hint">Last trade diagnostics: see <code>/api/execution/recent</code> · Snapshot file <code>execution_quality_latest.json</code></p>
    `;
  }

  function renderPositions() {
    const el = $('sectionD');
    const o = state.overview && state.overview.sections;
    const h = o && o.health && o.health.ok && o.health.data;
    const acc = h && h.account ? h.account : {};
    const pos = Array.isArray(acc.positions) ? acc.positions : [];

    const sh = o && o.shadow && o.shadow.ok ? o.shadow.data : null;

    const hist = (state.autoHistory && state.autoHistory.entries) || [];
    const rej = (state.autoRejections && state.autoRejections.entries) || [];

    el.innerHTML = `
      <h3 class="hint">Open positions (account)</h3>
      ${tableFromRows(
        ['Symbol', 'Side', 'Qty', 'Avg', 'Value', 'uPnL', 'Auto', 'Strategy'],
        pos.map((p) => [
          p.symbol,
          p.side || '—',
          p.quantity,
          p.avgPrice,
          p.currentValue || p.bookValue,
          p.unrealizedPnL,
          p.autonomousTag ? 'yes' : 'no',
          p.strategy || p.autonomousStrategy || '—',
        ])
      )}
      <h3 class="hint" style="margin-top:14px">Latest shadow allocation</h3>
      <pre class="json">${escapeHtml(JSON.stringify(sh || null, null, 2))}</pre>
      <h3 class="hint" style="margin-top:14px">Recent autonomous history</h3>
      ${tableFromRows(
        ['Time', 'Symbol', 'Decision', 'Reason', 'Score', 'Exec'],
        (Array.isArray(hist) ? hist : []).slice(0, 20).map((r) => [
          fmtIso(r.generatedAt),
          r.symbol,
          r.finalDecision,
          (r.primaryRejectionCode || r.finalReason || '').toString().slice(0, 40),
          r.score,
          r.executed ? 'yes' : 'no',
        ])
      )}
      <h3 class="hint" style="margin-top:14px">Recent rejections</h3>
      ${tableFromRows(
        ['Time', 'Symbol', 'Code', 'Score'],
        (Array.isArray(rej) ? rej : []).slice(0, 15).map((r) => [
          fmtIso(r.generatedAt),
          r.symbol,
          r.primaryRejectionCode || r.finalReason,
          r.score,
        ])
      )}
    `;
  }

  function renderSecurity() {
    const el = $('sectionE');
    const s = state.securityStatus;
    const a = state.securityAudit;

    let statusHtml = '<div class="hint">Loading security…</div>';
    if (s && s.ok === false) {
      statusHtml =
        '<div class="errbox">' +
        escapeHtml(s.error || 'failed') +
        (s.status === 401 || s.status === 403 ? ' — add operator token for /api/security/*' : '') +
        '</div>';
    } else if (s && s.ok && s.response) {
      const raw = s.response;
      const d = raw.status != null ? raw.status : raw;
      statusHtml = `
        <div class="grid cols-3">
          <div class="card">
            <h3>Mode</h3>
            <div class="metric"><span class="k">executionMode</span><span class="v">${escapeHtml(String(d.executionMode))}</span></div>
            <div class="metric"><span class="k">paperOnlyEnforced</span><span class="v">${pill(d.paperOnlyEnforced, d.paperOnlyEnforced ? 'ok' : 'warn')}</span></div>
            <div class="metric"><span class="k">liveExecutionEnabled</span><span class="v">${pill(d.liveExecutionEnabled ? 'yes' : 'no', !d.liveExecutionEnabled ? 'ok' : 'warn')}</span></div>
            <div class="metric"><span class="k">Webhook HMAC</span><span class="v">${pill(d.webhookHmacEnabled ? 'on' : 'off', d.webhookHmacEnabled ? 'ok' : 'neutral')}</span></div>
            <div class="metric"><span class="k">Legacy body secret</span><span class="v">${pill(d.legacyBodySecretEnabled ? 'allowed' : 'off', 'neutral')}</span></div>
            <div class="metric"><span class="k">Replay protection</span><span class="v">${pill(d.replayProtectionEnabled ? 'on' : 'off', 'ok')}</span></div>
            <div class="metric"><span class="k">Admin auth configured</span><span class="v">${pill(d.adminAuthEnabled ? 'yes' : 'no', d.adminAuthEnabled ? 'ok' : 'warn')}</span></div>
          </div>
          <div class="card">
            <h3>Kill switches</h3>
            <div class="metric"><span class="k">global</span><span class="v">${pill(d.globalKillSwitch ? 'ON' : 'off', d.globalKillSwitch ? 'bad' : 'ok')}</span></div>
            <div class="metric"><span class="k">autonomous</span><span class="v">${pill(d.autonomousKillSwitch ? 'ON' : 'off', d.autonomousKillSwitch ? 'bad' : 'ok')}</span></div>
            <div class="metric"><span class="k">audit log</span><span class="v">${pill(d.auditLogHealthy ? 'healthy' : 'degraded', d.auditLogHealthy ? 'ok' : 'warn')}</span></div>
          </div>
          <div class="card">
            <h3>Warnings</h3>
            <pre class="json">${escapeHtml(JSON.stringify(d.securityWarnings || [], null, 2))}</pre>
          </div>
        </div>`;
    }

    let auditHtml = '<div class="hint">Audit: provide operator token for /api/security/audit</div>';
    if (a && a.ok === false) {
      auditHtml = '<div class="errbox">' + escapeHtml(a.error || 'audit failed') + '</div>';
    } else if (a && a.entries && a.entries.length) {
      auditHtml = tableFromRows(
        ['Time', 'Type', 'Severity', 'Outcome', 'Reason', 'Route'],
        a.entries.slice(0, 35).map((r) => [
          fmtIso(r.generatedAt),
          r.eventType,
          r.severity,
          r.outcome,
          (r.reason || '').toString().slice(0, 48),
          (r.route || '').toString().slice(0, 32),
        ])
      );
    } else if (a && a.entries && a.entries.length === 0) {
      auditHtml = '<p class="hint">No audit entries yet</p>';
    }

    el.innerHTML = statusHtml + '<h3 class="hint" style="margin:14px 0 6px">Recent audit</h3>' + auditHtml;
  }

  function renderActions() {
    const tok = !!getToken();
    const el = $('sectionF');
    const btns = [
      { id: 'btnRefresh', label: 'Refresh all', primary: true, action: () => loadAll() },
      { id: 'btnScan', label: 'Run autonomous scan', action: () => postAction('/api/autonomous/run-scan') },
      { id: 'btnExit', label: 'Run autonomous exits', action: () => postAction('/api/autonomous/run-exits') },
      { id: 'btnStart', label: 'Start autonomous', action: () => postAction('/api/autonomous/start') },
      { id: 'btnStop', label: 'Stop autonomous', action: () => postAction('/api/autonomous/stop'), danger: true },
      { id: 'btnPolicy', label: 'Run policy cycle', action: () => postAction('/api/policy/run') },
      { id: 'btnOverlap', label: 'Run overlap cycle', action: () => postAction('/api/overlap/run') },
      { id: 'btnAlloc', label: 'Run allocation', action: () => postAction('/api/allocation/run') },
    ];
    el.innerHTML = `
      <div class="actions-row">
        ${btns
          .map((b) => {
            const dis = !tok && b.id !== 'btnRefresh' ? 'disabled' : '';
            const cls = b.primary ? 'primary' : b.danger ? 'danger' : '';
            return `<button type="button" id="${b.id}" class="${cls}" ${dis}>${escapeHtml(b.label)}</button>`;
          })
          .join('')}
      </div>
      <p class="note">Protected actions require a Bearer token (operator/admin) saved above. Refresh works without a token.</p>
      <div id="actionResult" class="hint"></div>
    `;
    $('btnRefresh').addEventListener('click', () => loadAll());
    btns.forEach((b) => {
      if (b.id === 'btnRefresh') return;
      const node = $(b.id);
      if (node) node.addEventListener('click', b.action);
    });
  }

  async function postAction(path) {
    const out = $('actionResult');
    out.textContent = 'Calling ' + path + '…';
    try {
      await fetchJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      out.textContent = 'OK ' + path + ' — refresh to see updates';
      await loadAll();
    } catch (e) {
      out.textContent = 'Error: ' + e.message + (e.status === 401 || e.status === 403 ? ' (auth required)' : '');
    }
  }

  async function loadAll() {
    $('lastUpdated').textContent = 'Updating…';
    state.errors = {};

    const tasks = [
      fetchJson('/api/operator/overview')
        .then((d) => {
          state.overview = d;
        })
        .catch((e) => {
          state.overview = { ok: false, error: e.message };
        }),
      fetchJson('/api/autonomous/history?limit=25')
        .then((d) => {
          state.autoHistory = d;
        })
        .catch((e) => {
          state.autoHistory = { ok: false, error: e.message };
        }),
      fetchJson('/api/autonomous/rejections?limit=20')
        .then((d) => {
          state.autoRejections = d;
        })
        .catch((e) => {
          state.autoRejections = { ok: false, error: e.message };
        }),
      fetchJson('/api/autonomous/open-positions')
        .then((d) => {
          state.autoOpen = d;
        })
        .catch((e) => {
          state.autoOpen = { ok: false, error: e.message };
        }),
      fetchJson('/api/security/status')
        .then((d) => {
          state.securityStatus = { ok: true, response: d };
        })
        .catch((e) => {
          state.securityStatus = { ok: false, error: e.message, status: e.status };
        }),
      fetchJson('/api/security/audit?limit=40')
        .then((d) => {
          state.securityAudit = { ok: true, entries: d.entries || [] };
        })
        .catch((e) => {
          state.securityAudit = { ok: false, error: e.message, status: e.status };
        }),
    ];

    await Promise.all(tasks);

    state.lastUpdated = new Date().toISOString();
    $('lastUpdated').textContent = new Date(state.lastUpdated).toLocaleString();
    if (state.overview && state.overview.generatedAt) {
      $('overviewTs').textContent = fmtIso(state.overview.generatedAt);
    }

    renderSystemOverview();
    renderAutonomous();
    renderGovernance();
    renderExecution();
    renderPositions();
    renderSecurity();
    updateActionButtonsDisabled();
  }

  function updateActionButtonsDisabled() {
    const tok = !!getToken();
    ['btnScan', 'btnExit', 'btnStart', 'btnStop', 'btnPolicy', 'btnOverlap', 'btnAlloc'].forEach((id) => {
      const n = $(id);
      if (n) n.disabled = !tok;
    });
  }

  function init() {
    const inp = $('tokenInput');
    if (inp) inp.value = getToken();
    $('saveToken').addEventListener('click', () => {
      saveToken();
      updateActionButtonsDisabled();
      loadAll();
    });
    $('manualRefresh').addEventListener('click', () => loadAll());
    renderActions();
    loadAll();
    setInterval(loadAll, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
