# Generated strategies (Discovery Engine)

**Step 3** of the Discovery Engine now writes to the **data root** (`$NEUROPILOT_DATA_ROOT/generated_strategies` or `./data_workspace/generated_strategies`), not this folder. See `engine/dataRoot.js` and `engine/DATA_ARCHITECTURE.md`.

- Each file `setup_001.js`, `setup_002.js`, … is a candidate strategy derived from a discovered pattern.
- **Step 4** runs backtest on all `setup_*.js` in the data root’s `generated_strategies/`.
- Only setups that pass the decision rule (expectancy > 0, trades ≥ 30, bootstrap risk < 20%) should be promoted into the main strategy set.

To freeze a setup, copy it from the data root to `engine/strategies/` and give it a stable name.

See `engine/DISCOVERY_ENGINE.md` and `engine/DATA_ARCHITECTURE.md`.
