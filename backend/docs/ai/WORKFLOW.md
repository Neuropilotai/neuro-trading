# GPT ↔ Cursor Workflow (Required)

## Roles
- Custom GPT: Architecture + diagnosis + Cursor Mega-Prompts
- Cursor Agent: executes changes inside repo
- David: approves direction and runs deploy

## Standard Loop
1) David posts issue details to GPT:
   - what you clicked
   - error message + stack trace
   - endpoint + status code
   - environment (local/railway)
2) GPT returns:
   - diagnosis steps
   - minimal fix plan
   - CURSOR MEGA-PROMPT
3) David pastes the mega-prompt into Cursor Agent
4) Cursor Agent:
   - reproduces issue
   - implements minimal fix
   - runs verification commands
   - reports changed files
5) David pastes results back into GPT for review/next step

## Exit Criteria
- issue is reproducibly fixed
- no new errors in logs
- deploy remains safe on Railway
