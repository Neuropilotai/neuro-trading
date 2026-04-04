# Runbook — Brancher le Discovery Engine sur le 5TB

## 1. Où vit chaque chose

| | Emplacement |
|---|-------------|
| **Code** | Mac : `/Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2` |
| **Données lourdes** | 5TB : `/Volumes/My Passport/NeuroPilotAI` |
| **Backup / archive** | Google Drive (pas comme moteur principal de calcul) |

---

## 2. Créer l’arborescence sur le 5TB

Quand le 5TB est branché :

```bash
mkdir -p /Volumes/My Passport/NeuroPilotAI/{datasets,features,discovery,generated_strategies,batch_results,bootstrap,walkforward,brain_snapshots,archives}
```

Vérifier :

```bash
ls -R /Volumes/My Passport/NeuroPilotAI
```

Tu dois voir : `datasets`, `features`, `discovery`, `generated_strategies`, `batch_results`, `bootstrap`, `walkforward`, `brain_snapshots`, `archives`.

---

## 3. Variable d’environnement

Dans le terminal :

```bash
export NEUROPILOT_DATA_ROOT="/Volumes/My Passport/NeuroPilotAI"
```

Vérifier : `echo $NEUROPILOT_DATA_ROOT` → `/Volumes/My Passport/NeuroPilotAI`

---

## 4. Contenu recommandé pour ~/.zshrc (NeuroPilot) — version robuste

Édite : `nano ~/.zshrc` et colle ce bloc **à la fin** :

```bash
# =========================
# NeuroPilot AI Trading Lab
# =========================

export NEUROPILOT_PROJECT_ROOT="$HOME/neuro-pilot-ai/neuropilot_trading_v2"
export NEUROPILOT_DATA_ROOT="/Volumes/My Passport/NeuroPilotAI"
export NEUROPILOT_GDRIVE_BACKUP_ROOT="$HOME/Library/CloudStorage/GoogleDrive-neuro.pilot.ai@gmail.com/My Drive/Neuro.Pilot.AI/backups"

export NP_DEFAULT_SYMBOL="SPY"
export NP_DEFAULT_TF="5m"

export NODE_OPTIONS="--max-old-space-size=8192"

alias np='cd "$NEUROPILOT_PROJECT_ROOT"'
alias npdata='cd "$NEUROPILOT_DATA_ROOT"'
alias npls='ls -lah "$NEUROPILOT_DATA_ROOT"'
alias npdiscover='cd "$NEUROPILOT_PROJECT_ROOT" && node engine/discovery/runStrategyDiscovery.js'
alias npbackup='cd "$NEUROPILOT_PROJECT_ROOT" && ./scripts/backup_discovery_to_gdrive.sh'

if [[ -n "$PS1" ]]; then
  echo "[NeuroPilot] PROJECT=$NEUROPILOT_PROJECT_ROOT"
fi
```

Recharge :

```bash
source ~/.zshrc
```

Vérifier :

```bash
echo $NEUROPILOT_PROJECT_ROOT
echo $NEUROPILOT_DATA_ROOT
echo $NEUROPILOT_GDRIVE_BACKUP_ROOT
```

---

## 4b. Script de démarrage np_start.sh

Le script `scripts/np_start.sh` dans le projet fait : charger `.zshrc`, vérifier le 5TB, créer les dossiers, ouvrir le projet, vérifier les datasets, lancer un test discovery, afficher les outputs.

**Option A — Depuis le projet (recommandé)**  
Après avoir fait `source ~/.zshrc` une fois :

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
chmod +x scripts/np_start.sh
./scripts/np_start.sh
```

**Option B — Copie dans le home pour un seul raccourci le matin**

```bash
cp /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2/scripts/np_start.sh ~/np_start.sh
chmod +x ~/np_start.sh
```

Puis chaque matin : `~/np_start.sh`

---

## 5. Répertoire de travail

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
```

