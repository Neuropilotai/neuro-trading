# Nightly AI Trading Lab

Pipeline déterministe exécuté chaque nuit : même ordre, mêmes règles, sans improvisation.

---

## 1. Étapes du pipeline nocturne

| # | Étape | Détail |
|---|--------|--------|
| 1 | Vérifier 5TB monté | Exit si `$NEUROPILOT_DATA_ROOT` absent |
| 2 | Rafraîchir / déposer les datasets | (manuel ou script séparé ; le lab suppose que les données sont déjà là) |
| 3 | Discovery SPY 5m | `runStrategyDiscovery.js SPY 5m` |
| 4 | Discovery QQQ 5m | `runStrategyDiscovery.js QQQ 5m` |
| 5 | Discovery IWM 5m | Si `datasets/iwm/iwm_5m.csv` ou `data/iwm_5m.csv` existe |
| 6 | (Backtest batch + bootstrap) | Déjà inclus dans chaque run discovery |
| 7 | Snapshot brain | Copie `discovered_setups.json` et `strategy_batch_results.json` dans `brain_snapshots/` avec timestamp |
| 8 | Strategy Mutation | `strategyMutation.js` — lit discovered_setups, top N, génère 5–10 mutations chacun → `generated_strategies/setup_mut_*.js` |
| 9 | Strategy Evolution | `strategyEvolution.js` — score survie, écrit `champion_registry.json` |
| 10 | Backup daté Google Drive | `backup_discovery_to_gdrive.sh --dated` |

**Ordre des actifs :** SPY 5m → QQQ 5m → IWM 5m (si les données existent).

---

## 2. Structure sur le 5TB

```
/Volumes/My Passport/NeuroPilotAI/
  datasets/
    spy/
    qqq/
    iwm/
  features/
  generated_strategies/
  batch_results/
  bootstrap/
  discovery/
  brain_snapshots/
  champion_setups/    ← promotion des meilleurs setups (à alimenter par la logique de promotion)
  nightly_logs/       ← un log daté par run (nightly_YYYYMMDD_HHMMSS.log)
  archives/
```

---

## 3. Règle de promotion (champion)

Un setup passe en **champion** seulement si :

- Expectancy > 0  
- Au moins 20 trades  
- Bootstrap (% samples avec expectancy < 0) ≤ 20 %  
- Pas porté par un seul micro-segment  
- Logique lisible  

**Niveaux possibles :**

| Niveau | Signification |
|--------|----------------|
| **candidate** | Setup généré par discovery, pas encore validé |
| **validated** | Passe le filtre bootstrap + sample size |
| **champion** | Validé et promu dans `champion_setups/` (meilleur(s) setup(s) actuels) |

La logique de promotion (écriture dans `champion_setups/`, comparaison au champion actuel) peut être ajoutée dans le pipeline une fois le ranking global produit (ex. après agrégation des discovered_setups de chaque actif).

---

## 4. Script nocturne (version robuste)

**Fichier :** `scripts/np_nightly_lab.sh`

- Charge `~/.zshrc`, défaut pour `NEUROPILOT_PROJECT_ROOT` si absent.
- Vérification explicite du 5TB (variable définie + dossier existant).
- Création de l’arbo (un dossier par ligne).
- **sleep 30** au démarrage.
- Étapes [1/6] à [6/6] : SPY → QQQ → IWM (si données) → snapshot brain (avec vérification -f et [WARN] si absent) → backup GDrive (skip si GDRIVE_ROOT non défini ou absent) → fin.
- Log : `$NEUROPILOT_DATA_ROOT/nightly_logs/nightly_YYYYMMDD_HHMMSS.log`.

**Rendre exécutable :**

```bash
chmod +x scripts/np_nightly_lab.sh
```

