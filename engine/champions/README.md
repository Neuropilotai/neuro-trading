# Champion Registry & Filter

- **loadChampionRegistry.js** — Load `champion_registry.json` from `$DATA_ROOT/champion_setups/`.
- **filterChampionSetups.js** — Filter by status: `candidate` | `validated` | `champion`.
- **executionGate.js** — Champion Execution Gate: `isChampionAllowed(setupId)` for the webhook. Only `status === 'champion'` may be traded.

**Règle pratique :**

- `candidate` = idée intéressante  
- `validated` = mérite d'être surveillée  
- `champion` = assez robuste pour exécution  

**Live Bridge :** le webhook appelle la gate après validation ; si `setup_id` (ou `setup_name`) n'est pas dans le registry comme champion → 403. Désactiver avec `ENABLE_CHAMPION_GATE=false`.

```js
const { loadChampionRegistrySync } = require('./engine/champions/loadChampionRegistry');
const { getChampionsOnly, getByStatus } = require('./engine/champions/filterChampionSetups');
const { isChampionAllowed, getChampionAllowlist } = require('./engine/champions/executionGate');

const registry = loadChampionRegistrySync();
const champions = getChampionsOnly(registry);
if (!isChampionAllowed(incomingSetupId)) return rejectSignal();
```
