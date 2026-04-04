'use strict';

/**
 * Opt-in parent-aware mutation dampening for champions (next-gen builder).
 *
 * Enable: NEUROPILOT_MUTATION_HOTSPOT_POLICY=1
 * File:   NEUROPILOT_MUTATION_HOTSPOT_POLICY_FILE=/abs/or/rel/path.json
 *          or first existing of:
 *          - $NEUROPILOT_DATA_ROOT/governance/mutation_hotspot_policy.json
 *          - <repo>/neuropilot_trading_v2/config/mutation_hotspot_policy.json
 *
 * Schema: see config/mutation_hotspot_policy.example.json
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function truthyEnv(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolvePolicyPath(explicitPath) {
  const ep = explicitPath && String(explicitPath).trim();
  if (ep) {
    return path.isAbsolute(ep) ? ep : path.resolve(process.cwd(), ep);
  }
  const dr = path.join(dataRoot.getDataRoot(), 'governance', 'mutation_hotspot_policy.json');
  if (fs.existsSync(dr)) return dr;
  const proj = path.join(__dirname, '..', '..', 'config', 'mutation_hotspot_policy.json');
  if (fs.existsSync(proj)) return proj;
  return null;
}

function parentMatchesRule(parentId, rule) {
  const id = String(parentId || '');
  const m = rule && rule.match;
  if (!m || typeof m !== 'object') return false;
  if (m.equals != null && id === String(m.equals)) return true;
  if (m.prefix != null && id.startsWith(String(m.prefix))) return true;
  if (m.includes != null && id.includes(String(m.includes))) return true;
  return false;
}

/**
 * @param {object} profile - adaptive profile (jitterScale, *Weight fields)
 * @param {string} parentSetupId - champion.setupId
 * @param {object} policyDoc - { rules: [...] }
 * @returns {{ profile: object, appliedRule: object|null }}
 */
function applyHotspotPolicyToProfile(profile, parentSetupId, policyDoc) {
  const out = { ...profile };
  const rules = policyDoc && Array.isArray(policyDoc.rules) ? policyDoc.rules : [];
  for (const rule of rules) {
    if (!rule || !parentMatchesRule(parentSetupId, rule)) continue;
    const patch = rule.profilePatch && typeof rule.profilePatch === 'object' ? rule.profilePatch : {};

    if (patch.jitterScale != null && Number.isFinite(Number(patch.jitterScale))) {
      out.jitterScale = Number(patch.jitterScale);
    }
    if (patch.jitterScaleMultiply != null && Number.isFinite(Number(patch.jitterScaleMultiply))) {
      let j = out.jitterScale * Number(patch.jitterScaleMultiply);
      if (patch.jitterScaleMin != null && Number.isFinite(Number(patch.jitterScaleMin))) {
        j = Math.max(Number(patch.jitterScaleMin), j);
      }
      if (patch.jitterScaleMax != null && Number.isFinite(Number(patch.jitterScaleMax))) {
        j = Math.min(Number(patch.jitterScaleMax), j);
      }
      out.jitterScale = Math.round(j * 1e4) / 1e4;
    }

    if (patch.sessionFlipWeight != null && Number.isFinite(Number(patch.sessionFlipWeight))) {
      out.sessionFlipWeight = Math.max(0, Math.round(Number(patch.sessionFlipWeight)));
    }
    if (patch.regimeFlipWeight != null && Number.isFinite(Number(patch.regimeFlipWeight))) {
      out.regimeFlipWeight = Math.max(0, Math.round(Number(patch.regimeFlipWeight)));
    }
    if (patch.forcedFamilyShiftWeight != null && Number.isFinite(Number(patch.forcedFamilyShiftWeight))) {
      out.forcedFamilyShiftWeight = Math.max(0, Math.round(Number(patch.forcedFamilyShiftWeight)));
    }

    if (patch.modeTag != null && typeof out.mode === 'string') {
      out.mode = `${out.mode}_hotspot_${String(patch.modeTag)}`;
    }

    return {
      profile: out,
      appliedRule: {
        note: rule.note || null,
        match: rule.match || null,
        profilePatch: patch,
      },
    };
  }
  return { profile: out, appliedRule: null };
}

/**
 * @returns {null | { enabled: boolean, path: string|null, doc: object, warning: string|null }}
 */
function loadMutationHotspotPolicy(opts = {}) {
  const force = !!opts.forceEnable;
  if (!force && !truthyEnv(process.env.NEUROPILOT_MUTATION_HOTSPOT_POLICY)) {
    return null;
  }

  const p = resolvePolicyPath(opts.policyPath || process.env.NEUROPILOT_MUTATION_HOTSPOT_POLICY_FILE);
  if (!p || !fs.existsSync(p)) {
    return {
      enabled: true,
      path: p,
      doc: { version: 1, rules: [] },
      warning:
        'NEUROPILOT_MUTATION_HOTSPOT_POLICY is set but no policy file found (set NEUROPILOT_MUTATION_HOTSPOT_POLICY_FILE or add governance/mutation_hotspot_policy.json)',
    };
  }

  const doc = readJsonFile(p);
  if (!doc || !Array.isArray(doc.rules)) {
    return {
      enabled: true,
      path: p,
      doc: { version: 1, rules: [] },
      warning: 'mutation_hotspot_policy.json invalid or missing "rules" array',
    };
  }

  return { enabled: true, path: p, doc, warning: null };
}

module.exports = {
  applyHotspotPolicyToProfile,
  loadMutationHotspotPolicy,
  parentMatchesRule,
  resolvePolicyPath,
};
