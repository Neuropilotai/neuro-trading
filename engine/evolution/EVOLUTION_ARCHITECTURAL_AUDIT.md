# NeuroPilot Evolution Pipeline — Architectural Audit

**Role:** Principal Evolutionary Systems Architect / Trading Research Auditor  
**Scope:** Canonical evolution flow, group-winner correctness, status machine, pressure quality, meta-learning, production robustness, observability.  
**Style:** Ruthless, precise, technical. No generic advice.

---

## 1. EXECUTIVE VERDICT

**Is the canonical flow fundamentally sound?**  
**Yes, with caveats.** The pipeline order is logically correct: load → build entries (metrics + initial status only) → normalize group winners → stagnation → extinction → diversity cap → validate → metadata → write. Single canonical winner per competition group is enforced before any decay or cap. Determinism is improved by removing mutation score boost and centralizing winner selection in `normalizeChampionPerGroup`.

**Is it production-credible?**  
**Conditionally.** It is credible for continuous looping **if** (a) `EVOLUTION_REGISTRY_STRICT=1` is used in CI or a canary run, (b) metadata and consistency errors are monitored, and (c) killed overlay and next-gen feed are verified to use only active champions. Without strict validation and observability on group/champion metrics, drift is hard to detect.

**What is still fragile?**
- **Validation runs after diversity cap** — so the only champion in a group can be demoted by cap; the group then has zero champions. Invariant “champion = top of group” is not re-checked for those demoted; the design allows this, but there is no explicit metric for “group winner lost to diversity cap.”
- **Stagnation and extinction both target weak setups** with different thresholds and different semantics (structural vs live). Overlap and parameter sensitivity can cause confusion or double-punishment.
- **Meta-learning reads from `registry.setups`** and uses `statusReason` for penalty; it does not distinguish “replaced by mutation” from “replaced by better variant” for weighting, so it cannot directly measure replacement-by-mutation rate in the learning signal.
- **Orphan groups** (parent not in registry, only children share `parentSetupId`) are valid; ranking among siblings is correct, but lineage depth and “family” for diversity use `parentFamilyId`/`familyKey`, which may not align with competition group key, so one family can span many competition groups and vice versa.
- **No atomic write** — registry is one `writeFileSync`; a crash mid-write can corrupt the file. No checksum or write-and-rename pattern.

---

## 2. TOP 10 ARCHITECTURAL RISKS

| # | Title | Severity | Why it matters | Where it lives | Symptom in registry |
|----|--------|----------|----------------|----------------|---------------------|
| 1 | **Diversity cap can remove the only champion in a group** | High | Group’s true winner (by momentum) is demoted to validated; group has 0 champions. Next-gen does not get that setup as champion; exploration from that lineage shrinks. | `capChampionDiversity` after normalize | `groupsWithoutChampion` rises; some groups have strong validated but no champion |
| 2 | **No metric for “champion lost to diversity cap”** | High | Cannot distinguish “no champion because weak” from “no champion because capped.” Operators cannot tune diversity vs representation. | `buildEvolutionMetadata` | No `championsDemotedByDiversity` or `groupWinnersCapped` |
| 3 | **Stagnation and extinction both punish weak setups** | Medium | Stagnation: 4+ nights and momentum < 0.48 → candidate. Extinction: candidate 4+ nights momentum < 0.47 → extinct. Validated 6+ nights < 0.475 → candidate. Overlap and ordering can double-punish or create unclear semantics. | `applyPostNormalizeStagnation`, `applyExtinctionStructural` | Same setup can get stagnation_drop then extinction_low_momentum; or validated_decay then extinction; hard to attribute cause |
| 4 | **Validation uses same compare as normalize but runs after cap** | Medium | If cap demotes champion A, group has 0 champions; validation does not flag. If due to a bug two champions existed in one group, validation would catch it. So validation is correct for “at most one champion” and “champion is top when present,” but it does not assert “every group with a strong winner has a champion.” | `validateRegistryConsistency` | `groupsWhereChampionIsNotTop` can stay 0 even when many groups lost champion to cap |
| 5 | **Meta-learning penalty uses statusReason string** | Medium | Relies on `statusReason === 'stagnation_drop' \|\| 'extinction_low_momentum'` for candidate penalty. If new reasons are added or naming changes, meta-learning can under-penalize or over-penalize. | `buildPatternMetaLearning.js` | Weights drift; certain buckets get under-weighted or over-weighted |
| 6 | **Registry write is not atomic** | Medium | Single `writeFileSync`; crash or OOM during write can leave truncated JSON. No write-to-temp-then-rename. | `writeChampionRegistry` | Corrupt `champion_registry.json`; next load fails or partial data |
| 7 | **Initial status from scoreSetupSurvival can crown champions in many groups** | Medium | Survival uses mutation override (nights ≥ 4, survival ≥ 0.95, avgMeta ≥ 0.48, validation ≥ 0.6). So many mutations get champion before normalize. Normalize then enforces one per group and may demote some. Order is correct, but initial “many champions” can make `hadChampion` true in many groups and lower the bar for assignChampion (0.47 line). | `scoreSetupSurvival.js` → `buildRegistryEntries` | High initial champion count; normalize and cap reduce it; variance across runs if input history order or merge order changes |
| 8 | **familyKey vs competitionGroupKey mismatch** | Medium | Diversity cap uses `familyKey` and `parentFamilyId`; group winner uses `competitionGroupKey` (parentSetupId or setupId). A family can have many competition groups (e.g. many parents); a competition group is one parent + its children. So cap limits “champions per family” across groups; it does not limit “champions per competition group” (normalize already does that). Risk: one large family can still dominate champion count up to maxPerFamilyKey. | `capChampionDiversity` | One familyKey has many champions (up to cap); many competition groups under that family |
| 9 | **No explicit “champion turnover” or “time in champion”** | Low | Cannot see if the same setups stay champion forever or if there is healthy replacement. | Metadata / history | Cannot answer “how often does a new setup become champion?” |
| 10 | **MUTATION_STATUS_DEBUG console.log in production path** | Low | `scoreSetupSurvival.js` logs every mutation setup in computeStatus. In a long loop this is noisy and can slow or fill logs. | `scoreSetupSurvival.js` | Log volume; harder to spot real errors |

