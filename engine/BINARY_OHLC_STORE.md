# Binary OHLC Store — Dataset Binary Loader

## Objectif

Remplacer la lecture CSV par un **store binaire OHLC** pour accélérer le moteur d’environ **5× à 20×** et permettre au Mac M3 Pro d’analyser **5M à 10M stratégies par nuit** sans cloud.

## Format

- **Header (52 bytes)** : magic `NPOHLC1` + count (UInt32LE) + symbol (32B) + timeframe (8B)
- **Record (32 bytes par barre)** : time Float64LE, open/high/low/close Float32LE, volume Float64LE

Fichier : **engine/datasetBinaryStore.js** — `writeBinaryStore`, `readBinaryStore`, `readBinaryStoreSync`.

## Intégration

- **datasetLoader.loadFromFile** : si le chemin demandé est un `.csv` et qu’un fichier `.bin` de même nom existe dans le même dossier, le **.bin est chargé à la place** du CSV (option `preferBinary: true` par défaut).
- Aucun changement nécessaire dans le reste du pipeline (runTwoStageDiscovery, batch, etc.) : le loader choisit automatiquement le binaire quand il est présent.

## Conversion CSV → binaire

```bash
node engine/scripts/csvToBinary.js <path-to.csv> [symbol] [timeframe]
```

Exemple :

```bash
node engine/scripts/csvToBinary.js /Volumes/TradingDrive/NeuroPilotAI/datasets/spy/spy_5m.csv SPY 5m
```

Le fichier `.bin` est écrit à côté du CSV (même dossier, même nom de base, extension `.bin`). Les runs suivants qui chargent ce dataset utiliseront le `.bin` automatiquement.

## Workflow recommandé

1. Ajouter les CSV (SPY, QQQ, BTCUSDT, etc.) dans `datasets/<symbol>/<symbol>_<tf>.csv`.
2. Lancer une fois la conversion : `csvToBinary.js` pour chaque CSV (ou un script batch).
3. Lancer le two-stage / nightly : le loader utilisera les `.bin` quand ils existent.

## Désactiver le binaire

Pour forcer la lecture CSV (par ex. pour un test) : `loadFromFile(path, symbol, timeframe, { preferBinary: false })`.
