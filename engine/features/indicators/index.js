'use strict';

/**
 * Indicator modules for the Feature Engine.
 * Each indicator is stateless and can be used independently or via FeatureEngine.
 */
const { ema, emaValue } = require('./ema');
const { atr } = require('./atr');
const { vwap } = require('./vwap');
const { volumeSpike } = require('./volumeSpike');
const { rangeState } = require('./range');
const { volatilityRegime } = require('./volatilityRegime');
const { regimeCandidate, regimeCandidateLabel } = require('./regimeCandidate');

module.exports = {
  ema,
  emaValue,
  atr,
  vwap,
  volumeSpike,
  rangeState,
  volatilityRegime,
  regimeCandidate,
  regimeCandidateLabel,
};