---

## 3. INVARIANT CHECKLIST

### Lineage invariants

| Invariant | Plain English | How to detect violation | Likely cause |
|-----------|----------------|--------------------------|--------------|
| No self-parent | No entry has `parentSetupId === setupId` | `e.parentSetupId && e.parentSetupId === e.setupId` | Raw data or bug before cleanLineageEntry; cleanLineageEntry not applied |
| Base has no mutationType | If `!parentSetupId \|\| parentSetupId === setupId` then `mutationType` must be null | Base entry (no valid parentSetupId) with truthy mutationType | Last row carry in buildRegistryEntries; cleanLineageEntry not applied or applied before normalize |
| Parent in group key | competitionGroupKey is either parent’s setupId (for children) or own setupId (for roots) | N/A (definitional) | Wrong key function |

### Group ranking invariants

| Invariant | Plain English | How to detect violation | Likely cause |
|-----------|----------------|--------------------------|--------------|
| At most one champion per group | For competitionGroupKey k, at most one entry with status champion | Count champions per competitionGroupKey > 1 | Bug in normalize or cap (cap demotes, does not add) |
| Champion is group top | If group has exactly one champion, that entry is the top by compareGroupMembers | sort group by compareGroupMembers; top.setupId !== champion.setupId | Diversity cap demoted the true top; or compareGroupMembers changed; or metrics changed after normalize |
| Tie-break deterministic | Same inputs → same winner | Different winner same group across runs with same data | Non-deterministic sort or floating point |

### Structural status invariants

| Invariant | Plain English | How to detect violation | Likely cause |
|-----------|----------------|--------------------------|--------------|
| Status in {candidate, validated, champion} | No other value | status not in Set | Bug in any stage or corrupted read |
| statusReason consistent with status | e.g. promoted_over_parent only when champion; replaced_* only when validated | statusReason vs status mismatch | Partial update or wrong stage |
| Champion never has statusReason extinction_* | Extinction sets status or liveStatus, not champion+extinct | champion and (extinction_low_momentum or extinction_validated_decay or champion_decay_extinction) | Logic error: champion decay should set status to validated first |

### Live status invariants

| Invariant | Plain English | How to detect violation | Likely cause |
|-----------|----------------|--------------------------|--------------|
| liveStatus in {active, extinct, killed} | Only these three | liveStatus outside set | Overlay or new code |
| Killed only at write | No entry gets liveStatus killed before merge with champion_performance | liveStatus killed before write step | killed applied in wrong stage |
| Champion not extinct | Champion decay demotes to validated; only candidate can get extinct | status === champion && liveStatus === extinct | Bug in extinction (champion should be demoted before marking extinct for that lineage) |

