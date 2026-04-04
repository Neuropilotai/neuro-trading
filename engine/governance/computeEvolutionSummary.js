'use strict';

/**
 * Human-readable evolution snapshot for the governance dashboard (read-only).
 * Inputs: champion_registry.json + optional next_generation_report.json.
 * Contract: EVOLUTION_SUMMARY_SCHEMA.md — operator labels, not performance claims.
 */

const EVOLUTION_SUMMARY_SCHEMA_VERSION = '1.0.0';

function num(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function mutationChampionRatioFromRegistry(registry) {
  const md = registry && registry.metadata && typeof registry.metadata === 'object' ? registry.metadata : null;
  const r = md && md.mutationChampionRatio;
  if (Number.isFinite(Number(r))) return Number(r);
  const setups = Array.isArray(registry.setups) ? registry.setups : [];
  const champs = setups.filter((s) => s && s.status === 'champion');
  if (!champs.length) return null;
  const mutN = champs.filter((s) => {
    const id = s.setupId != null ? String(s.setupId) : '';
    if (id.startsWith('mut_')) return true;
    if (s.mutationType != null && String(s.mutationType).trim() !== '') return true;
    const src = s.source != null ? String(s.source) : '';
    return src.includes('mutation');
  }).length;
  return Math.round((mutN / champs.length) * 1e4) / 1e4;
}

function labelElite(championsCount, setupsCount) {
  const c = num(championsCount, -1);
  const s = num(setupsCount, -1);
  if (c < 0 || s <= 0) return 'unknown';
  const ratio = c / s;
  if (ratio <= 0.02) return 'strong';
  if (ratio >= 0.12) return 'weak';
  return 'moderate';
}

function labelMutation(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return 'unknown';
  if (ratio >= 0.55) return 'high';
  if (ratio <= 0.22) return 'low';
  return 'moderate';
}

function labelPromotion(mutationsPromoted) {
  const m = num(mutationsPromoted, -1);
  if (m < 0) return 'unknown';
  if (m === 0) return 'dormant';
  if (m <= 4) return 'low';
  if (m <= 12) return 'active';
  return 'high';
}

function labelDiversity(protectedCount) {
  const n = num(protectedCount, -1);
  if (n < 0) return 'unknown';
  if (n > 0) return 'present';
  return 'absent';
}

function labelPruning(extinctionCount, setupsCount) {
  const e = num(extinctionCount, -1);
  const s = num(setupsCount, -1);
  if (e < 0 || s <= 0) return 'unknown';
  if (e === 0 && s >= 200) return 'weak';
  if (e >= 10 || e / s >= 0.015) return 'active';
  if (e === 0) return 'moderate';
  return 'moderate';
}

function labelExploration(childrenGenerated) {
  if (childrenGenerated == null) return 'unknown';
  const n = num(childrenGenerated, -1);
  if (n < 0) return 'unknown';
  return n > 0 ? 'on' : 'off';
}

function buildLine(o) {
  const parts = [
    `elite:${o.elite}`,
    `mutation:${o.mutation}`,
    `promotion:${o.promotion}`,
    `diversity:${o.diversity}`,
    `pruning:${o.pruning}`,
    `exploration:${o.exploration}`,
  ];
  return parts.join(' | ');
}

/**
 * @param {object} input
 * @param {object|null} input.championRegistry — parsed champion_registry.json
 * @param {object|null} input.nextGenerationReport — parsed next_generation_report.json
 * @param {object|null} input.paths — { championRegistry, nextGenerationReport } for audit
 */
function computeEvolutionSummary(input = {}) {
  const reg = input.championRegistry && typeof input.championRegistry === 'object' ? input.championRegistry : null;
  const next = input.nextGenerationReport && typeof input.nextGenerationReport === 'object' ? input.nextGenerationReport : null;
  const paths = input.paths && typeof input.paths === 'object' ? input.paths : {};

  if (!reg) {
    return {
      evolutionSummarySchemaVersion: EVOLUTION_SUMMARY_SCHEMA_VERSION,
      labOnly: true,
      source: paths,
      inputs: null,
      elite: 'unknown',
      mutation: 'unknown',
      promotion: 'unknown',
      diversity: 'unknown',
      pruning: 'unknown',
      exploration: 'unknown',
      evolutionSummaryLine: 'elite:unknown | mutation:unknown | promotion:unknown | diversity:unknown | pruning:unknown | exploration:unknown',
    };
  }

  const md = reg.metadata && typeof reg.metadata === 'object' ? reg.metadata : {};
  const setupsCount = num(reg.setupsCount, 0);
  const championsCount = num(reg.championsCount, 0);
  const validatedCount = num(reg.validatedCount, null);
  const mutationsPromoted = num(md.mutationsPromoted, 0);
  const extinctionCount = num(md.extinctionCount, 0);
  const championsProtectedByDiversity = num(md.championsProtectedByDiversity, 0);
  const mutRatio = mutationChampionRatioFromRegistry(reg);
  const childrenGenerated = next != null ? num(next.childrenGenerated, null) : null;

  const elite = labelElite(championsCount, setupsCount);
  const mutation = labelMutation(mutRatio);
  const promotion = labelPromotion(mutationsPromoted);
  const diversity = labelDiversity(championsProtectedByDiversity);
  const pruning = labelPruning(extinctionCount, setupsCount);
  const exploration = labelExploration(childrenGenerated);

  const axes = {
    evolutionSummarySchemaVersion: EVOLUTION_SUMMARY_SCHEMA_VERSION,
    labOnly: true,
    source: paths,
    inputs: {
      setupsCount,
      championsCount,
      validatedCount,
      mutationsPromoted,
      mutationChampionRatio: mutRatio,
      extinctionCount,
      championsProtectedByDiversity,
      childrenGenerated,
    },
    elite,
    mutation,
    promotion,
    diversity,
    pruning,
    exploration,
  };
  axes.evolutionSummaryLine = buildLine(axes);
  return axes;
}

module.exports = {
  computeEvolutionSummary,
  EVOLUTION_SUMMARY_SCHEMA_VERSION,
};
