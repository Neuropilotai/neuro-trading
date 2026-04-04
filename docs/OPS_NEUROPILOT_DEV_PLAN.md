# Plan : ops.neuropilot.dev — Dashboard d’exploitation

**Objectif :** Centre de contrôle web branché sur les métriques evolution (latest, trend, alerts, milestones), moteur restant privé (Mac / data root).

---

## 1. Structure DNS recommandée

| Sous-domaine | Rôle | Priorité |
|--------------|------|----------|
| **ops.neuropilot.dev** | Dashboard principal (évolution, trading, audits, santé) | #1 — à mettre en place en premier |
| **monitor.neuropilot.dev** | Vue monitoring pur (optionnel : redirect vers ops ou page dédiée) | #2 |
| **api.neuropilot.dev** | API read-only (si besoin plus tard) | #3 |

**Actions DNS (exemple pour un fournisseur type Cloudflare / Route53 / OVH) :**
- Créer un enregistrement **CNAME** ou **A** pour `ops.neuropilot.dev` vers l’hébergement du front (Vercel / Netlify / serveur dédié).
- Idem pour `monitor.neuropilot.dev` et `api.neuropilot.dev` quand tu les actives.
- Si tu utilises Vercel/Netlify : un seul projet peut servir plusieurs sous-domaines via la config du provider.

---

## 2. Flux de données (Private engine → JSON → ops)

```
[Mac / Data root]
  engine/evolution/strategyEvolution.js
  engine/evolution/scripts/appendEvolutionMetricsLog.js
        ↓
  evolution_metrics.log (NDJSON)
        ↓
  Script d’export (voir §4) → snapshot JSON
        ↓
[Option A] Dépôt / sync vers un repo ou bucket → build + deploy du site qui lit des JSON statiques
[Option B] Petit serveur (Node/Vercel serverless) qui lit le log (ou un JSON pré-généré) et expose des endpoints
```

**Recommandation courte durée :** Option A avec **export JSON statique** après chaque run baseline :
- Un script produit un **snapshot** (latest + trend + alerts + milestones) en un ou plusieurs fichiers JSON.
- Ces fichiers sont déployés avec le front (ou dans un bucket/CDN) et le dashboard les charge en client (fetch).

Pas de secrets sur le serveur, pas d’accès direct au data root depuis l’hébergeur.

---

## 3. Contenu des pages (ce qu’afficher sur ops.neuropilot.dev)

### Page 1 — Overview (état actuel)
- **Latest run** : ts, source
- **Delta** champion vs validated (valeur + indicateur vert/orange/rouge)
- **Wildcard promotions** (ce run)
- **Champions count** / validated count
- **Diversité** : max champions par famille
- **Audit** : status (OK / FAIL) + lien ou détail si besoin

*Source :* payload `latest` (voir §4).

### Page 2 — Trend & alertes
- **Trend** : graph (ou tableau) des 20–100 derniers runs (delta, champions, validated, wildcard)
- **Milestones** : premier wildcard > 0, best/worst delta, max champions, max famille
- **Alertes actives** : delta trop négatif, wildcard inactif sur N runs, diversité, audit KO

*Source :* payloads `trend` et `milestones` et `alerts`.

### Page 3 — Registry & santé (optionnel, phase 2)
- Registry health (résumé)
- Extinction / diversité / promotions (compteurs)
- Top champions (liste ou tableau)

*Source :* extension du snapshot ou lecture de `champion_registry.json` côté export uniquement (jamais exposé brut sur le web si sensible).

---

## 4. Endpoints JSON (format proposé)

Le dashboard consomme du JSON. Deux façons de le fournir :

### Option A — Fichiers statiques (recommandé pour démarrer)

Un script **local** (sur le Mac) tourne après le run baseline et écrit dans un dossier `ops-snapshot/` (ou `dist/ops/`) :

**Fichiers générés :**
- `latest.json` — dernier run (équivalent de `monitor.js latest`).
- `trend.json` — N derniers runs (ex. 50) pour graph/table.
- `alerts.json` — résultat des règles alertes (liste + status).
- `milestones.json` — first wildcard, best/worst delta, max champions, max family.

**Structure proposée :**

```json
// latest.json
{
  "ts": "2026-03-19T10:00:00.000Z",
  "champions": 26,
  "validated": 118,
  "delta": -0.0022,
  "wildcardPromotions": 0,
  "diversityCapped": 10,
  "maxChampionsInOneFamily": 3,
  "consistencyOk": true,
  "generatedAt": "2026-03-19T10:01:00.000Z"
}
```