### Diversity invariants

| Invariant | Plain English | How to detect violation | Likely cause |
|-----------|----------------|--------------------------|--------------|
| Champions per familyKey ≤ maxPerFamilyKey | After cap, count of champion per familyKey ≤ opts | Count by familyKey > max | Bug in cap or wrong opts |
| Champions per parentFamilyId ≤ maxPerParentFamily | Same for parent | Count by parentFamilyId > max | Bug in cap |

### Metadata invariants

| Invariant | Plain English | How to detect violation | Likely cause |
|-----------|----------------|--------------------------|--------------|
| consistencyOk reflects validation | metadata.consistencyOk === (errors.length === 0) | Mismatch | buildEvolutionMetadata or validateRegistryConsistency out of sync |
| Counts match arrays | setupsCount === setups.length etc. | Mismatch | Filtering after metadata build or wrong source |

---

## 4. FAILURE MODE TABLE

| Failure mode | Probable root cause | Observable symptoms | Damage level | Recommended fix |
|--------------|---------------------|---------------------|--------------|------------------|
| Champion is not true top of group | Bug or compare change; or validation runs on wrong snapshot | consistencyErrorCount > 0; champion_not_group_top_momentum | High | Run EVOLUTION_REGISTRY_STRICT=1; fix compare or order |
| No champion in too many groups | Diversity cap too tight; or assignChampion bar too high (0.47/0.48); or all weak | groupsWithoutChampion high; championsCount low | High | Raise cap or lower GROUP_CHAMPION_MIN_MOMENTUM; add metric groupWinnersLostToCap |
| Mutations stuck as validated forever | Cap limits mutation champions (maxMutationPerFamilyKey=1); or normalize always picks parent | mutChampion low; mutationChampionRatio low | High | Review cap mutation quotas; ensure normalize ranks mutations above parent when momentum ties |
| Stale families never die | Extinction too weak (high MIN_STABILITY, high momentum thresholds); or no removal of extinct from lineage inputs | extinctionCount 0 or very low; setupsCount growing | Medium | Lower extinction thresholds or add periodic prune of extinct from bySetupId |
| Champion count collapses too low | Extinction + stagnation + cap too aggressive | championsCount < 10; groupsWithoutChampion very high | High | Relax thresholds; add floor or alert when championsCount < N |
| One family dominates | maxPerFamilyKey large (3); one family has many strong groups | One familyKey has 3 champions; others 0 | Medium | Lower maxPerFamilyKey or add “max champions per lineage root” |
| Meta-learning runaway bias | Weights not clamped; or penalty too strong; or champions all from one bucket | pattern_meta_learning weights extreme; next-gen all same phase/regime | High | Clamp already present (0.85–1.25); add max weight spread or decay toward 1.0 |
| Oscillation between sibling setups | Tie-break or floating point; or history merge order changes which setup has slightly higher momentum | Same group, different champion across runs with same data | Medium | Ensure deterministic sort (localeCompare); same merge order |
| Extinction never fires | MIN_STABILITY_NIGHTS=5 and all setups have &lt;5 nights; or momentum always above threshold | extinctionCount 0; liveStatus always active for candidates | Medium | Lower MIN_STABILITY or ensure enough history length in input |
| Extinction fires too early | Low EC_MOM/EV_MOM/ECH_MOM or low MIN_STABILITY | Many extinct; championsCount drops fast | High | Raise thresholds or MIN_STABILITY |
| Lineage corruption | parentSetupId === setupId or base with mutationType | self_parent or base_has_mutationType errors | High | cleanLineageEntry applied; fix upstream data |
| Duplicate effective setups under different ids | Same rules, different setupId (e.g. mut_* vs familyexp_*) | Duplicate rules in registry; duplicateSignature in next-gen | Medium | Dedupe by rules fingerprint or canonical id in next-gen |

---

## 5. PRESSURE BALANCE ASSESSMENT

