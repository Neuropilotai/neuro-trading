# Nightly pipeline — 100% autonome

## Ordre recommandé (type hedge fund)

| Heure  | Étape              | Commande / action |
|--------|--------------------|-------------------|
| **20h00** | Dataset update     | `node engine/scripts/autoDownloadDatasets.js` — check datasets, download missing, append si besoin. |
| **20h05** | Discovery          | `./engine/scripts/runDiscoverySpyQqqBtc.sh` — CSV→binary + two-stage (SPY, QQQ, BTCUSDT 5m). |
| **02h00** | Meta ranking       | Agrégation des résultats + `engine/meta/metaRankingEngine.js` (cross-asset + timeframe + meta_score). |
| **03h00** | Champion portfolio | `engine/meta/championPortfolioBuilder.js` + `writePortfolio()` → `discovery/strategy_portfolio.json`. |

Ton Mac M3 Pro peut enchaîner tout ça sans problème.

## Une seule commande (run complet)

```bash
export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
node engine/scripts/autoDownloadDatasets.js && ./engine/scripts/runDiscoverySpyQqqBtc.sh
```

Ou le script dédié :

```bash
./engine/scripts/runFullPipeline.sh
```

## Pipeline global (Data → Discovery → Meta → Evolution → Paper)

Tout enchaîner en une commande :

```bash
NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI ./engine/scripts/runGlobalPipeline.sh
```

Étapes :  
1. **runDataEngine** — manifest, download manquants, update, validate, .bin  
2. **runFullPipeline** — auto download + two-stage (SPY, QQQ, BTCUSDT, XAUUSD)  
3. **runMetaPipeline** — cross-asset, multi-timeframe, meta ranking, strategy_portfolio.json  
4. **strategyEvolution** — nightly history → champion_registry.json  
5. **runPaperSession --reload-champions** — recharger la liste champions pour la session paper

## Amélioration future : 10M → 100M stratégies/nuit

**Dataset Binary Memory Mapping** — Au lieu de charger tout le binaire en RAM (`readBinaryStore`), utiliser un chargement type memory-mapped (ou lecture par chunks) pour que le moteur analyse 10–20× plus vite. Les bases sont dans `datasetBinaryStore.js` ; il restera à brancher une lecture par segment ou un worker pool qui lit le .bin par blocs.
