# SECURITY_PUBLIC_RELEASE — NeuroPilot Trading (Public)

## Goal
This repository is a PUBLIC template / demo. It must NEVER contain the real trading engine.

## Never publish (forbidden)
- Real BUY/SELL decision logic (signals, thresholds, pattern scoring)
- Real risk rules tied to execution (limits, stops logic, position sizing formulas)
- Real broker execution wiring (OANDA/IBKR live execution paths)
- Secrets/tokens/keys/private URLs/HMAC material
- Internal file paths, ledger locations, database files
- Tuned “learning” parameters that replicate real behavior
- Any code that can auto-trade end-to-end

## Allowed (safe)
- Express server skeleton
- /health endpoint
- /webhook endpoint validating payload shape + demo response only
- Docs with placeholders ("YOUR_SECRET_HERE")
- Mock paper broker with no real execution
- Screenshots with sensitive info blurred

## Before every push
- Search for: secret, api_key, token, password, webhookt
- Ensure examples use placeholders only