- **Exploration:** Next-gen generates children from active champions only; diversity cap limits champions per family. Orphan groups (only children) can still have one champion. **Verdict:** Moderate. Exploration is limited by (1) cap per family, (2) extinction removing weak candidates, (3) meta-learning biasing toward current winners.
- **Exploitation:** Normalize picks best per group; survival and mutation override crown strong mutations. **Verdict:** Strong. Best momentum wins within group; mutations can replace parents.
- **Extinction:** Candidate &lt; 0.47 after 4+ nights → extinct; validated &lt; 0.475 after 6+ → candidate; champion &lt; 0.478 and ≤ half positive nights → validated. Grace 5 nights. **Verdict:** Moderate. Thresholds in high 0.47x are strict enough to avoid killing everything; 5-night grace avoids early false extinction.
- **Promotion:** Validated can become champion in normalize if wMom ≥ 0.48 and no champion in group. **Verdict:** Slightly conservative (0.48 bar).
- **Diversity:** maxPerFamilyKey=3, maxMutationPerFamilyKey=1. **Verdict:** Family diversity is enforced; mutation diversity is tight (1 per family key), which can limit mutation champions.
- **Mutation pressure:** No mutation score boost; mutation wins only on strict tie in compareGroupMembers. **Verdict:** Conservative; no extra push for mutations.

**Overall:** The system is **slightly conservative** with a clear bias toward “best momentum wins” and “one champion per group.” Exploration is capped by diversity and by mutation cap; extinction and stagnation add pressure but within bounds. For continuous autonomous looping, the main risk is **slow collapse of champion count** if extinction + cap remove more champions than new promotions add, and **under-representation of mutations** if maxMutationPerFamilyKey stays 1.

---

## 6. METRIC GAP ANALYSIS (prioritized by leverage)

| Priority | Missing metric | Why high leverage |
|----------|----------------|-------------------|
| 1 | **groupWinnersLostToCap** | Count of groups that had exactly one champion after normalize but zero after cap. Directly explains “no champion” and tunes diversity vs representation. |
| 2 | **championsDemotedByDiversity** | Count of entries that were champion after extinction and became validated in cap (statusReason champion_diversity_capped). Complements groupWinnersLostToCap. |
| 3 | **championTurnoverRate** | Fraction of champions that were not champion in previous run (requires previous registry or snapshot). Measures replacement rate. |
| 4 | **validatedStagnationCount** | Validated with momentum &lt; 0.48 and nightsInHistory ≥ 6 (or threshold). Shows pipeline of “almost champion” stuck. |
| 5 | **extinctPerCycleRate** | Count of setups that became extinct this run (or delta of extinctionCount). Tracks extinction pressure. |
| 6 | **mutationPromotionLatency** | For setups with statusReason promoted_over_parent, nightsInHistory or nights since first seen. Not trivial without history of first-seen. |
| 7 | **registryGrowthRate** | setupsCount delta per run. Prevents unbounded growth. |
| 8 | **uniqueCompetitionGroupsTrend** | groupsTotal over time. Ensures we are not collapsing to few groups. |
| 9 | **statusReasonHistogram** | Counts per statusReason. Explains why setups moved (replaced_by_mutation vs replaced_by_better_variant vs stagnation_drop etc.). |
| 10 | **avgChampionNightsInHistory** | How long champions have been in history. Long-lived champions vs quick replacements. |

---

## 7. PROPOSED AUTOMATED AUDITS

### Per-run checks

| Check name | Exact condition | Failure means | Alert threshold |
|------------|-----------------|---------------|-----------------|
| consistency_ok | `metadata.consistencyOk === true` | Invariant violation | consistencyOk false |
| no_self_parent | No entry with parentSetupId === setupId | Lineage corruption | any |
| no_base_mutation_type | No base entry with mutationType | Lineage cleanup failed | any |
| at_most_one_champion_per_group | For each competitionGroupKey, ≤1 champion | Normalize or cap bug | any group with >1 |
| champion_is_group_top | For each group with 1 champion, champion === sort(grp)[0] | Ranking or cap bug | any |

### Nightly checks

| Check name | Exact condition | Failure means | Alert threshold |
|------------|-----------------|---------------|-----------------|
| champion_count_bounds | championsCount >= 10 && championsCount <= 200 | Collapse or explosion | outside [10, 200] |
| extinction_count_bounded | extinctionCount <= 0.5 * setupsCount | Too aggressive extinction | above |
| mutation_champion_ratio_min | mutationChampionRatio >= 0.1 (if championsCount >= 10) | Mutations never promote | &lt; 0.1 |
| groups_without_champion_ratio | groupsWithoutChampion / groupsTotal <= 0.7 | Too many groups with no champion | &gt; 0.7 |

