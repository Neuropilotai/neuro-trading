# Cursor Mega-Prompt Template (Copy/Paste)

You are an implementation engineer working in an enterprise multi-tenant inventory system.

Read: /docs/ai/CONTEXT.md and follow it strictly.

GOAL:
<state the bug/feature>

CONSTRAINTS:
- Minimal fix only
- No refactor unless necessary
- Keep route compatibility with existing UI
- Keep tenant isolation intact

REPRODUCE:
1) Identify where the issue occurs (UI page + action).
2) Identify the failing request (endpoint, method, status, response).
3) Show reproduction using curl (if backend).

DIAGNOSE:
4) Locate the responsible code path (route → middleware → controller/service → db).
5) Identify root cause and confirm with evidence (logs, code).

FIX:
6) Implement smallest safe change.
7) Ensure tenant scoping is respected.
8) Add or update a test if feasible.

VERIFY:
9) Run verification commands and show output:
   - tests
   - curl to the endpoint
   - any build step relevant to Railway

DELIVERABLES:
- Summary of what changed and why
- List of changed files
- Exact commands run
- Any follow-ups or risks
