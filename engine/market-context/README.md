# Market context (P1 stub)

## Enable

`EVOLUTION_MARKET_CONTEXT_ENABLE=1` — otherwise `loadMarketContext()` returns **`null`** (no file read).

## File resolution

1. `MARKET_CONTEXT_PATH` (absolute or cwd-relative)
2. Else `$NEUROPILOT_DATA_ROOT/market_context.json` (or `dataRoot.getDataRoot()/market_context.json` when passed `dataRoot` module)

## JSON shape

Preferred:

```json
{
  "regime": "volatile_bull",
  "volatilityScore": 0.78,
  "trendStrength": 0.64
}
```

`marketRegime` is accepted as alias for `regime` in `schema.normalizeMarketContext`.

## Modules

| File | Role |
|------|------|
| `schema.js` | Normalize raw JSON |
| `providers/staticJson.js` | Read file → object or `null` |
| `loadMarketContext.js` | Env gate + path resolution |

No network I/O.
