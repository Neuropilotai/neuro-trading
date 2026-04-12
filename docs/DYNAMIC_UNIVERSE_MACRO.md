# Dynamic Universe — Phase 2 (Macro / News / Calendar)

## Architecture

Three small services sit **above** phase-1 rule scoring and **below** the autonomous entry engine:

1. **`macroCalendarProvider.js`** — normalized economic events (mock JSON fixture by default).
2. **`newsSignalProvider.js`** — normalized news-like signals (mock JSON fixture by default).
3. **`macroScoringService.js`** — combines phase-1 scores with calendar/news boosts, symbol sensitivity map, and caps.

`dynamicUniverseManager.js` calls `buildMacroAdjustedUniverseScores()` when `DYNAMIC_UNIVERSE_MACRO_ENABLED=true`. If providers fail or return empty data, scoring **degrades** to available inputs; if merge throws, the build still succeeds with warnings and phase-1 scores preserved.

No HTTP calls are required in Phase 2. Fixtures live under `data/`:

- `data/mock_macro_calendar.json`
- `data/mock_news_signals.json`

If events/signals fall outside the time window or look “stale”, providers log a warning and may return a **fallback subset** so operators always see something in dry-run.

## Provider model

| Provider key | Env | Behavior |
|--------------|-----|----------|
| Calendar | `DYNAMIC_UNIVERSE_CALENDAR_PROVIDER` | `mock` / `fixture` → read JSON from `DATA_DIR` or `DYNAMIC_UNIVERSE_CALENDAR_FIXTURE_PATH` |
| News | `DYNAMIC_UNIVERSE_NEWS_PROVIDER` | `mock` / `fixture` → read JSON from `DATA_DIR` or `DYNAMIC_UNIVERSE_NEWS_FIXTURE_PATH` |

Swap implementations later by adding new provider branches (RSS, free REST, broker calendar) **without** changing scoring math — only normalized event/signal shapes need to match.

## Environment variables (Phase 2)

| Variable | Default | Description |
|----------|---------|-------------|
| `DYNAMIC_UNIVERSE_MACRO_ENABLED` | `false` | Master switch for macro layer |
| `DYNAMIC_UNIVERSE_NEWS_ENABLED` | `false` | Use news signals in scoring |
| `DYNAMIC_UNIVERSE_CALENDAR_ENABLED` | `false` | Use calendar events in scoring |
| `DYNAMIC_UNIVERSE_NEWS_PROVIDER` | `mock` | Provider id |
| `DYNAMIC_UNIVERSE_CALENDAR_PROVIDER` | `mock` | Provider id |
| `DYNAMIC_UNIVERSE_NEWS_MAX_AGE_MINUTES` | `360` | Stale news filter |
| `DYNAMIC_UNIVERSE_CALENDAR_LOOKAHEAD_HOURS` | `24` | Event horizon |
| `DYNAMIC_UNIVERSE_MACRO_MAX_BOOST` | `0.25` | Cap on **total** macro add-on per symbol |
| `DYNAMIC_UNIVERSE_MACRO_WRITE_SNAPSHOT` | `true` | Write `dynamic_universe_macro_latest.json` |
| `DYNAMIC_UNIVERSE_MACRO_SNAPSHOT_PATH` | `dynamic_universe_macro_latest.json` | Under `DATA_DIR` unless absolute |

Phase 1 snapshot (`DYNAMIC_UNIVERSE_WRITE_SNAPSHOT`) remains independent.

## Output schema (macro-enabled)

- `version`: **2**
- `macroContext`: `{ enabled, newsEnabled, calendarEnabled, regimeBias, confidence }`
- `providerStatus`: counts and source ids
- `scores[].components`: includes `baseUniverseScore`, `newsBoost`, `calendarBoost`, `macroSensitivityBoost`, `uncertaintyPenalty`, and `phase1Components` (original phase-1 breakdown)
- `diagnostics`: `newsSignalCount`, `calendarEventCount`, `impactedSymbols`, `providerWarnings`

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/universe/macro` | Last macro snapshot (if written) |
| POST | `/api/universe/macro/run` | Build with `macroEnabled: true` (operator auth in production) |

`POST /api/universe/run` also runs macro when env flags are set.

## Testing

```bash
node tests/macroUniversePhase2.test.js
node tests/dynamicUniverseManager.test.js
```

## Fallback behavior

1. Fixture missing → embedded placeholder calendar event; news may be empty.
2. All events outside window → first N fixture events used with warning.
3. All news stale → fallback slice with warning.
4. Provider exception → warning string in `providerWarnings`; scoring continues with partial data.
5. Macro merge exception → `macroContext` reflects failure; phase-1 scores used for ranking.

## Future work (Phase 3+)

- Live calendar/news adapters returning the same normalized shapes.
- Stronger regime inference (`marketRegimeProvider` hook already exists in context).
- Per-symbol learned impact weights from closed trades (feedback loop) — **not** in this phase.

## Safest next integration step

Enable on Railway **only after** paper validation:

```env
DYNAMIC_UNIVERSE_ENABLED=true
DYNAMIC_UNIVERSE_MACRO_ENABLED=true
DYNAMIC_UNIVERSE_NEWS_ENABLED=true
DYNAMIC_UNIVERSE_CALENDAR_ENABLED=true
DYNAMIC_UNIVERSE_NEWS_PROVIDER=mock
DYNAMIC_UNIVERSE_CALENDAR_PROVIDER=mock
DYNAMIC_UNIVERSE_MAX_ACTIVE=4
DYNAMIC_UNIVERSE_MAX_WATCHLIST=4
DYNAMIC_UNIVERSE_MACRO_MAX_BOOST=0.25
```

Then use `POST /api/universe/macro/run` and inspect `macroContext` + `scores` before relying on autonomous scan breadth.