Pas besoin de venv pour Node.js.

---

## 6. Comportement du fallback

- **5TB monté et `NEUROPILOT_DATA_ROOT` défini** → le moteur écrit sur le 5TB.
- **Sinon** → il écrit dans `./data_workspace/`.

Le système continue de fonctionner si le disque n’est pas branché (mode dev local).

---

## 7. Vérifier que le moteur voit le 5TB

Lancer une discovery :

```bash
node engine/discovery/runStrategyDiscovery.js SPY 5m
```

Puis sur le 5TB :

```bash
find /Volumes/My Passport/NeuroPilotAI -maxdepth 2 -type f
```

Tu devrais voir des fichiers dans : `features/`, `generated_strategies/`, `batch_results/`, `discovery/`.

---

## 8. Où chaque étape écrit

| Étape | Répertoire / fichier |
|--------|----------------------|
| 1. Feature extraction | `$NEUROPILOT_DATA_ROOT/features/` → ex. `features_SPY_5m.json` |
| 2. Pattern discovery | Lit depuis `features/`, produit les patterns (couche discovery) |
| 3. Candidate strategies | `$NEUROPILOT_DATA_ROOT/generated_strategies/` → `setup_001.js`, `setup_002.js`, … |
| 4. Batch backtest | `$NEUROPILOT_DATA_ROOT/batch_results/strategy_batch_results.json` |
| 5. Bootstrap / ranking | `$NEUROPILOT_DATA_ROOT/discovery/discovered_setups.json` |
| 6. Walk-forward | `$NEUROPILOT_DATA_ROOT/walkforward/` |
| Brain snapshots | `$NEUROPILOT_DATA_ROOT/brain_snapshots/` |

---

## 9. Où mettre les datasets

Gros CSV sur le 5TB, par exemple :

```
/Volumes/My Passport/NeuroPilotAI/datasets/spy/spy_5m_2019.csv
/Volumes/My Passport/NeuroPilotAI/datasets/spy/spy_5m_2020.csv
/Volumes/My Passport/NeuroPilotAI/datasets/qqq/qqq_5m_2019.csv
```

Le loader du moteur peut lire depuis `$NEUROPILOT_DATA_ROOT/datasets/<symbol>/` si le fichier n’existe pas dans `./data/` (voir `engine/datasetLoader.js`).

---

## 10. Commandes de travail recommandées

**Discovery complète :**

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/My Passport/NeuroPilotAI"
node engine/discovery/runStrategyDiscovery.js SPY 5m
```

**Vérifier les sorties :**

```bash
ls /Volumes/My Passport/NeuroPilotAI/features
ls /Volumes/My Passport/NeuroPilotAI/generated_strategies
ls /Volumes/My Passport/NeuroPilotAI/batch_results
ls /Volumes/My Passport/NeuroPilotAI/discovery
```

---

## 11. Logique de sauvegarde

| Où | Quoi |
|----|------|
| **Local (Mac)** | Code source, config, scripts Node, docs Markdown |
| **5TB** | Gros CSV, features JSON, batch results, bootstrap, walk-forward, stratégies générées, brain snapshots |
| **Google Drive** | Backups finaux, archives datées, rapports, top setups validés, snapshots importants |

---

## 12. À ne pas faire

Ne pas lancer la discovery directement dans un dossier Google Drive synchronisé en direct pour :

- SQLite
- batch JSON écrits en boucle
- milliers de petits fichiers
- discovery active
- Monte Carlo massif

Risque : ralentissements et états corrompus.

---

## 13. Script exact de backup vers Google Drive

Depuis le projet :

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
chmod +x scripts/backup_discovery_to_gdrive.sh
```

**Backup normal (écrase le dernier) :**

```bash
./scripts/backup_discovery_to_gdrive.sh
```

**Backup daté (recommandé en fin de session) :**

```bash
./scripts/backup_discovery_to_gdrive.sh --dated
```

