# Dynamic Universe Manager

## Purpose

`backend/services/dynamicUniverseManager.js` is a **symbol selection and prioritization layer** for the autonomous entry engine. It is:

- **Explainable** — scores decompose into named components with human-readable reasons.
- **Deterministic** — same inputs (env + context) produce the same universe.
- **Auditable** — optional JSON snapshot on disk; structured console logs on each build.
- **Paper-first** — it does not place orders, size risk, or bypass governance.

It is **not** a trading engine. It only answers: which symbols should be considered for scanning (active vs watchlist vs dropped vs suspended).

**Phase 2** adds optional macro / news / calendar boosts on top of the rule-based score. See [DYNAMIC_UNIVERSE_MACRO.md](./DYNAMIC_UNIVERSE_MACRO.md).

## Outputs

A successful build returns a machine-readable object including:

| Field | Meaning |
|--------|---------|
| `ok` | Boolean success |
| `generatedAt` | ISO timestamp |
| `version` | `1` = phase 1 only; `2` when macro layer ran (`DYNAMIC_UNIVERSE_MACRO_ENABLED`) |
| `source` | Always `dynamic_universe_manager` |
| `activeSymbols` | Top N by score (cap = `DYNAMIC_UNIVERSE_MAX_ACTIVE`) |
| `watchlistSymbols` | Next M by score |
| `suspendedSymbols` | Explicitly suspended symbols from config |
| `droppedSymbols` | Ineligible or not selected |
| `diagnostics` | Counts, `reasonsBySymbol`, snapshot warnings |
| `scores` | Per-symbol score, decision, reasons, components |
| `constraints` | Effective max active / watchlist |
| `configUsed` | Sanitized config echoed for audit |
| `macroContext` | Present when macro enabled: regime bias, confidence |
| `providerStatus` | Calendar/news provider summary |
| `inputs` | Echo of calendar events and news signals used (when macro on) |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DYNAMIC_UNIVERSE_ENABLED` | `false` | When `true`, `resolveAutonomousSymbolsSync()` uses `buildDynamicUniverse().activeSymbols` for the autonomous engine (opt-in; does not silently override static lists otherwise). |
| `DYNAMIC_UNIVERSE_MAX_ACTIVE` | `5` | Max active symbols |
| `DYNAMIC_UNIVERSE_MAX_WATCHLIST` | `5` | Max watchlist symbols |
| `DYNAMIC_UNIVERSE_BASE_SYMBOLS` | See code default CSV | Base candidate pool |
| `DYNAMIC_UNIVERSE_EXTRA_SYMBOLS` | _(empty)_ | Additional symbols merged with base |
| `DYNAMIC_UNIVERSE_ALLOW_CRYPTO` | `true` | Allow `crypto` asset class |
| `DYNAMIC_UNIVERSE_ALLOW_FX` | `true` | Allow `fx` |
| `DYNAMIC_UNIVERSE_ALLOW_INDICES` | `true` | Allow `indices` |
| `DYNAMIC_UNIVERSE_ALLOW_METALS` | `true` | Allow `metals` |
| `DYNAMIC_UNIVERSE_WRITE_SNAPSHOT` | `true` | Persist last build to disk |
| `DYNAMIC_UNIVERSE_SNAPSHOT_PATH` | `dynamic_universe_latest.json` (under `DATA_DIR`) | Snapshot filename or absolute path |
| `DYNAMIC_UNIVERSE_SUSPENDED_SYMBOLS` | _(empty)_ | Comma list forced to suspended |

Related (unchanged) symbols env for **legacy** resolution when `DYNAMIC_UNIVERSE_ENABLED` is false:

- `AUTO_ENTRY_SYMBOLS`, `AUTO_ENTRY_USE_UNIVERSE_FILE`, `ACTIVE_SYMBOL_UNIVERSE_PATH`, `data/active_symbol_universe.json`

## HTTP API

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/universe` | Returns last snapshot from disk if present; otherwise `{ ok: false, error: 'no_snapshot', ... }`. |
| `POST` | `/api/universe/run` | Runs `buildDynamicUniverse(context)`; body may include `{ "context": { ... } }`. Secured like other operator run endpoints (`allowDevOrSecuredRole('operator', ...)`). |

## Programmatic API

```js
const u = require('./backend/services/dynamicUniverseManager');

u.getDynamicUniverseConfig({ maxActiveSymbols: 4 });
u.getDynamicUniverseCandidates();
u.scoreUniverseCandidate('XAUUSD', { config, allCandidatesSorted, explicitSuspended });
u.buildDynamicUniverse({ config: { ... }, explicitSuspended: [] });
u.writeDynamicUniverseSnapshot(result, config);
u.loadLatestDynamicUniverseSnapshot();
```

Legacy exports used by the autonomous entry engine:

- `resolveAutonomousSymbolsSync()` — static file / env / **optional dynamic** universe
- `DEFAULT_SYMBOL_CSV`, `parseCsv`, `universeFilePath`, `writeStubUniverseFileSync`

## Testing

From repo root:

```bash
node tests/dynamicUniverseManager.test.js
```

## Integrating with the autonomous entry engine

**Current behavior (safe default):** With `DYNAMIC_UNIVERSE_ENABLED=false` (default), symbol resolution is unchanged: `active_symbol_universe.json` → `AUTO_ENTRY_SYMBOLS` → default CSV.

**Opt-in dynamic path:** Set `DYNAMIC_UNIVERSE_ENABLED=true`. Then `resolveAutonomousSymbolsSync()` uses `buildDynamicUniverse().activeSymbols`. If the build fails or returns no actives, the module **falls back** to legacy resolution and logs a warning.

**Recommended Railway bootstrap:**

```env
DYNAMIC_UNIVERSE_ENABLED=true
DYNAMIC_UNIVERSE_MAX_ACTIVE=4
DYNAMIC_UNIVERSE_MAX_WATCHLIST=4
DYNAMIC_UNIVERSE_BASE_SYMBOLS=XAUUSD,EURUSD,USDJPY,BTCUSD,NAS100USD,SPX500USD
DYNAMIC_UNIVERSE_ALLOW_CRYPTO=true
DYNAMIC_UNIVERSE_ALLOW_FX=true
DYNAMIC_UNIVERSE_ALLOW_INDICES=true
DYNAMIC_UNIVERSE_ALLOW_METALS=true
DYNAMIC_UNIVERSE_WRITE_SNAPSHOT=true
DYNAMIC_UNIVERSE_SNAPSHOT_PATH=data/dynamic_universe_latest.json
```

Ensure `DATA_DIR` points at your persistent volume so snapshots survive restarts.

## Extending with news / macro / regime

The `buildDynamicUniverse(context)` call accepts optional hooks on `context` (no-ops today):

- `newsSignalProvider`
- `macroCalendarProvider`
- `marketRegimeProvider`

Version 1 implements `applyFutureProviderBoosts()` as a pass-through. Add small, testable boosts there (or pre-score filters) without pulling execution or risk logic into this module.

## Files

- Implementation: `backend/services/dynamicUniverseManager.js`
- Snapshot default: `$DATA_DIR/dynamic_universe_latest.json`
- Routes: `server.js` (`/api/universe`, `/api/universe/run`)
