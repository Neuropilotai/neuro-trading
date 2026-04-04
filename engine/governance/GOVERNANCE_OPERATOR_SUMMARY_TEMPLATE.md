# Governance Operator Summary (snapshot reading)

**Rôle** : grille de lecture **qualitative** à réutiliser à chaque revue de snapshot (`governance_dashboard.json`, export ops, ou historique).  
**À ne pas faire** : y coller des métriques figées, des seuils ou de la logique — seulement une **interprétation encadrée** à partir des faits du dashboard.

**Références** : `PAPER_TRADES_METRICS_RUNBOOK.md` (dont §9), `P8_GOVERNANCE_DASHBOARD.md`, `PAPER_LEARNING_INSIGHTS_SCHEMA.md`.

---

## Sain

- Gouvernance / verdict / cycle : …
- Cohérence config ↔ policy (ex. trend memory disabled → suggestive-only) : …
- P5 cycle health : … (okRate, mismatch, etc. — **lire depuis le snapshot**)
- Governor / briques non-policy : …

---

## À surveiller

- `policy:fallback_frequent` (ou équivalent)  
  - Attendu si `trend_memory_apply=false` / interprétation `expected_by_config`.  
  - À **requalifier** seulement si l’apply est activée ou si la policy change.

- P7 / trend memory  
  - Métriques : … (**depuis le snapshot**)  
  - En mode sandbox / non-appliqué : typiquement **aucune action** hors observation.

*(Ajouter d’autres warnings **uniquement** s’ils apparaissent sur le snapshot.)*

---

## Non concluant

- Paper learning / `paperLearningInsights`  
  - N insuffisant (ex. `min_trades` non atteint) : **pas de ranking exploitable**.  
  - `confidence` basse, best/worst absents ou non fiables : **normal si N faible**.  
  - Win rate / PnL sur très petit N : **bruit statistique** — ne pas en tirer de conclusion.

---

## Synthèse

*(Une ou deux phrases : état du cadre vs état du signal paper.)*

> Exemple de formulation type (à adapter) : *Le cadre d’apprentissage et la gouvernance sont cohérents ; le papier n’a pas encore assez d’observations pour un signal défendable.*

---

## Discipline (ne pas diluer)

- Ne pas complexifier ce template (pas de sous-arborescence, pas de scoring).
- Remplir à partir **du snapshot courant** ; ne pas réutiliser une ancienne synthèse comme si c’était du live.
- Aucune **décision** ou mutation de prod dans ce document — lecture et priorisation seulement.

---

## Évolution (plus tard, seulement si besoin)

Quand le volume paper et la `confidence` le permettent, on peut ajouter une section **« Signal potentiel »** — **uniquement** si les garde-fous du dashboard indiquent un N suffisant et un niveau de confiance non trivial. Jusque-là, la section **Non concluant** reste le bon défaut.
