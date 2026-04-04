# Edge validation: "Does my edge survive when I change dataset?"

Reference setup (premium benchmark): **trend_breakout + confirmed + strength + BREAKOUT + noopen**

---

## État des lieux — le moteur est prêt

**Tu as :**
- Setup premium **figé** (ne pas toucher)
- Groupes étendus prêts en config (`spy_5m_2019_2025`, `qqq_5m_2019_2025`)
- Pipeline complet : research → trade simulation → audit export → bootstrap
- Roadmap écrite (plus d’années, plus d’actifs, Monte Carlo equity, walk-forward)

**La prochaine bataille : augmenter l’échantillon sans toucher au setup.** Techniquement, la prochaine étape n’est plus du code, c’est des données.

---

## Statut actuel (mars 2026)

**Setup premium testé :**  
trend_breakout + confirmed + strength + BREAKOUT + noopen

**Meilleur R multiple observé :**  
SPY → 1.5R | QQQ → 2R

**Résultats bootstrap actuels :**

| | SPY (1.5R) | QQQ (2R) |
|---|------------|----------|
| Trades | 19 | 9 |
| Expectancy | 0.18R | 0.33R |
| Bootstrap % expectancy &lt; 0 | 24.9% | 16.7% |
| **Verdict** | **fragile** | **intéressant mais pas validé** |

**Conclusion actuelle :**  
Edge plausible mais échantillon insuffisant. **Priorité absolue : augmenter les données.**

---

## Commandes de référence

### SPY premium (1.5R)

```bash
node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js SPY 5m audit 1.5
node engine/exampleBootstrapTrades.js research/trade_audit_SPY_5m_R1.5.json 10000 42
```

### QQQ premium (2R)

```bash
node engine/exampleRunResearchFromConfig.js qqq_5m_single trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js QQQ 5m audit
node engine/exampleBootstrapTrades.js research/trade_audit_QQQ_5m.json 10000 42
```

### SPY étendu (dès que CSV 2019–2021 dans `data/`)

Fichiers : `spy_5m_2019.csv`, `spy_5m_2020.csv`, `spy_5m_2021.csv`.

```bash
node engine/exampleRunResearchFromConfig.js spy_5m_2019_2025 trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js SPY 5m audit 1.5
node engine/exampleBootstrapTrades.js research/trade_audit_SPY_5m_R1.5.json 10000 42
```

### QQQ étendu (dès que CSV 2019–2021 dans `data/`)

Fichiers : `qqq_5m_2019.csv`, `qqq_5m_2020.csv`, `qqq_5m_2021.csv`.

```bash
node engine/exampleRunResearchFromConfig.js qqq_5m_2019_2025 trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js QQQ 5m audit
node engine/exampleBootstrapTrades.js research/trade_audit_QQQ_5m.json 10000 42
```

---

## Cible & lecture du bootstrap

**Cible en nombre de trades :**
- 30 trades min par actif = commence à devenir lisible
- 50+ = beaucoup mieux
- 60–100 = tu peux commencer à parler d’un edge plus sérieux

**Règle pour « % of bootstrap samples with expectancy < 0 » :**
- **< 5%** → très bon
- **5% à 20%** → intéressant mais pas validé
- **> 20%** → fragile

**En ce moment :** SPY 1.5R = 24.9% (fragile), QQQ 2R = 16.7% (intéressant mais pas validé). L’idée n’est pas morte, mais pas encore prouvée.

**À ne pas faire :** ne pas changer le setup, ne pas rajouter une flopée de filtres (VWAP, ATR, compression, RSI…), sinon tu fits le bruit.

**Suite dans l’ordre :** (1) Plus de données SPY 5m 2019–2021, (2) Pareil pour QQQ, (3) Refaire les mêmes tests, (4) Ensuite seulement IWM, DIA, futures NQ/ES.

---

## Results table