### Weekly structural checks

| Check name | Exact condition | Failure means | Alert threshold |
|------------|-----------------|---------------|-----------------|
| registry_size_growth | setupsCount vs previous week &lt; 2x | Runaway growth | growth &gt; 2x |
| metadata_present | registry.metadata exists and has groupsTotal | Metadata not written | missing |
| status_reason_coverage | Every champion has statusReason in {group_winner_normalized, promoted_over_parent} | Unknown promotion path | any champion without |

### Long-run drift checks

| Check name | Exact condition | Failure means | Alert threshold |
|------------|-----------------|---------------|-----------------|
| champion_stability | Fraction of champions that were champion in previous run &lt; 1.0 for many runs | No turnover or total churn | tune to target |
| family_concentration | max(champions per familyKey) / championsCount | One family dominates | &gt; 0.5 |
| avg_champion_momentum_trend | avgChampionMomentum over runs | Quality drift | sustained drop &gt; 0.02 |

---

## 8. CONCRETE PATCH RECOMMENDATIONS

| Patch title | Exact intent | Why it matters | Expected effect | Risk/tradeoff |
|-------------|--------------|----------------|-----------------|---------------|
| Add groupWinnersLostToCap to metadata | In buildEvolutionMetadata, before cap we do not have “post-normalize” state. So: either (1) run normalize in a side copy and count groups that have 1 champion there but 0 in final entries, or (2) count entries with statusReason === 'champion_diversity_capped'. (2) is easier: count demoted-by-cap. | Explains why groups have no champion; tunes diversity. | metadata.championsDemotedByDiversity or groupWinnersLostToCap (derived) | None. |
| Atomic registry write | Write to `champion_registry.json.tmp` then `fs.renameSync` to `champion_registry.json`. | Prevents corrupt file on crash. | No partial JSON on disk | Need to handle read during rename (reader may see old file until rename completes). |
| Remove or gate MUTATION_STATUS_DEBUG | Remove console.log in scoreSetupSurvival computeStatus, or wrap in `if (process.env.EVOLUTION_DEBUG_MUTATION)`. | Reduces log volume in production. | Cleaner logs | Lose visibility for mutation debugging unless env set. |
| Add statusReason to diversity demotion | Already set: statusReason = 'champion_diversity_capped'. Ensure metadata counts this. | Already present; ensure metadata uses it. | championsDemoted includes cap demotions | None. |
| Stagnation vs extinction doc | Document in EVOLUTION_CANONICAL_FLOW.md: stagnation = structural demotion (candidate) for weak; extinction = structural + live (validated→candidate, champion→validated, candidate→extinct). | Clear semantics for operators. | Fewer misinterpretations | None. |
| Optional: champion floor | If championsCount &lt; N (e.g. 15) after cap, log warning or soft-fail. | Prevents accidental collapse. | Alerts before full collapse | N is arbitrary; may need tuning. |

---

## 9. PRIORITIZED NEXT ACTIONS

1. **Add `championsDemotedByDiversity` (or equivalent) to metadata** — Count entries with statusReason === 'champion_diversity_capped'. Measure: after deploy, inspect metadata and confirm it increments when cap is active.
2. **Enable EVOLUTION_REGISTRY_STRICT=1 in CI or nightly canary** — Run evolution once with strict; fix any invariant failure. Measure: zero consistency errors in that run.
3. **Implement atomic registry write** — Write to .tmp then rename. Measure: kill process during write and confirm registry is either old or new, never truncated.
4. **Remove or gate MUTATION_STATUS_DEBUG** — Set env or remove. Measure: log size per run drops for production.
5. **Add per-run audit script** — Script that loads registry and checks consistency_ok, no_self_parent, no_base_mutation_type, at_most_one_champion_per_group, champion_is_group_top. Measure: script exit 0 for last run.
6. **Document stagnation vs extinction and thresholds** — In EVOLUTION_CANONICAL_FLOW or README. Measure: operators can explain why a setup is candidate vs extinct.
7. **Add nightly alert on champion_count_bounds and mutation_champion_ratio_min** — E.g. championsCount in [10, 200], mutationChampionRatio >= 0.1. Measure: one week without false positives; catch real collapse once.

**Success criteria:** (1) Metadata explains “no champion” via cap count. (2) No invariant violations in strict run. (3) Registry never corrupted by partial write. (4) One automated audit run in CI or cron.