**Ce que le script copie :**

| Source (5TB) | Destination (Google Drive) |
|--------------|----------------------------|
| `discovery/` | `$NEUROPILOT_GDRIVE_BACKUP_ROOT/discovery_backups/discovery` (ou `discovery_YYYYMMDD_HHMM` avec `--dated`) |
| `brain_snapshots/` | `$NEUROPILOT_GDRIVE_BACKUP_ROOT/brain_backups/brain_snapshots` (ou avec suffixe daté) |

---

## 14. Règle au quotidien

- **5TB branché** → `export NEUROPILOT_DATA_ROOT="/Volumes/My Passport/NeuroPilotAI"` et travail normal.
- **5TB non branché** → le moteur utilise `./data_workspace/` ; tu peux continuer à développer.

---

## 15. Vérification finale (30 secondes)

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/My Passport/NeuroPilotAI"
node engine/discovery/runStrategyDiscovery.js SPY 5m
find /Volumes/My Passport/NeuroPilotAI -maxdepth 2 -type f
```

Si des fichiers apparaissent sur le 5TB, c’est branché correctement.

---

## 16. Checklist terminal complète — démarrage quotidien

**A. Brancher le 5TB**  
Assure-toi que My Passport est monté.

```bash
ls /Volumes
# Tu dois voir My Passport
```

**B. Ouvrir le projet**

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
```

**C. Charger les variables**

```bash
source ~/.zshrc
```

**D. Vérifier les variables**

```bash
echo $NEUROPILOT_DATA_ROOT
echo $NEUROPILOT_GDRIVE_BACKUP_ROOT
```

**E. Vérifier que le 5TB existe**

```bash
test -d "$NEUROPILOT_DATA_ROOT" && echo "5TB OK" || echo "5TB MISSING"
```

**F. Vérifier l’arborescence (crée si manquant)**

```bash
mkdir -p "$NEUROPILOT_DATA_ROOT"/{datasets,features,discovery,generated_strategies,batch_results,bootstrap,walkforward,brain_snapshots,archives}
```

**G. Vérifier les datasets (si tu utilises le 5TB pour les données)**

```bash
find "$NEUROPILOT_DATA_ROOT/datasets" -maxdepth 3 -type f
# Exemple attendu: .../datasets/spy/spy_5m_2022.csv, .../datasets/qqq/qqq_5m.csv
```

**H. Test rapide du Discovery Engine**

```bash
node engine/discovery/runStrategyDiscovery.js SPY 5m
```

**I. Vérifier que les sorties sont bien sur le 5TB**

```bash
find "$NEUROPILOT_DATA_ROOT" -maxdepth 2 -type f
# Tu dois voir des fichiers dans features/, generated_strategies/, batch_results/, discovery/
```

**J. Test research normal (ex. SPY premium)**

```bash
node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout confirmed strength BREAKOUT noopen
node engine/exampleTradeSimulationFromResearch.js SPY 5m audit 1.5
node engine/exampleBootstrapTrades.js research/trade_audit_SPY_5m_R1.5.json 10000 42
```

**K. Backup Google Drive en fin de session**

```bash
./scripts/backup_discovery_to_gdrive.sh --dated
```

---

## 17. Commandes rapides (alias après chargement du .zshrc)

| Commande | Effet |
|----------|--------|
| `np` | `cd` vers le projet |
| `npdata` | `cd` vers le 5TB |
| `npls` | `ls -lah` du data root |
| `npdiscover SPY 5m` | Lancer discovery (SPY 5m par défaut si omis) |
| `npbackup --dated` | Backup Google Drive avec suffixe daté |

Exemples :

```bash
np
npdata
npdiscover SPY 5m
npdiscover QQQ 5m
npbackup --dated
```

---

## 18. Routine quotidienne simple

**Matin :**

```bash
~/np_start.sh
# ou depuis le projet : ./scripts/np_start.sh
```