| Dataset | Setup | Trades | Win rate | Expectancy | Best R | Bootstrap risk | Notes |
|---------|--------|--------|----------|------------|--------|-----------------|-------|
| SPY 5m 2022-2025 | BREAKOUT+noopen | 101 | 28.71% | -0.14 (2R) | 1R → 0.09 | — | baseline, négatif à 2R |
| SPY 5m 2022-2025 | +strength | 39 | 30.77% | -0.08 (2R) | 1R → 0.08 | — | améliore vs A, encore négatif à 2R |
| SPY 5m 2022-2025 | +confirmed+strength | 19 | 36.84% | 0.18 (1.5R) | 1.5R | 24.9% | **premium**, fragile |
| SPY 5m 2022-2025 | +confirmed+strength+late | 8 | 50% | 0.5 (2R) | 2R | — | joli, sample trop petit |
| QQQ 5m | confirmed+strength+BREAKOUT+noopen | 9 | 44.44% | 0.33 (2R) | 2R | 16.7% | **premium**, promising |
| IWM 5m | (when data added) | | | | | | add iwm_5m_single |

---

## 4-run comparison (SPY 5m) — completed

**Run 1 — A. BREAKOUT only**
```bash
node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout '' '' BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js SPY 5m audit
node engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout
```
→ Trades: 101 | Win rate: 28.71% | Expectancy R: -0.14 (2R) | Best R: 1R → 0.09

**Run 2 — B. BREAKOUT + strength**
```bash
node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout '' strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js SPY 5m audit
node engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout
```
→ Trades: 39 | Win rate: 30.77% | Expectancy R: -0.08 (2R) | Best R: 1R → 0.08

**Run 3 — C. BREAKOUT + confirmed + strength (premium)**
```bash
node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js SPY 5m audit
node engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout
```
→ Trades: 19 | Win rate: 36.84% | Expectancy R: 0.11 (2R) | Best R: 1.5R → 0.18

**Run 4 — D. Premium + late only**
```bash
node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout confirmed strength BREAKOUT noopen late
node engine/exampleTradeSimulationFromResearch.js SPY 5m audit
node engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout
```
→ Trades: 8 | Win rate: 50% | Expectancy R: 0.5 (2R) | Best R: 2R → 0.5 | sample trop petit

---

## QQQ (same setup)

```bash
node engine/exampleRunResearchFromConfig.js qqq_5m_single trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js QQQ 5m audit
node engine/exampleTradeSimulationSweepR.js QQQ 5m trend_breakout
```

(Add qqq_5m_single to GROUPS_SYNTHESIZE_TIMESTAMPS already done. Data: data/qqq_5m.csv.)

---

## IWM

When you have **data/iwm_5m.csv**: add `iwm_5m_single` in researchConfig (like qqq_5m_single) and add to GROUPS_SYNTHESIZE_TIMESTAMPS. Then:

```bash
node engine/exampleRunResearchFromConfig.js iwm_5m_single trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js IWM 5m audit
node engine/exampleTradeSimulationSweepR.js IWM 5m trend_breakout
```

---

## Tableau final SPY vs QQQ (bootstrap)

| | SPY premium 1.5R | QQQ premium 2R |
|---|------------------|----------------|
| **n** | 19 | 9 |
| **expectancy** | 0.18 | 0.33 |
| **bootstrap % &lt; 0** | 24.9% | 16.7% |
| **CI 90%** | [-0.34, 0.71] | [-0.33, 1.00] |

**Règle simple (interprétation du % bootstrap négatif) :**
- **&lt; 5%** négatif = **fort**
- **5% à 20%** = intéressant mais pas validé
- **&gt; 20%** = **fragile**

→ SPY à 24.9% est donc encore **fragile**. QQQ à 16.7% est dans la zone « intéressant mais pas validé ».