---

## 10. FINAL JUDGMENT

- **Single biggest remaining weakness:** **Diversity cap can remove the only champion in a competition group with no explicit metric.** So “best momentum in group” is correctly chosen in normalize, but cap can demote that winner to validated; the group then has zero champions and that lineage is under-represented in next-gen. The logic is intentional for exploration, but without “groupWinnersLostToCap” or “championsDemotedByDiversity” you cannot tell if the system is balanced or over-capping.

- **Single most important missing metric:** **groupWinnersLostToCap** (or count of champions demoted by diversity cap). It directly ties registry shape to diversity policy.

- **Single most valuable next patch:** **Add to metadata:** `championsDemotedByDiversity: entries.filter(e => e.statusReason === 'champion_diversity_capped').length`. Then optionally `groupWinnersLostToCap` derived (e.g. same count, or count of groups that had 1 champion after normalize and 0 after cap if we snapshot).

- **Is this flow ready for continuous autonomous looping?** **Yes, with conditions.** Conditions: (1) Atomic registry write to avoid corruption. (2) EVOLUTION_REGISTRY_STRICT=1 in at least one canary or CI run to catch invariant drift. (3) Monitoring on championsCount, extinctionCount, consistencyOk, and (after patch) championsDemotedByDiversity. (4) Optional: champion floor alert when championsCount &lt; N.

- **If not fully, what exact condition must be satisfied first?** Atomic write + one of: strict validation in CI, or automated per-run audit that fails the run if consistencyOk is false.

---

## Architect’s Red Team Scenario (30-day continuous run)

**Scenario 1: Champion count collapse**  
- **What slowly goes wrong:** Extinction + stagnation + diversity cap remove more champions per cycle than new promotions add. ChampionsCount drifts down from ~25 to 8.  
- **Early warning:** championsCount &lt; 15; avgChampionMomentum stable or rising (survivors are strong).  
- **How to stop:** Relax extinction (raise ECH_MOM, EV_MOM, EC_MOM) or lower MIN_STABILITY; or raise diversity caps; or add champion floor and alert.

**Scenario 2: One family dominates**  
- **What slowly goes wrong:** One familyKey has 3 champions (at cap); others have 0 or 1. Next-gen generates many children from those 3; meta-learning reinforces that family; other families get fewer chances.  
- **Early warning:** max(champions per familyKey) / championsCount &gt; 0.5; mutationChampionRatio drops.  
- **How to stop:** Lower maxPerFamilyKey to 2; or add “diversity bonus” in next-gen to favor underrepresented families; or periodic reset of meta-learning weights toward 1.0.

**Scenario 3: Mutations never reach champion**  
- **What slowly goes wrong:** maxMutationPerFamilyKey=1 and many families have one strong parent and several strong mutations. Only one mutation champion per family; parents keep winning in other groups. mutChampion stays low.  
- **Early warning:** mutationChampionRatio &lt; 0.15 for several runs; mutationsPromoted stable and low.  
- **How to stop:** Raise maxMutationPerFamilyKey to 2; or ensure normalize tie-break favors mutation when momentum is equal (already does); or add “mutation bonus” in next-gen scoring.

**Scenario 4: Registry bloat**  
- **What slowly goes wrong:** New setups added every run (discovery + next-gen); extinction and stagnation remove some but not enough. setupsCount grows from 3k to 15k; run time and memory grow.  
- **Early warning:** setupsCount growth rate &gt; 5% per run; disk usage of registry file.  
- **How to stop:** Stricter extinction (lower EC_MOM or lower MIN_STABILITY for candidates); or periodic prune of extinct setups from bySetupId before evolution; or cap total setups per run.

**Scenario 5: Meta-learning lock-in**  
- **What slowly goes wrong:** pattern_meta_learning weights drift toward one session_phase and one regime; next-gen generates mostly those; new strategies in other buckets never get enough trials to become champion; weights reinforce further.  
- **Early warning:** pattern_meta_learning weights for one bucket &gt; 1.2 and others &lt; 0.9; topMetaIds or topChampionIds all same phase/regime.  
- **How to stop:** Stronger clamp (e.g. [0.9, 1.1]); or decay weights toward 1.0 each run; or add “exploration bonus” in next-gen for underrepresented buckets; or periodically reset meta-learning from scratch.

---

*End of audit.*