**Pendant la journée :**

```bash
npdiscover SPY 5m
npdiscover QQQ 5m
```

**Fin de journée :**

```bash
npbackup --dated
```

---

## 19. Routine courte du matin (sans np_start.sh)

Quasi quotidien :

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
source ~/.zshrc
test -d "$NEUROPILOT_DATA_ROOT" && echo "5TB OK" || echo "5TB MISSING"
node engine/discovery/runStrategyDiscovery.js SPY 5m
```

**Le soir :**

```bash
./scripts/backup_discovery_to_gdrive.sh --dated
```

---

## 20. Si le 5TB n’est pas branché

Le moteur retombe sur `./data_workspace/` :

- ça continue de fonctionner ;
- mais les gros outputs iront sur ton Mac ;
- pour les runs lourds, mieux vaut attendre que le 5TB soit branché.

**Vérification :**

```bash
test -d "/Volumes/My Passport/NeuroPilotAI" && echo "external drive mode" || echo "local fallback mode"
```

---

## 21. Déplacer les datasets sur le 5TB

Structure recommandée :

```
/Volumes/My Passport/NeuroPilotAI/datasets/spy/spy_5m_2019.csv
/Volumes/My Passport/NeuroPilotAI/datasets/spy/spy_5m_2020.csv
/Volumes/My Passport/NeuroPilotAI/datasets/spy/spy_5m_2021.csv
/Volumes/My Passport/NeuroPilotAI/datasets/spy/spy_5m_2022.csv
/Volumes/My Passport/NeuroPilotAI/datasets/qqq/qqq_5m.csv
```

Le `datasetLoader.js` essaie d’abord le chemin repo (`./data/`), puis `$NEUROPILOT_DATA_ROOT/datasets/<symbol>/` si le fichier est absent.

---

## 22. Vérification santé du moteur

```bash
du -sh $NEUROPILOT_DATA_ROOT/*
```

Tu vois la taille de : `features`, `discovery`, `batch_results`, `generated_strategies`, etc.

---

## 23. Commandes de contrôle utiles

```bash
# Taille des dossiers sur le 5TB
du -sh "$NEUROPILOT_DATA_ROOT"/*

# Stratégies générées
ls "$NEUROPILOT_DATA_ROOT/generated_strategies"

# Setups découverts
cat "$NEUROPILOT_DATA_ROOT/discovery/discovered_setups.json"

# Résultats batch
cat "$NEUROPILOT_DATA_ROOT/batch_results/strategy_batch_results.json"
```

---

## 24. Architecture (ce que tu as mis en place)

```
MacBook
   │
   ├─ Code + Node engine (neuropilot_trading_v2)
   │
   ├─ Discovery Engine
   │
   ▼
5TB My Passport ($NEUROPILOT_DATA_ROOT)
   ├ datasets
   ├ features
   ├ generated_strategies
   ├ batch_results
   ├ discovery
   ├ brain_snapshots
   ├ champion_setups
   ├ nightly_logs
   │
   ▼
Google Drive ($NEUROPILOT_GDRIVE_BACKUP_ROOT)
   ├ discovery_backups
   ├ brain_backups
```

C’est la même logique que dans plusieurs labs quant research.

**Nightly AI Trading Lab :** pipeline nocturne déterministe (SPY → QQQ → IWM discovery, snapshot brain, backup). Script : `./scripts/np_nightly_lab.sh`. Doc : `engine/NIGHTLY_LAB.md` (règles de promotion champion, launchd 01:30, évolution self-learning).

---

## 25. Prochaine étape recommandée

1. Brancher définitivement tous les datasets lourds sur le 5TB.
2. Utiliser Google Drive seulement pour les backups datés.
3. Lancer discovery sur SPY puis QQQ.
4. Plus tard : ajouter IWM, DIA, NQ, ES.

Le moteur commence à ressembler à un petit research lab quant.