*Audit 1.5R : `node engine/exampleTradeSimulationFromResearch.js SPY 5m audit 1.5` puis `node engine/exampleBootstrapTrades.js research/trade_audit_SPY_5m_R1.5.json 10000 42`*

---

## Étape 3 — Élargir l’échantillon (sans changer le setup)

Le vrai problème maintenant n’est plus la logique, c’est **le nombre de trades**.

**Suite correcte :**
- Plus de données SPY (années supplémentaires ou barres si dispo)
- Plus de données QQQ (idem)
- Éventuellement IWM quand le CSV sera disponible

**Objectif pour le setup premium :**
- **30 à 50 trades minimum** par actif
- **Idéalement 60+**

Sans changer les règles (trend_breakout + confirmed + strength + BREAKOUT + noopen). Une fois l’échantillon agrandi, refaire audit + bootstrap pour voir si le % négatif descend et si la CI 90% se resserre.

**Config prête :** groupes `spy_5m_2019_2025` et `qqq_5m_2019_2025` (fichiers `data/spy_5m_2019.csv` … `spy_5m_2025.csv`, idem pour QQQ). Dès que les CSV sont en place, lancer research sur le groupe étendu.

---

## Roadmap — augmenter les données (sans toucher au setup)

**Étape 1 — Plus d’années (fait en config)**  
- SPY : 2019, 2020, 2021, 2022, 2023, 2024, 2025 → groupe `spy_5m_2019_2025`.  
- QQQ : idem → groupe `qqq_5m_2019_2025`.  
- Objectif : 50–100 trades.

**Étape 2 — Autres ETF similaires**  
- IWM, DIA : même logique (fichiers `iwm_5m.csv` / par année, `dia_5m*.csv`, groupes dans researchConfig).  
- Un edge breakout apparaît souvent sur plusieurs indices US.

**Étape 3 — Futures**  
- NQ, MNQ, ES, MES : plus de volatilité, moins de microstructure noise ; breakouts fonctionnent souvent mieux.  
- À brancher quand les données sont disponibles (même pattern : symbol + timeframe + années).

**Ce qu’il ne faut PAS faire**  
- Ne pas ajouter VWAP, ATR, compression, 20 nouveaux filtres.  
- Risque : backtest overfitting. Le bootstrap sert justement à limiter ça.

---

## Niveau suivant — Monte Carlo equity simulation

Évolution logique du moteur : simuler **capital growth**, **risk of ruin**, **max drawdown** sur des chemins de trades.

Exemple : 500 $ de compte, 1 % de risque par trade, simuler 10 000 chemins (bootstrap des R puis equity curve par chemin).  
Résultats possibles : combien de fois le compte explose, combien de fois il monte → vrai test de trading réel.

---

## Walk-forward validation (futur)

Module type hedge fund : construire le setup sur une fenêtre, ne plus rien changer, tester sur la fenêtre suivante.  
Permet de vérifier que la stratégie survit dans le futur et peut transformer le moteur en plateforme quant research complète.

---

## Verdict (résumé)

- **Setup principal recommandé** : **C** (confirmed + strength + BREAKOUT + noopen) — 19 trades, expectancy 0.11R à 2R, meilleur à 1.5R (0.18). Compromis sample / qualité.
- **Late only (D)** : intéressant (0.5R) mais 8 trades → pas validé comme setup principal.
- **QQQ** : même setup donne 9 trades, 0.33R à 2R → edge positif sur un autre actif, crédibilité renforcée ; sample à agrandir (plus d’années de données QQQ si dispo).
- **IWM** : à tester quand `data/iwm_5m.csv` et groupe `iwm_5m_single` seront en place.

---

## Decision rule for keeping a setup

Un setup est conservé seulement si :

1. **Expectancy positive**
2. **Sample size raisonnable** (≥ 20 trades minimum)
3. **Bootstrap stable** (≤ 20% samples négatifs)
4. **Logique de marché cohérente**
5. **Edge non dépendant d’un micro segment de données**
