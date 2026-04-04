#!/usr/bin/env node
'use strict';

/**
 * Over-promotion bias audit on discovery/meta_ranking.json (exported topN slice only).
 *
 * Usage:
 *   node engine/meta/scripts/analyzePromotionBias.js [path/to/meta_ranking.json]
 *
 * Does not log secrets. Read-only.
 */

const fs = require('fs');
const path = require('path');

function avg(arr) {
  const f = arr.filter((x) => Number.isFinite(x));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

function pearson(xs, ys) {
  const nx = xs.length;
  if (nx !== ys.length || nx < 2) return null;
  const mx = avg(xs);
  const my = avg(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < nx; i++) {
    const vx = xs[i] - mx;
    const vy = ys[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function main() {
  const inPath =
    process.argv[2] ||
    process.env.RANKING_FILE ||
    path.join(process.cwd(), 'discovery', 'meta_ranking.json');

  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const s = data.strategies || [];
  const n = s.length;

  const rows = s.map((v, i) => ({
    export_slot: i + 1,
    rank: v.rank,
    meta_score: v.meta_score,
    decayed_promotion_bonus: v.decayed_promotion_bonus ?? 0,
    parent_vs_child_score: v.parent_vs_child_score,
    validation_gate_factor: v.validation_gate_factor,
    stability: v.stability,
    cross_asset_score: v.cross_asset_score,
    timeframe_stability_score: v.timeframe_stability_score,
    source: v.source,
    setupId: v.setupId,
  }));

  const slots = rows.map((r) => r.export_slot);
  const bonuses = rows.map((r) => r.decayed_promotion_bonus);
  const metas = rows.map((r) => r.meta_score);

  let invCount = 0;
  const invExamples = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rows[i].rank > rows[j].rank) {
        invCount++;
        const gap = rows[i].rank - rows[j].rank;
        invExamples.push({
          earlier_slot: rows[i].export_slot,
          later_slot: rows[j].export_slot,
          earlier_id: rows[i].setupId,
          later_id: rows[j].setupId,
          earlier_rank: rows[i].rank,
          later_rank: rows[j].rank,
          rank_gap: gap,
          earlier_bonus: rows[i].decayed_promotion_bonus,
          later_bonus: rows[j].decayed_promotion_bonus,
          earlier_meta: rows[i].meta_score,
          later_meta: rows[j].meta_score,
        });
      }
    }
  }
  invExamples.sort((a, b) => b.rank_gap - a.rank_gap);

  function bucket(pred) {
    const sub = rows.filter(pred);
    return {
      n: sub.length,
      avg_meta_score: avg(sub.map((r) => r.meta_score)),
      avg_export_slot: avg(sub.map((r) => r.export_slot)),
      avg_parent_vs_child: avg(sub.map((r) => r.parent_vs_child_score).filter((x) => Number.isFinite(x))),
      avg_gate: avg(sub.map((r) => r.validation_gate_factor)),
      avg_stability: avg(sub.map((r) => r.stability)),
    };
  }

  const highPromo = bucket((r) => r.decayed_promotion_bonus > 0.15);
  const midPromo = bucket((r) => r.decayed_promotion_bonus > 0 && r.decayed_promotion_bonus <= 0.15);
  const noPromo = bucket((r) => r.decayed_promotion_bonus === 0);

  const bySource = {};
  for (const r of rows) {
    bySource[r.source] = bySource[r.source] || [];
    bySource[r.source].push(r);
  }
  const sourceStats = Object.entries(bySource).map(([src, arr]) => ({
    source: src,
    count: arr.length,
    pct: (100 * arr.length) / n,
    avg_meta: avg(arr.map((x) => x.meta_score)),
  }));

  const highPromoLowPvC = rows.filter(
    (r) => r.decayed_promotion_bonus > 0.15 && Number(r.parent_vs_child_score) < 0.01
  );
  const noPromoHighPvC = rows.filter(
    (r) => r.decayed_promotion_bonus === 0 && Number(r.parent_vs_child_score) > 4
  );

  const topSlots = rows.filter((r) => r.export_slot <= 4);
  const noPromoMid = rows.filter(
    (r) => r.decayed_promotion_bonus === 0 && r.export_slot >= 9 && r.export_slot <= 14
  );

  const out = {
    meta: {
      path: inPath,
      count: n,
      topN: data.topN,
      totalStrategiesRanked: data.totalStrategiesRanked,
    },
    correlations: {
      decayed_promotion_bonus_vs_export_slot: pearson(bonuses, slots),
      meta_score_vs_export_slot: pearson(metas, slots),
    },
    rank_inversions_vs_pre_greedy: {
      pair_count_disagreeing: invCount,
      total_pairs: (n * (n - 1)) / 2,
      inversion_rate: invCount / ((n * (n - 1)) / 2),
      top5_worst_by_rank_gap: invExamples.slice(0, 5),
    },
    buckets: { HIGH_PROMO_gt_0_15: highPromo, MID_PROMO: midPromo, NO_PROMO: noPromo },
    source_distribution: sourceStats,
    high_promo_and_parent_vs_child_lt_0_01: highPromoLowPvC.map((r) => ({
      export_slot: r.export_slot,
      rank: r.rank,
      meta_score: r.meta_score,
      decayed_promotion_bonus: r.decayed_promotion_bonus,
      parent_vs_child_score: r.parent_vs_child_score,
    })),
    no_promo_and_parent_vs_child_gt_4: noPromoHighPvC.map((r) => ({
      export_slot: r.export_slot,
      rank: r.rank,
      meta_score: r.meta_score,
      parent_vs_child_score: r.parent_vs_child_score,
    })),
    stability_compare: {
      export_slots_1_4_avg_stability: avg(topSlots.map((r) => r.stability)),
      no_promo_slots_9_14_avg_stability: avg(noPromoMid.map((r) => r.stability)),
    },
  };

  // eslint-disable-next-line no-console -- CLI audit output (counts/metrics only)
  console.log(JSON.stringify(out, null, 2));
}

main();
