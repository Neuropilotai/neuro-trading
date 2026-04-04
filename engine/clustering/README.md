# Strategy Family Clustering

Group similar setups into **families**, limit how many per family enter the portfolio, and improve champion diversity so you don’t end up with 10 variants of the same “close breakout” idea.

## Goals

- Assign a **familyId** to each setup from metadata / rules.
- **Limit the number of setups per family** in the portfolio (e.g. max 1–2 per family).
- Improve **diversity** of champions.
- Avoid many near-duplicate patterns (e.g. pattern_001_close_*, pattern_002_close_*, …).

## Pipeline integration (target)

```
batch_results
    → meta_ranking (runMetaPipeline)
    → clustering families (clusterStrategyFamilies)
    → family filter (familyPortfolioFilter)
    → strategy_portfolio (buildChampionPortfolio on filtered list)
    → strategyEvolution
```

## Modules

| File | Role |
|------|------|
| **extractFamilyFeatures.js** | Extract family feature buckets from a strategy (regime, sessionPhase, patternBucket, tradeBucket, etc.). Used by clustering; can be used for debugging. |
| **clusterStrategyFamilies.js** | Group strategies into families via a stable **familyKey** (regime \| sessionPhase \| patternBucket \| …). Enriches each strategy with `familyId`, `familyRank`, `familySize`, `familyLeader`. Output: `strategies` + `families` arrays. |
| **familyPortfolioFilter.js** | Take clustered strategies and keep at most **maxPerFamily** per family (default 1). `filterByFamily(clustered, { maxPerFamily: 1, maxStrategies: 12 })`. Optional: `clusterAndFilter(metaRanking, opts)` to cluster then filter in one call. |

## Family signature (familyKey)

Heuristic, stable buckets so “same idea” maps to the same family:

- **regime** — inferred from setupId or fields: breakout, reversal, trend, range, close_bias, open_bias, mid_bias, generic.
- **sessionPhase** — open / mid / close (from setupId pattern like `pattern_001_close_xxx` or strategy fields).
- **patternBucket** — pattern index range: p1_10, p11_25, p26_50, p51_100, p100p.
- **tradeBucket** — t2000p, t1000p, t500p, t200p, t50p, tlt50.
- **expectancyBucket** — e10, e05, e01, epos, ezero, eneg.
- **crossAssetBucket** — ca8, ca6, ca4, ca2, ca0, ca_na.
- **timeframeBucket** — tf8, tf6, tf4, tf2, tf0, tf_na.

`familyId` = readable prefix (regime_sessionPhase_patternBucket) + 8-char hash of familyKey.

## Usage

### CLI (clustering only)

```bash
node engine/clustering/clusterStrategyFamilies.js /path/to/meta_ranking.json
# Writes strategy_families.json in same dir (or pass second arg for output path)
```

### Programmatic

```js
const { clusterStrategyFamilies } = require('./engine/clustering/clusterStrategyFamilies');
const { filterByFamily, clusterAndFilter } = require('./engine/clustering/familyPortfolioFilter');

const meta = require('/path/to/meta_ranking.json');
const clustered = clusterStrategyFamilies(meta);
// clustered.strategies have familyId, familyRank, familySize, familyLeader

const filtered = filterByFamily(clustered.strategies, { maxPerFamily: 1, maxStrategies: 12 });
// Pass filtered to buildChampionPortfolio(filtered, { maxStrategies: 12 })
```

Or in one step:

```js
const { clusterAndFilter } = require('./engine/clustering/familyPortfolioFilter');
const { filtered, clustered } = clusterAndFilter(meta, { maxPerFamily: 1, maxStrategies: 12 });
```

### Integration in runMetaPipeline

After `computeMetaRanking(strategies)` you can:

1. Run `clusterStrategyFamilies(ranked)`.
2. Run `filterByFamily(clustered.strategies, { maxPerFamily: 1, maxStrategies: portfolioMax })`.
3. Call `buildChampionPortfolio(filtered, { maxStrategies: portfolioMax })` and write `strategy_portfolio.json`.

This keeps the pipeline: **batch_results → meta_ranking → clustering → family filter → strategy_portfolio → strategyEvolution**.
