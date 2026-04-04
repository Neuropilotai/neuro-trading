# Trading Profiles

Ce répertoire contient les profils de configuration pour le système de backtesting.

## Profil Production : XAUUSD-5m-PROD

**STATUS: FROZEN - DO NOT MODIFY**

Ce profil est la baseline de production pour XAUUSD 5m. Il est **figé** et ne doit **jamais** être modifié.

### Résultats de validation (90 jours)
- **Trades**: 21
- **Profit Factor**: 3.71
- **Win Rate**: 71.4%
- **Max Drawdown**: 0.22%
- **Expectancy**: 0.117%
- **RR Relax Applied**: 17 (OB score ≥ 0.75)
- **TP1 Hits**: 14/21
- **OB Avg Score**: 0.871

### Configuration clé

#### OR15 Gate
- Mode: SESSION (14:30 UTC)
- Soft Mode: enabled
- Max OR Low Distance: 80% of range, 0.35 ATR

#### Order Block
- Enabled: true
- Hard Filter: false
- RR Relax: true (threshold: 0.75)
- RR Relax Delta: 0.10

#### Exit Strategy
- TP1: 0.20% (50% position)
- Runner: Trail 0.10 ATR, Lock +0.08%

## Utilisation

### Avec profil
```bash
node cli/backtest_patterns.js --profile XAUUSD-5m-PROD --days 90
```

### Sans profil (paramètres manuels)
```bash
node cli/backtest_patterns.js --symbol XAUUSD --tf 5 --days 90
```

## Règle d'or

**Ce profil ne bouge plus.**

Pour tester de nouvelles configurations :
1. Créer un nouveau profil (ex: `XAUUSD-5m-EXP-OB-HARD.json`)
2. Copier `XAUUSD-5m-PROD.json` comme base
3. Modifier uniquement le nouveau profil
4. Ne jamais toucher `XAUUSD-5m-PROD.json`

## Structure du profil JSON

```json
{
  "name": "Profile-Name",
  "description": "Description",
  "status": "PRODUCTION|EXPERIMENTAL",
  "symbol": "XAUUSD",
  "timeframe": "5",
  "or15": { ... },
  "gate": { ... },
  "orderBlock": { ... },
  "exit": { ... },
  "costs": { ... }
}
```

## Ordre de priorité

1. **Variables d'environnement** (priorité la plus haute)
2. **Arguments CLI** (override profile)
3. **Profil** (baseline)
4. **Defaults** (fallback)

