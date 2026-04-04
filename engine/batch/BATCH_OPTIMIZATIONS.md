# Batch optimisations (M3 Pro)

Pour passer de **~500 stratégies/nuit** à **5000–20000** :

## 1. Batch parallèle (workers CPU)

- **`const workers = os.cpus().length`** → ex. 10 cores = 10 backtests en parallèle.
- Config : **`engine/batch/batchConfig.js`** — `getWorkerCount()` (override avec `BATCH_WORKERS`).
- Exécution : **`engine/batch/parallelBatchRunner.js`** — `runInParallel(items, concurrency, fn)` en chunks de `concurrency` avec `Promise.all`.

Quand le backtest réel sera branché dans `runStrategyBatch`, appeler :

```js
const results = await runInParallel(setups, getWorkerCount(), (setup) => runOneBacktest(setup, cachedCandles));
```

## 2. Streaming CSV (éviter la mémoire)

- Ne pas charger tout le CSV en mémoire : utiliser **streams Node** ou **fast-csv**.
- Idée : `fs.createReadStream(path).pipe(csvParser)` et construire les candles au fil de l’eau, ou utiliser `fast-csv` (npm) pour parser en streaming.
- À intégrer dans **datasetLoader** (ou un `datasetLoaderStream.js`) pour que `loadFromFile` / `loadOHLCCache` puisse remplir le cache OHLC en streaming au lieu de `readFileSync` + `parseCSV(content)`.

Exemple (conceptuel) :

```js
const fs = require('fs');
const { parse } = require('fast-csv'); // ou parse manuel ligne par ligne
const candles = [];
fs.createReadStream(filePath)
  .pipe(parse({ headers: true }))
  .on('data', (row) => candles.push(normalizeCandle(row)))
  .on('end', () => resolve({ symbol, timeframe, candles }));
```

## 3. Cache OHLC (une seule lecture)

- Lire le dataset **une seule fois** par (symbol, timeframe) puis **partager** le même tableau (ou référence) à tous les workers.
- Dans `runStrategyBatch` : appeler `loadOHLCCache(dataGroup)` une fois, puis passer `candles` à chaque `runOneBacktest(setup, candles)` dans `runInParallel`.
- Évite de relire le CSV pour chaque stratégie (grosse économie I/O et mémoire si on évite de dupliquer les candles).

---

**Résumé** : workers = `getWorkerCount()` (défaut `os.cpus().length`), exécution parallèle avec `runInParallel`, cache OHLC chargé une fois et partagé, CSV en streaming pour limiter la RAM.