**Test manuel :**

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
source ~/.zshrc
./scripts/np_nightly_lab.sh
```

---

## 5. Automatisation avec launchd (macOS)

Sur macOS, utiliser **launchd** plutôt que cron.

**Fichier plist :** le projet contient `scripts/com.neuropilot.nightlylab.plist`. À installer dans :

`~/Library/LaunchAgents/com.neuropilot.nightlylab.plist`

**Horaire :** 20:00 (8:00 PM) chaque soir.

---

### Commandes exactes pour l’installer

1. **Créer le dossier si besoin :**

   ```bash
   mkdir -p ~/Library/LaunchAgents
   ```

2. **Copier le plist depuis le projet :**

   ```bash
   cp /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2/scripts/com.neuropilot.nightlylab.plist ~/Library/LaunchAgents/
   ```

   Les sorties launchd sont dans le **projet** (toujours disponible, même si le 5TB n’est pas monté au moment du lancement) :  
   `nightly_lab_launchd.out.log` et `nightly_lab_launchd.err.log` à la racine du repo.  
   Le log complet du script reste sur le 5TB : `$NEUROPILOT_DATA_ROOT/nightly_logs/nightly_YYYYMMDD_HHMMSS.log`.

3. **Charger le job :**

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.neuropilot.nightlylab.plist 2>/dev/null
   launchctl load ~/Library/LaunchAgents/com.neuropilot.nightlylab.plist
   ```

4. **Vérifier qu’il est chargé :**

   ```bash
   launchctl list | grep neuropilot
   ```

   Tu dois voir : `com.neuropilot.nightlylab`

---

### Tester tout de suite (sans attendre 20h)

```bash
launchctl start com.neuropilot.nightlylab
```

---

### Désactiver / arrêter

```bash
launchctl unload ~/Library/LaunchAgents/com.neuropilot.nightlylab.plist
```

---

### Deux points importants

- **Ton Mac doit être** : allumé et **session ouverte** à 20h (sinon le job ne s’exécute pas).
- **Le 5TB doit être monté** avant le lancement ; sinon le script sort en erreur (comportement voulu).

### Recommandations horaire et environnement

- **20:00** pour le launchd.
- **30 secondes de délai** au début du script (déjà dans `np_nightly_lab.sh`) pour laisser le système se stabiliser.
- **Mac branché au courant** pendant le run.
- **Réglages d’énergie** : éviter la mise en veille pendant l’exécution du job (Préférences Système → Énergie / Batterie).

### Google Drive

- **5TB** = workspace actif (calcul, batch, discovery, brain).
- **Google Drive** = sauvegarde / archive uniquement.
- **Ne pas lancer le moteur directement dans un dossier synchronisé Google Drive** : lenteurs et risques de sync. Ça évite les problèmes.

---

## 6. Ce que produit chaque nuit

| Où | Quoi |
|----|------|
| **nightly_logs/** | Un log daté de toute l’exécution |
| **brain_snapshots/** | `discovered_setups_YYYYMMDD_HHMMSS.json`, `strategy_batch_results_YYYYMMDD_HHMMSS.json` |
| **Google Drive** | Archives datées discovery + brain (via `backup_discovery_to_gdrive.sh --dated`) |

---

## 7. Règles pour éviter de saturer le Mac

- **5TB** = workspace actif (gros fichiers, batch, bootstrap, brain, discovery).  
- **Google Drive** = backup, archive, résultats finaux.  
- **Mac local** = code, scripts, petits logs, fallback.

Ne pas faire tourner le moteur directement dans un dossier synchronisé Google Drive (ralentissements, conflits de sync, mauvais pour gros fichiers temporaires).

---

## 8. Prochaine couche : self-learning évolutif

Quand le nightly lab tourne bien, la prochaine étape est :

- Comparer le ranking d’hier vs aujourd’hui  
- Détecter quels setups montent ou se dégradent  
- Promouvoir automatiquement un champion  
- Rétrograder les setups qui perdent en robustesse  
- Conserver l’historique du “brain” par date  

On passe alors d’un moteur de test à un **research system évolutif**.
