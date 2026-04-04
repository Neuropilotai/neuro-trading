'use strict';

/**
 * Wave 1 — inject parents into Next Generation builder from meta_ranking.json
 * so symbols under-represented among registry champions still produce mutations.
 *
 * Opt-in: NEUROPILOT_WAVE1_NEXT_GEN_INJECTION=1
 *         NEUROPILOT_WAVE1_SYMBOLS=ADAUSDT,XRPUSDT (required)
 * NEUROPILOT_WAVE1_NEXT_GEN_MIN_PARENTS_PER_SYMBOL — default 2; 0 disables injection
 * Floor (optional): NEUROPILOT_WAVE1_NEXT_GEN_MIN_STABILITY overrides;
 *   else if NEUROPILOT_WAVE1_MIN_AVG_META_SCORE is set, used as min stability-like score.
 */

function parseUpperCsvSet(raw) {
  const s = String(raw || '').trim();
  if (!s) return new Set();
  return new Set(s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
}

function envBool(name) {
  const v = (process.env[name] || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function parseSymbolFromAssetKey(asset) {
  const s = String(asset || '');
  const idx = s.lastIndexOf('_');
  if (idx <= 0) return null;
  return s.slice(0, idx).toUpperCase();
}

function collectSymbolsFromMetaRow(row) {
  const out = new Set();
  if (!row || typeof row !== 'object') return out;
  if (row.symbol) out.add(String(row.symbol).toUpperCase());
  const vars = row.variants;
  if (Array.isArray(vars)) {
    for (const v of vars) {
      if (v && v.symbol) out.add(String(v.symbol).toUpperCase());
    }
  }
  const ba = row.byAsset;
  if (Array.isArray(ba)) {
    for (const a of ba) {
      const sym = parseSymbolFromAssetKey(a && a.asset);
      if (sym) out.add(sym);
    }
  }
  return out;
}

function buildMetaBySetupId(metaRows) {
  const map = Object.create(null);
  if (!Array.isArray(metaRows)) return map;
  for (const r of metaRows) {
    if (r && r.setupId) map[String(r.setupId)] = r;
  }
  return map;
}

function countParentsTouchingSymbol(parents, metaBySetupId, sym) {
  let n = 0;
  const upper = String(sym).toUpperCase();
  for (const p of parents) {
    if (!p || !p.setupId) continue;
    const row = metaBySetupId[String(p.setupId)];
    if (!row) continue;
    if (collectSymbolsFromMetaRow(row).has(upper)) n += 1;
  }
  return n;
}

function metaRowScore(row) {
  const stab = Number(row.stability);
  const val = Number(row.validation_score);
  const meta = Number(row.meta_score);
  const tr = Number(row.trades);
  const s = Number.isFinite(stab)
    ? stab
    : Number.isFinite(val)
      ? val
      : Number.isFinite(meta)
        ? meta
        : -Infinity;
  const t = Number.isFinite(tr) ? tr : 0;
  return { s, t };
}

function compareMetaRowsForInjection(a, b) {
  const sa = metaRowScore(a);
  const sb = metaRowScore(b);
  if (sb.s !== sa.s) return sb.s - sa.s;
  if (sb.t !== sa.t) return sb.t - sa.t;
  return String(a.setupId || '').localeCompare(String(b.setupId || ''));
}

function hasNonEmptyRulesRow(row) {
  const r = row && row.rules;
  return !!(r && typeof r === 'object' && Object.keys(r).length);
}

function syntheticChampionFromMetaRow(row) {
  const sc = metaRowScore(row);
  return {
    setupId: String(row.setupId),
    status: 'champion',
    statusReason: 'wave1_next_gen_injection',
    liveStatus: 'active',
    survivalScore: 1,
    nightsSurvived: 0,
    nightsInHistory: 0,
    avgExpectancy: Number.isFinite(Number(row.expectancy)) ? Number(row.expectancy) : null,
    avgMetaScore: Number.isFinite(sc.s) ? sc.s : null,
    momentumMetaScore: Number.isFinite(sc.s) ? sc.s : null,
    lastTrades: Number.isFinite(Number(row.trades)) ? Number(row.trades) : null,
    lastMetaScore: Number.isFinite(sc.s) ? sc.s : null,
    parentSetupId: row.parentSetupId != null ? String(row.parentSetupId) : null,
    parentFamilyId: row.parentFamilyId != null ? String(row.parentFamilyId) : null,
    familyKey: row.familyKey != null ? String(row.familyKey) : null,
    lineageKey: row.familyKey != null ? String(row.familyKey) : String(row.setupId),
    mutationType: row.mutationType != null ? row.mutationType : null,
    source: row.source != null ? String(row.source) : 'meta_wave1_injection',
    generation: Number.isFinite(Number(row.generation)) ? Number(row.generation) : 0,
    lineageDepth: Number.isFinite(Number(row.lineageDepth)) ? Number(row.lineageDepth) : 0,
    rules: row.rules && typeof row.rules === 'object' ? { ...row.rules } : null,
    hasRules: hasNonEmptyRulesRow(row),
    wave1NextGenInjected: true,
  };
}

function passesMinStability(row, minStab) {
  if (minStab == null || !Number.isFinite(minStab)) return true;
  const sc = metaRowScore(row);
  return Number.isFinite(sc.s) && sc.s >= minStab;
}

function resolveMinStabilityFilter() {
  const rawExplicit = process.env.NEUROPILOT_WAVE1_NEXT_GEN_MIN_STABILITY;
  if (rawExplicit !== undefined && String(rawExplicit).trim() !== '') {
    const n = Number(rawExplicit);
    return Number.isFinite(n) ? n : null;
  }
  const w = Number(process.env.NEUROPILOT_WAVE1_MIN_AVG_META_SCORE);
  if (Number.isFinite(w) && w > 0) return w;
  return null;
}

/**
 * @param {Array<object>} champions
 * @param {Array<object>} metaRows
 * @returns {{ champions: Array<object>, audit: object }}
 */
function applyWave1NextGenInjection(champions, metaRows) {
  const baseAudit = {
    enabled: false,
    symbols: [],
    minParentsPerSymbol: 0,
    injectedSetupIds: [],
    injectedParents: [],
    skipped: null,
    minStabilityApplied: null,
    note: null,
  };

  if (!envBool('NEUROPILOT_WAVE1_NEXT_GEN_INJECTION')) {
    return { champions, audit: baseAudit };
  }

  const wave1 = parseUpperCsvSet(process.env.NEUROPILOT_WAVE1_SYMBOLS);
  const audit = { ...baseAudit, enabled: true };

  if (wave1.size === 0) {
    audit.skipped = 'NEUROPILOT_WAVE1_SYMBOLS_empty';
    return { champions, audit };
  }

  const minRaw = process.env.NEUROPILOT_WAVE1_NEXT_GEN_MIN_PARENTS_PER_SYMBOL;
  const minParents =
    minRaw !== undefined && String(minRaw).trim() !== ''
      ? Math.max(0, Math.floor(Number(minRaw)))
      : 2;

  if (!Number.isFinite(minParents) || minParents <= 0) {
    audit.skipped = 'minParentsPerSymbol_disabled_or_zero';
    audit.symbols = Array.from(wave1).sort();
    return { champions, audit };
  }

  audit.symbols = Array.from(wave1).sort();
  audit.minParentsPerSymbol = minParents;
  const minStabilityFilter = resolveMinStabilityFilter();
  audit.minStabilityApplied = minStabilityFilter;

  const metaBySetupId = buildMetaBySetupId(metaRows);
  const used = new Set();
  for (const c of champions) {
    if (c && c.setupId) used.add(String(c.setupId));
  }

  const sortedRows = Array.isArray(metaRows) ? metaRows.slice().sort(compareMetaRowsForInjection) : [];

  const injected = [];
  const pool = () => [...injected, ...champions];

  for (const sym of audit.symbols) {
    let need = minParents - countParentsTouchingSymbol(pool(), metaBySetupId, sym);
    if (need <= 0) continue;

    for (const row of sortedRows) {
      if (need <= 0) break;
      if (!row || !row.setupId || !hasNonEmptyRulesRow(row)) continue;
      if (!passesMinStability(row, minStabilityFilter)) continue;
      const id = String(row.setupId);
      if (used.has(id)) continue;
      if (!collectSymbolsFromMetaRow(row).has(sym)) continue;

      injected.push(syntheticChampionFromMetaRow(row));
      used.add(id);
      need -= 1;
    }
  }

  audit.injectedSetupIds = injected.map((c) => c.setupId);
  audit.injectedParents = injected.map((c) => {
    const row = metaBySetupId[c.setupId] || {};
    return {
      setupId: c.setupId,
      symbolsInMetaRow: Array.from(collectSymbolsFromMetaRow(row)).sort(),
    };
  });

  if (injected.length === 0) {
    audit.note =
      'No meta_ranking strategies matched Wave1 symbols with rules (or coverage already satisfied / stability floor excluded all).';
  }

  return { champions: [...injected, ...champions], audit };
}

module.exports = {
  applyWave1NextGenInjection,
  collectSymbolsFromMetaRow,
  parseUpperCsvSet,
};