```json
// trend.json
{
  "points": 50,
  "rows": [
    { "ts": "...", "delta": -0.0022, "champions": 26, "validated": 118, "wildcardPromotions": 0 }
  ],
  "generatedAt": "..."
}
```

```json
// alerts.json
{
  "generatedAt": "...",
  "items": [
    { "type": "delta", "status": "ok", "message": "Delta acceptable" },
    { "type": "wildcard", "status": "alert", "message": "Wildcard inactif sur 10 runs" }
  ]
}
```

```json
// milestones.json
{
  "firstWildcardTs": "2026-03-19T10:05:00Z",
  "bestDelta": 0.0012,
  "worstDelta": -0.0048,
  "maxChampions": 31,
  "maxFamilyConcentration": 5,
  "generatedAt": "..."
}
```

Le **script d’export** :
- Lit `engine/evolution/logs/evolution_metrics.log`.
- Réutilise la même logique que `monitor.js` (ou appelle `monitor.js` en mode “json” / parse la sortie, ou partage un module commun).
- Écrit `latest.json`, `trend.json`, `alerts.json`, `milestones.json` dans le dossier cible.
- Ce dossier est soit commité dans un repo dédié au dashboard, soit uploadé (S3, R2, etc.) pour que le front le charge en statique.

### Option B — API légère (plus tard)

- **api.neuropilot.dev/latest**, `/trend?n=50`, `/alerts`, `/milestones`.
- Serveur (Node/Vercel serverless) qui lit un JSON pré-généré (uploadé par le script) ou lit un fichier log hébergé (attention sécurité et accès).
- Même format JSON que ci-dessus ; le front fait `fetch(api.neuropilot.dev/latest)` etc.

Pour commencer, Option A suffit : le front est un site statique (Vite/Next/HTML+JS) qui charge `latest.json`, `trend.json`, etc. depuis le même origin (ou un chemin type `/data/latest.json`).

---

## 5. Stack technique suggérée (frontend)

- **Hébergement :** Vercel ou Netlify (gratuit, HTTPS, déploiement depuis repo).
- **Front :** React/Vue ou HTML + JS vanilla ; chart lib légère (Chart.js, uPlot, ou SVG maison) pour le trend.
- **Données :** au build ou au déploiement, copier les JSON du snapshot dans `public/` ou équivalent ; le dashboard les charge en `fetch('/data/latest.json')` etc.
- **Rafraîchissement :** re-déploiement après chaque run baseline (webhook ou cron qui rebuild après export), ou refresh manuel côté client (bouton “Rafraîchir” qui refetch).

---

## 6. Ordre d’implémentation

1. **Script d’export JSON** (dans le repo NeuroPilot) : après `appendEvolutionMetricsLog.js`, appeler un script qui lit le log et écrit `latest.json`, `trend.json`, `alerts.json`, `milestones.json` dans un dossier (ex. `ops-snapshot/` ou `frontend-ops/public/data/`).
2. **Repo (ou sous-dossier) frontend** pour ops.neuropilot.dev : page 1 (Overview) qui charge `latest.json` et affiche delta, wildcard, champions, diversité, audit.
3. **DNS** : pointer `ops.neuropilot.dev` vers le déploiement (Vercel/Netlify).
4. **Page 2** : trend (graph) + milestones + alertes à partir de `trend.json`, `milestones.json`, `alerts.json`.
5. **Page 3** (optionnel) : registry health, extinction/diversité, top champions quand tu auras défini le format d’export.
6. **monitor.neuropilot.dev** : soit redirect vers ops, soit une vue “monitoring pur” (même données, layout dédié).
7. **api.neuropilot.dev** : si besoin d’API read-only plus tard, exposer les mêmes JSON via GET.

---

## 7. Résumé

| Élément | Choix recommandé |
|---------|------------------|
| **Nom principal** | ops.neuropilot.dev |
| **Données** | Export JSON statique (latest, trend, alerts, milestones) généré après chaque run. |
| **Front** | Site statique qui charge ces JSON ; hébergement Vercel/Netlify. |
| **DNS** | CNAME/A pour ops.neuropilot.dev vers l’hébergeur. |
| **Sécurité** | Aucun accès au data root depuis le web ; uniquement des JSON déjà agrégés et non sensibles. |

Prochaine étape concrète : ajouter le **script d’export** (lecture du log + écriture des 4 JSON) et, dans un repo ou dossier front, une **première page** qui affiche latest + indicateurs (delta, wildcard, diversité, audit).
