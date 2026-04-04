# Champion snapshot — legend

**Purpose**  
Human-readable interpretation of evolution / champion metrics from logs or snapshots.  
This is an **operator reading guide**, not a performance claim or technical spec.

**Dashboard** — the governance dashboard embeds a compact **`evolutionSummary`** (labels + `evolutionSummaryLine`) built from `champion_registry.json` and optional `next_generation_report.json`. Contract + **30-second operator read order**: `engine/governance/EVOLUTION_SUMMARY_SCHEMA.md` (section *Lecture en 30 secondes*).

---

## Important

**Lab only — does not imply market profitability, edge, or PnL.**  
These metrics describe **internal selection and evolution mechanics** only.

**Δ (`metadata.delta`)** — strict definition (champion vs validated momentum), what it measures / does not measure: **`EVOLUTION_DELTA_OPERATOR.md`**.

---

## Six reading axes

### 1. Elite (selection pressure)

- **`championsCount`** — size of the elite layer vs total population.

**Interpretation**

- Low relative to total → strong selection.
- High relative to total → weaker filtering / possible dilution (context-dependent).

---

### 2. Mutation (evolution activity)

- **`mutChampion`** — champions that are mutations (vs seed / base patterns).

**Interpretation**

- High share → elite layer is mutation-driven.
- Low share → system still leaning on original templates.

---

### 3. Promotion (progress signal)

- **`promotedOverParent`** — mutations that outrank or replace their parent lineage.

**Interpretation**

- Primary “evolution is doing something” signal in many setups.
- Sustained zero → little effective improvement vs parents (still context-dependent).

---

### 4. Diversity (anti-collapse)

- **`champion_diversity_protected`** (or equivalent status / reason in logs) — elites kept **on purpose** for diversity.

**Interpretation**

- Present → explicit guard against single-family convergence.
- Absent → watch for collapse onto one pattern family.

---

### 5. Pruning (population control)

- **`extinctionCount`** — setups removed / culled.

**Interpretation**

- Non-trivial pruning → cleanup of weak or redundant candidates.
- Near-zero over long runs → risk of noise / bloat (context-dependent).

---

### 6. Exploration (future supply)

- **`childrenGenerated`** — new children produced for the next evaluation wave.

**Interpretation**

- `> 0` → exploration continues.
- `0` over sustained windows → stagnation risk.

---

## Quick cheat sheet

| Metric | Meaning | What to watch |
|--------|---------|----------------|
| `championsCount` | Elite size | Very high vs policy → weak filter |
| `mutChampion` | Mutations in elite | Should often be a large fraction |
| `promotedOverParent` | Improvement vs parent | Most important progress signal |
| `extinctionCount` | Pruning strength | Chronic zero → possible bloat |
| `childrenGenerated` | Exploration | Should stay `> 0` in active runs |
| Diversity-protected champions | Diversity safeguard | Helps avoid early collapse |

---

## Operator summary — “healthy-looking” snapshot

Typical pattern when the loop is alive (not a guarantee of edge):

- Small elite vs total population.
- Champion set largely mutation-driven.
- Non-zero `promotedOverParent`.
- Meaningful `extinctionCount` over time.
- Ongoing `childrenGenerated`.
- Some diversity protection visible in champion reasons.

---

## What this does **not** mean

- No guarantee of profitability.
- No substitute for paper/live execution outcomes.
- No proof of statistical edge without proper evaluation.

---

## What this **does** mean

- Selection and culling mechanics are observable.
- The evolution loop is producing and filtering variants.
- Internal competition (champion vs non-champion) is operating.

---

## Related metrics (optional context)

- **`setupsCount` / population size** — total candidates in scope for that snapshot.
- **`validatedCount`** — credible but not necessarily elite; funnel: total → validated → champions.
- **`mutValidated`** — mutation share below champion tier (exploration breadth).
- **`avgChampionMomentum`** (or similar) — aggregate quality signal; interpret only against **your** scoring definition and history.

---

## Champion status reasons (examples)

Names vary by build; typical semantics:

| Reason (example) | Plain English |
|------------------|----------------|
| `promoted_over_parent` | Child outperformed parent; strong evolution signal. |
| `champion_diversity_protected` | Kept for diversity, not only raw score. |
| `group_winner_normalized` | Best representative within a family / group after normalization. |

---

*Stable operator doc — bump version only if metric names or semantics change in code.*
