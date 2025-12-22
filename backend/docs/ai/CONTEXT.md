# Enterprise Inventory System Context (Source of Truth)

## What this is
Enterprise-grade multi-tenant inventory system (camp operations + supplier imports).

## Stack
- Backend: Node.js + Express
- DB: PostgreSQL
- Deploy: Railway (Docker or Nixpacks)
- Auth: JWT
- Multi-tenant: tenant resolver + correlation IDs

## Core Modules
- Inventory
- Orders
- Waste
- Finance/Reports
- Supplier Imports (Sysco/GFS)
- PDF ingestion

## Non-negotiables
- Do not break tenant isolation
- Do not rename routes without updating all callers
- Minimize changes (smallest safe fix)
- No broad refactors unless explicitly approved
- All DB schema changes require migrations

## Verification Minimum
- Provide a curl reproduction
- Provide expected status code + minimal JSON shape
- Provide a test command (or explain why none exists)
