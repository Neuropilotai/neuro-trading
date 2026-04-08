'use strict';

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function parseScoringEnv() {
  return {
    minScore: parseFloat(process.env.AUTO_ENTRY_MIN_SCORE || '0.62'),
    minConfidence: parseFloat(process.env.AUTO_ENTRY_MIN_CONFIDENCE || '0.55'),
    maxSpreadProxy: parseFloat(process.env.AUTO_ENTRY_MAX_SPREAD_PROXY || '0.004'),
    minSessionQuality: parseFloat(process.env.AUTO_ENTRY_SESSION_QUALITY_FLOOR || '0.4'),
    breakoutMin: parseFloat(process.env.AUTO_ENTRY_BREAKOUT_MIN || '0.06'),
    pullbackMin: parseFloat(process.env.AUTO_ENTRY_PULLBACK_MIN || '0.22'),
  };
}

function sessionQuality(sessionTag) {
  const s = String(sessionTag || '').toLowerCase();
  if (s === 'london_us') return 0.85;
  if (s === 'asia') return 0.55;
  return 0.35;
}

function scoreAutonomousCandidate(candidate, context = {}) {
  const E = parseScoringEnv();
  const c = candidate || {};
  const f = c.features || {};
  const reasons = [];

  const setupQuality = clamp(Number(c.rawSetupScore) || 0, 0, 1);
  const trendStrength = clamp(Number(f.trendStrength) || 0, 0, 1);
  const breakoutStrength = clamp(Number(f.breakoutStrength) || 0, 0, 1);
  const pullbackDepth = clamp(Number(f.pullbackDepth) || 0, 0, 1);
  const volatility = clamp(Number(f.volatilityProxy) || 0, 0, 0.25);
  const spreadProxy = Math.max(0, Number(f.spreadProxy) || Number(context.spreadProxy) || 0);

  const qSession = sessionQuality(f.sessionTag);
  const regimeAlign = String(c.regime || '') === 'trend' ? 0.75 : 0.5;

  const spreadPenalty = spreadProxy > E.maxSpreadProxy ? clamp((spreadProxy - E.maxSpreadProxy) * 100, 0, 0.45) : 0;
  const duplicatePenalty = clamp(Number(context.duplicatePenalty) || 0, 0, 0.45);
  const cooldownPenalty = clamp(Number(context.cooldownPenalty) || 0, 0, 0.45);
  const executionQualityPenalty = clamp(spreadPenalty + volatility * 0.18, 0, 0.6);

  let qualityScore = 0.22 * setupQuality + 0.22 * trendStrength + 0.2 * breakoutStrength + 0.16 * pullbackDepth + 0.2 * qSession;
  qualityScore = clamp(qualityScore, 0, 1);

  const score = clamp(
    qualityScore * 0.65 +
      regimeAlign * 0.2 +
      (1 - executionQualityPenalty) * 0.15 -
      duplicatePenalty -
      cooldownPenalty,
    0,
    1
  );
  const confidence = clamp(score * 0.75 + setupQuality * 0.25, 0, 1);

  if (spreadPenalty > 0) reasons.push('spread_penalty');
  if (duplicatePenalty > 0) reasons.push('duplicate_penalty');
  if (cooldownPenalty > 0) reasons.push('cooldown_penalty');
  if (qSession < E.minSessionQuality) reasons.push('low_session_quality');
  if (String(c.setupType) === 'breakout_continuation' && breakoutStrength < E.breakoutMin) reasons.push('breakout_below_min');
  if (String(c.setupType) === 'trend_pullback' && pullbackDepth < E.pullbackMin) reasons.push('pullback_below_min');

  const eligiblePreGovernance = score >= E.minScore && confidence >= E.minConfidence && spreadProxy <= E.maxSpreadProxy;
  const scoreBand = score >= 0.8 ? 'A' : score >= 0.68 ? 'B' : score >= E.minScore ? 'C' : 'D';

  return {
    candidateId: c.candidateId || null,
    score: round4(score),
    scoreBand,
    qualityScore: round4(qualityScore),
    executionQualityPenalty: round4(executionQualityPenalty),
    regimeAlignmentScore: round4(regimeAlign),
    spreadPenalty: round4(spreadPenalty),
    duplicatePenalty: round4(duplicatePenalty),
    cooldownPenalty: round4(cooldownPenalty),
    confidence: round4(confidence),
    reasons,
    eligiblePreGovernance,
  };
}

function scoreAutonomousCandidates(candidates, contextByCandidate = {}) {
  const out = [];
  for (const c of candidates || []) {
    out.push(scoreAutonomousCandidate(c, contextByCandidate[c.candidateId] || {}));
  }
  return out;
}

module.exports = {
  parseScoringEnv,
  scoreAutonomousCandidate,
  scoreAutonomousCandidates,
  sessionQuality,
};
