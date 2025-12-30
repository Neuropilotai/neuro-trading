# NeuroPilot.ai Enterprise Inventory
## Platform Capability Review
**Date:** December 2024  
**Audience:** VP/Investor/Strategic Partner  
**Version:** 1.0

---

## 1. ONE-PAGE EXECUTIVE SUMMARY

### What It Does Today (Production)

- **✅ Automated PDF Invoice Processing:** Ingests multi-invoice PDF packets from Google Drive or direct upload, automatically splits them into individual invoices, extracts line items, and stores structured data with full document traceability.

- **✅ Intelligent Price Bank:** Maintains a searchable database of supplier item prices with history tracking, latest price lookups, and automatic price updates from invoice imports—enabling instant "what did we pay last time?" queries.

- **✅ Human-in-the-Loop Review Queue:** Flags unknown/unmapped line items for staff review, learns from resolutions to improve future matching, and maintains an audit trail of all manual corrections—no silent failures.

- **✅ Multi-Tenant Document Vault:** Secure, org-scoped document storage with preview capabilities, linking invoices to line items, and "open last invoice" functionality that returns the source PDF for any item.

- **✅ Sysco Import Pipeline:** Production-ready automated import from Google Drive inbox folder, with job tracking, idempotency (no duplicate imports), error handling, and structured logging for operations teams.

### What Makes It Unique

- **🔗 Invoice-to-Inventory Traceability:** Unlike AP automation tools that stop at header totals, NeuroPilot links every line item to source PDFs, enabling "show me the invoice for this item" queries and full audit trails from number → document.

- **🤖 Learning from Human Corrections:** The unknown items queue doesn't just flag problems—it learns from staff resolutions, improving matching accuracy over time without requiring engineering changes or retraining models.

- **📊 Price Intelligence + Menu Costing Integration:** Combines vendor price history with recipe costing and menu planning, enabling "what will this menu cost next month?" projections that account for actual supplier pricing trends.

### Where It Goes Next (Roadmap)

- **🔵 Menu + Recipe Costing Engine:** 4-week menu planning with automatic recipe cost rollups using latest vendor prices, theoretical vs. actual cost variance tracking, and substitution impact analysis.

- **🔵 FIFO Cost Layers + COGS Traceability:** Multi-layer inventory costing that traces each cost layer back to source invoices, enabling accurate COGS reporting and "which invoice batch is this item from?" queries.

- **🔵 Predictive Purchasing + Finance Close Support:** 4-week demand forecasting driven by menu plans, automated purchasing suggestions with vendor lead times, and finance period close checklists with exception reporting.

### What Success Looks Like in 90 Days

- **Staff Independence:** Operations and finance teams can process invoices, resolve unknown items, and query price history without engineering support—reducing invoice processing time from hours to minutes.

- **Audit Readiness:** Every number in the system can be traced to a source document (PDF) with timestamps and user actions logged—enabling instant responses to "where did this cost come from?" audit questions.

- **Cost Visibility:** Menu costing shows projected costs 4 weeks ahead using actual vendor pricing, and purchasing suggestions reduce overstock while preventing stockouts—enabling data-driven inventory decisions.

---

## 2. PLATFORM CAPABILITY MAP

| Capability Area | What Users Do | Status | Inputs | Outputs | Audit/Trace | Owner |
|----------------|---------------|--------|---------|---------|-------------|-------|
| **PDF Inbox + Document Vault** | Upload PDFs via UI or Google Drive sync; preview documents; search by invoice number/date | ✅ Production | PDF files (upload/Drive), metadata | Document records, file_path, preview URLs | Document ID, upload timestamp, user ID | Ops + Finance |
| **Invoice Parsing + Split Packets** | System automatically splits multi-invoice PDFs into child documents; detects cover pages; flags scanned PDFs for OCR | ✅ Production | Multi-invoice PDF packets | Child document records, page ranges, invoice numbers per split | Parent/child document links, split job ID, confidence scores | Ops (automated) |
| **Item Price Bank (latest, history, open invoice)** | Search by vendor SKU; view latest price + price history; click "open last invoice" to view source PDF | ✅ Production | Invoice line items, vendor SKUs | Latest price, price history table, source PDF link | Price record ID, invoice ID, document ID, update timestamp | Finance + Ops |
| **Unknown Items Review Queue (resolve + learn)** | Staff reviews flagged unmapped line items; maps vendor SKU → inventory item; system learns mapping for future imports | ✅ Production | Unmapped line items from imports | Resolved mappings, improved matching accuracy | Resolution timestamp, user ID, mapping rule created | Ops (human-in-the-loop) |
| **Inventory Item Master + Locations** | Create/edit inventory items; assign locations; link vendor SKUs to items | 🟡 Beta/In-flight | Item names, codes, locations, vendor mappings | Item master records, location assignments | Item ID, created/updated timestamps, user ID | Ops |
| **Inventory Counts (cycle counts, receiving checks)** | Record physical counts; reconcile against system; flag discrepancies | 🔵 Planned | Physical count data, location, item | Count records, variance reports, adjustment records | Count ID, timestamp, user ID, variance amount | Ops |
| **FIFO Cost Layers + COGS Trace** | System creates cost layers from invoices; traces items to source invoice batches; calculates COGS per layer | 🔵 Planned | Invoice line items, receiving dates, quantities | FIFO layers, COGS calculations, invoice trace links | Layer ID, source invoice ID, document ID, calculation timestamp | Finance + Ops |
| **Menu + Recipe Costing** | Create recipes with ingredients; system calculates cost using latest vendor prices; track theoretical vs. actual | 🔵 Planned | Recipe definitions, ingredient quantities, vendor prices | Recipe cost rollups, cost per serving, variance reports | Recipe ID, calculation timestamp, price source invoice IDs | Ops + Finance |
| **4-week Menu Planning + Purchasing** | Plan 4-week menu; system projects purchasing needs + costs; generates purchase suggestions | 🔵 Planned | Menu plans, recipes, vendor lead times, current inventory | 4-week purchasing plan, cost projections, reorder suggestions | Plan ID, projection timestamp, assumptions logged | Ops |
| **Price Anomalies + Vendor Drift** | System flags price changes > threshold; alerts on vendor format changes; tracks price trends | 🟡 Beta/In-flight | Price history, invoice imports | Anomaly flags, price delta reports, trend charts | Anomaly ID, flagged price ID, comparison invoice IDs | Finance (automated alerts) |
| **Finance Close Support (period packs, accrual hints)** | Generate period summaries; list missing invoices; flag exceptions; export accrual data | 🔵 Planned | Invoice data, period dates, exception rules | Period close packs, exception lists, accrual exports | Period ID, generated timestamp, exception details | Finance |
| **Forecasting (demand, purchasing, cost projection)** | System forecasts demand from menu plans; suggests reorder quantities; projects costs 4 weeks ahead | 🔵 Planned | Historical usage, menu plans, vendor lead times, current inventory | Demand forecasts, purchasing suggestions, cost projections | Forecast ID, assumptions, projection timestamp | Ops + Finance |

---

## 3. AI AGENT CAPABILITIES

### Agent Model Overview

NeuroPilot uses **workflow-based AI agents** (not autonomous LLMs) that follow deterministic rules with human approval gates. Each agent reads structured data, applies business logic, and creates reviewable tasks—never making silent destructive changes.

**Core Principles:**
- **Always Traceable:** Every agent action creates an audit log entry
- **Human Approval Gates:** Critical actions (mappings, adjustments, purchases) require staff confirmation
- **Learning from Corrections:** Agents improve by observing human resolutions
- **Guardrails:** No agent can delete data, modify historical records, or bypass approval workflows

---

### Agent 1: Invoice Intake Agent

**Goal:** Automatically split PDF packets into invoices, classify document types, and route to appropriate parsers.

**Inputs:**
- PDF files (uploaded or from Google Drive)
- Document metadata (filename, upload date, source folder)

**Actions:**
- Extracts text per page using `pdf-parse`
- Classifies pages as: `INVOICE`, `REPORT`, `COVER_PAGE`, `OCR_REQUIRED`
- Groups consecutive pages by invoice number/vendor
- Creates child document records with page ranges
- Routes to vendor-specific parsers (Sysco, GFS, etc.)

**Human Approval Points:**
- None (fully automated classification)
- Staff can manually reclassify if agent misidentifies

**Safety Guardrails:**
- Scanned PDFs (< 50 chars text) flagged as `OCR_REQUIRED` (not processed)
- Low confidence classifications logged for review
- Original PDF preserved; only metadata created

**Status:** ✅ Production

---

### Agent 2: Item Matching Agent

**Goal:** Map vendor SKUs from invoice line items to inventory items in the master database.

**Inputs:**
- Invoice line items (vendor SKU, description, price)
- Inventory item master (item codes, vendor mappings)
- Historical resolution patterns (learned from past resolves)

**Actions:**
- Attempts exact match: vendor SKU → inventory item code
- Attempts fuzzy match: description similarity + price range
- Checks learned mappings from past resolutions
- Creates "unknown item" tasks for unmapped line items
- Updates matching rules when staff resolves unknowns

**Human Approval Points:**
- **All unknown items** require staff mapping before invoice can be marked "complete"
- Fuzzy matches with confidence < 0.8 require confirmation
- New vendor SKUs always create unknown item tasks

**Safety Guardrails:**
- Never auto-creates inventory items (only flags for review)
- Matching rules are versioned and auditable
- Low-confidence matches are flagged, not silently applied

**Status:** ✅ Production (unknown queue + resolve endpoint)

---

### Agent 3: Price Intelligence Agent

**Goal:** Track vendor price changes, flag anomalies, and maintain price history for cost analysis.

**Inputs:**
- Invoice line items (vendor SKU, unit price, invoice date)
- Existing price history from `supplier_item_prices` table
- Price change thresholds (configurable per vendor)

**Actions:**
- Calculates price delta vs. last known price
- Flags anomalies (> 20% increase, > 50% decrease, or configurable threshold)
- Updates latest price in price bank
- Creates price history records with source invoice ID
- Generates price trend reports (weekly/monthly averages)

**Human Approval Points:**
- Anomaly flags create review tasks (staff confirms if legitimate or error)
- Price updates are automatic but logged (no approval needed for normal updates)

**Safety Guardrails:**
- Price history is append-only (never modifies historical records)
- Anomaly thresholds are configurable per vendor (no hard-coded rules)
- Source invoice ID always stored (full traceability)

**Status:** 🟡 Beta/In-flight (price bank exists; anomaly detection in progress)

---

### Agent 4: Receiving/Count Reconciliation Agent

**Goal:** Compare physical counts to expected inventory, flag shrink/discrepancies, and suggest adjustments.

**Inputs:**
- Physical count records (item, location, quantity, count date)
- Expected inventory (last purchase quantity, last count, adjustments)
- Invoice receiving data (what was ordered vs. what was received)

**Actions:**
- Calculates variance: `physical_count - expected_count`
- Flags significant variances (> 5% or configurable threshold)
- Suggests inventory adjustments (with approval required)
- Tracks shrink trends per item/location
- Links discrepancies to source invoices when applicable

**Human Approval Points:**
- **All inventory adjustments** require staff approval (no auto-adjustments)
- Variance flags create review tasks (staff investigates root cause)
- Shrink alerts sent to operations manager

**Safety Guardrails:**
- Adjustment suggestions are logged but not applied automatically
- Historical counts are immutable (only new counts can be recorded)
- Variance calculations are deterministic and auditable

**Status:** 🔵 Planned (Q1 2025)

---

### Agent 5: Menu Costing Agent

**Goal:** Calculate recipe costs using latest vendor prices, track theoretical vs. actual, and project menu costs.

**Inputs:**
- Recipe definitions (ingredients, quantities per serving)
- Latest vendor prices from price bank
- Historical recipe costs (theoretical vs. actual from past periods)
- Menu plans (which recipes served when)

**Actions:**
- Rolls up recipe costs: `sum(ingredient_quantity × latest_price)`
- Calculates cost per serving
- Tracks variance: `actual_cost - theoretical_cost`
- Projects 4-week menu costs using current prices
- Flags recipes with significant cost increases (> 10% vs. last period)

**Human Approval Points:**
- Cost projections are informational (no approval needed)
- Significant cost increases create alerts (staff reviews pricing/substitutions)
- Recipe cost updates are automatic when prices change

**Safety Guardrails:**
- Recipe definitions are versioned (cost calculations reference specific recipe version)
- Price sources are logged (which invoice/date used for each ingredient)
- Theoretical vs. actual variance is tracked but doesn't auto-modify recipes

**Status:** 🔵 Planned (Q1 2025)

---

### Agent 6: Purchasing Forecast Agent

**Goal:** Generate 4-week purchasing suggestions based on menu plans, current inventory, and vendor lead times.

**Inputs:**
- 4-week menu plan (recipes, quantities, dates)
- Current inventory levels (by item, by location)
- Vendor lead times (days from order to delivery)
- Historical usage patterns (optional, for demand smoothing)

**Actions:**
- Calculates required quantities: `menu_plan_quantity - current_inventory - safety_stock`
- Accounts for vendor lead times (orders must be placed X days before needed)
- Generates purchase suggestions grouped by vendor
- Projects total cost using latest prices
- Flags items with insufficient inventory for menu plan

**Human Approval Points:**
- **All purchase suggestions** require staff approval (no auto-ordering)
- Low inventory alerts are informational (staff decides action)
- Forecast assumptions are logged (menu plan version, inventory snapshot date)

**Safety Guardrails:**
- Forecasts are projections only (not commitments)
- Purchase suggestions are grouped by vendor but not auto-submitted
- Lead time assumptions are configurable per vendor (no hard-coded values)

**Status:** 🔵 Planned (Q2 2025)

---

### Agent 7: Finance Close Assistant

**Goal:** Support period-end close with completeness checks, exception reporting, and accrual data exports.

**Inputs:**
- Invoice data (by period, by vendor, by status)
- Document records (linked invoices, missing invoices)
- Exception flags (unmapped items, price anomalies, parsing failures)
- Period dates (start/end of accounting period)

**Actions:**
- Generates period summaries: total invoices, total value, by vendor breakdown
- Lists missing invoices (expected but not received, based on historical patterns)
- Flags exceptions: unmapped items, parsing failures, price anomalies
- Exports accrual data (invoices received but not yet paid)
- Creates close checklist (all exceptions resolved, all invoices processed)

**Human Approval Points:**
- Close checklist requires finance manager sign-off (all exceptions reviewed)
- Missing invoice alerts are informational (staff investigates)
- Accrual exports are generated but not auto-posted to accounting system

**Safety Guardrails:**
- Period summaries are read-only reports (no data modifications)
- Exception lists are append-only (resolved exceptions are logged, not deleted)
- Accrual calculations are deterministic and auditable

**Status:** 🔵 Planned (Q2 2025)

---

## 4. WHAT WE DO THAT OTHERS DON'T (Competitive Differentiation)

### 1. **Invoice-to-Inventory Traceability**
**Typical AP automation:** Extracts invoice header totals (vendor, date, amount) but stops there. Line items are stored as text blobs with no link to inventory items or source PDFs.

**NeuroPilot:** Every line item links to source PDF, inventory item (when mapped), and price history. Staff can click "open last invoice" from any item to see the exact PDF page where it appeared. **Example:** Finance asks "why did chicken cost $5.20/lb last month?" → Ops clicks item → sees invoice PDF → traces to Sysco invoice #3312345678, page 3.

**Status:** ✅ Production

---

### 2. **Learning from Human Corrections**
**Typical inventory apps:** Unknown items require manual mapping every time. No learning or pattern recognition.

**NeuroPilot:** When staff resolves an unknown item (maps vendor SKU → inventory item), the system creates a matching rule. Future imports automatically apply the rule, reducing review queue size over time. **Example:** First time "0475960" appears → unknown queue. Staff maps to "Okra Whole, 250g". Next 10 invoices with "0475960" → auto-matched, no review needed.

**Status:** ✅ Production

---

### 3. **Multi-Invoice PDF Packet Splitting**
**Typical AP tools:** Require one PDF per invoice. Staff must manually split multi-invoice packets before upload.

**NeuroPilot:** Automatically detects and splits multi-invoice PDFs into child documents, groups pages by invoice number, and routes each to appropriate parsers. Cover pages and reports are classified separately. **Example:** Finance uploads "December 2024 Invoices.pdf" (15 invoices, 45 pages) → System creates 15 child documents, parses each independently, flags 2 unknown items total.

**Status:** ✅ Production

---

### 4. **Price Bank with Source Document Links**
**Typical inventory apps:** Track current prices but don't link to source invoices or show price history.

**NeuroPilot:** Price bank stores latest price, full history, and source invoice ID for every price update. Staff can see "we paid $X on invoice Y, dated Z" and click to open the PDF. **Example:** Ops searches "chicken breast" → sees latest price $4.95/lb (from invoice #3312345678, 2024-12-15) → clicks invoice → opens PDF page 2.

**Status:** ✅ Production

---

### 5. **Vendor-Specific Parsing with Format Learning**
**Typical AP automation:** Generic regex patterns that break when vendors change formats.

**NeuroPilot:** Vendor-specific parsers (Sysco, GFS, etc.) with format detection. When parsing fails, system flags for review and learns from corrections. **Example:** Sysco changes invoice format (new date format "2024 01 05" instead of "01/05/2024") → Parser detects new pattern → Adds to pattern library → Future invoices auto-parse.

**Status:** ✅ Production (Sysco parser); 🟡 Beta (format learning)

---

### 6. **Scanned PDF Detection + OCR Queue**
**Typical tools:** Attempt to parse scanned PDFs, fail silently, or require manual OCR setup.

**NeuroPilot:** Detects scanned PDFs (< 50 chars extracted text) and flags as `OCR_REQUIRED`. Staff can route to OCR service (optional) or manually enter data. System never processes scanned PDFs as text-based (prevents garbage data). **Example:** Upload "scanned_invoice.pdf" → System extracts 12 chars → Flags `OCR_REQUIRED` → Staff reviews → Routes to OCR or manual entry.

**Status:** ✅ Production (detection); 🔵 Planned (OCR integration)

---

### 7. **Menu Costing with Live Vendor Prices**
**Typical menu planning tools:** Use static recipe costs or require manual price updates.

**NeuroPilot:** Recipe costing engine pulls latest vendor prices automatically. When prices change, recipe costs update in real-time. Staff can see "this menu will cost $X next week" using current prices. **Example:** Recipe "Chicken Caesar Salad" uses chicken ($4.95/lb), lettuce ($2.10/head) → System calculates $3.25 per serving → Price increases → Recipe cost updates to $3.45 automatically.

**Status:** 🔵 Planned (Q1 2025)

---

### 8. **FIFO Cost Layers with Invoice Traceability**
**Typical inventory apps:** Track quantities but not cost layers or COGS traceability.

**NeuroPilot:** Creates FIFO cost layers from invoices, traces each layer to source invoice batch, and calculates COGS per layer. Finance can see "this item came from invoice #X, cost $Y, on date Z". **Example:** Item "Chicken Breast" has 3 layers: Layer 1 (100 units, $4.50, invoice #3312345678), Layer 2 (50 units, $4.95, invoice #3312345689) → COGS uses Layer 1 first → Links to source PDFs.

**Status:** 🔵 Planned (Q1 2025)

---

### 9. **4-Week Purchasing Forecasts Driven by Menu Plans**
**Typical forecasting tools:** Use historical demand only, ignore menu plans.

**NeuroPilot:** Forecasts purchasing needs from 4-week menu plans, accounts for vendor lead times, and projects costs using latest prices. **Example:** Menu plan shows "Chicken Caesar Salad" served 200x in Week 3 → System calculates: need 50 lbs chicken, order by Week 1 (2-week lead time) → Projects cost $247.50 using current price.

**Status:** 🔵 Planned (Q2 2025)

---

### 10. **Human-in-the-Loop Review Queue (No Silent Failures)**
**Typical AP automation:** Fails silently on parsing errors or unknown items. Staff discovers issues during reconciliation.

**NeuroPilot:** All parsing failures and unknown items create review tasks. Staff resolves in UI, system learns from corrections. Nothing is processed without human confirmation of critical mappings. **Example:** Invoice has unmapped item "NEW-SKU-123" → Creates review task → Staff maps to "New Product X" → System learns mapping → Future imports auto-match.

**Status:** ✅ Production

---

### 11. **Multi-Tenant Document Vault with Org Scoping**
**Typical tools:** Single-tenant or require separate instances per organization.

**NeuroPilot:** All queries are org-scoped (`org_id` in every query). Documents, invoices, and items are isolated by organization. Same codebase serves multiple clients securely. **Example:** Org A and Org B both use system → Org A's invoices invisible to Org B → Org A's staff can only see Org A's data → Full tenant isolation.

**Status:** ✅ Production

---

### 12. **Finance Close Support with Exception Reporting**
**Typical ERP modules:** Require manual period-end reconciliation, no exception lists.

**NeuroPilot:** Generates period close packs (invoice summaries, exception lists, accrual data) and flags missing invoices based on historical patterns. **Example:** Finance runs "December 2024 Close Pack" → System lists: 45 invoices processed, 2 exceptions (unmapped items), 1 missing invoice (Sysco usually sends invoice by 5th, today is 8th) → Finance reviews exceptions → Closes period.

**Status:** 🔵 Planned (Q2 2025)

---

## 5. DEMO STORYBOARD (10-12 Minutes)

### Scene 1: Upload Multi-Invoice PDF Packet (2 minutes)

**Action:** Staff uploads "December 2024 Invoices.pdf" via owner console UI.

**What Happens:**
- System receives PDF, creates parent document record
- Invoice Intake Agent extracts text per page
- Detects 3 invoices in packet (pages 1-5, 6-10, 11-15)
- Creates 3 child document records with page ranges
- Routes each to Sysco parser

**What User Sees:**
- Upload progress bar
- Success message: "3 invoices detected and split"
- Document list shows parent + 3 children
- Each child shows invoice number, date, vendor

**Key Point:** No manual splitting required. System handles multi-invoice packets automatically.

---

### Scene 2: Parse Invoice Lines + Show Unknown Item (2 minutes)

**Action:** System parses first invoice (Sysco invoice #3312345678).

**What Happens:**
- Sysco parser extracts 45 line items
- Item Matching Agent attempts to map each vendor SKU → inventory item
- 44 items match (existing mappings)
- 1 item unmapped: "NEW-SKU-789" (new product)

**What User Sees:**
- Invoice detail view shows 45 line items
- 44 items show green checkmark (mapped)
- 1 item shows red flag (unknown)
- Unknown item shows: vendor SKU "NEW-SKU-789", description "New Product Y", price $12.50

**Key Point:** System flags unknowns immediately, doesn't fail silently.

---

### Scene 3: Resolve Unknown Item + Show Learning (2 minutes)

**Action:** Staff clicks "Resolve" on unknown item, maps to inventory item "New Product Y".

**What Happens:**
- Staff selects inventory item from dropdown (or creates new)
- System creates mapping rule: "NEW-SKU-789" → "New Product Y"
- Invoice marked "complete"
- Mapping rule saved for future imports

**What User Sees:**
- Resolution dialog: "Map vendor SKU to inventory item"
- Staff selects "New Product Y" from list
- Success message: "Mapping saved. Future imports will auto-match this SKU."
- Invoice status changes to "Complete"

**Key Point:** System learns from resolutions. Next invoice with "NEW-SKU-789" will auto-match.

---

### Scene 4: Search Item Code → Latest Price + Open Invoice (2 minutes)

**Action:** Staff searches "chicken breast" in price bank.

**What Happens:**
- Price Intelligence Agent looks up latest price
- Finds: $4.95/lb (from invoice #3312345678, 2024-12-15)
- Calculates price delta: +$0.25 vs. previous ($4.70)
- Retrieves source document ID

**What User Sees:**
- Search results: "Chicken Breast, Boneless"
- Latest price: $4.95/lb (updated 2024-12-15)
- Price delta: +$0.25 (+5.3% increase)
- "Open Last Invoice" button

**Action:** Staff clicks "Open Last Invoice".

**What User Sees:**
- PDF viewer opens
- Shows Sysco invoice #3312345678, page 2
- Line item highlighted: "Chicken Breast, Boneless, $4.95/lb"

**Key Point:** Full traceability from price → invoice PDF in one click.

---

### Scene 5: Show FIFO Layer Trace (1.5 minutes)

**Action:** Staff views inventory item "Chicken Breast" → "Cost Layers" tab.

**What Happens:**
- System shows FIFO layers (oldest first)
- Each layer shows: quantity, cost, source invoice ID, date received

**What User Sees:**
- Layer 1: 100 units, $4.50/lb, invoice #3312345678, 2024-12-01
- Layer 2: 50 units, $4.95/lb, invoice #3312345689, 2024-12-15
- Total: 150 units, weighted avg $4.65/lb
- Each layer has "View Invoice" link

**Action:** Staff clicks "View Invoice" on Layer 1.

**What User Sees:**
- PDF opens: Sysco invoice #3312345678, page 2
- Line item highlighted

**Key Point:** COGS traceability: every cost layer links to source invoice.

---

### Scene 6: Show 4-Week Menu Plan + Cost Projection (2 minutes)

**Action:** Staff views "4-Week Menu Plan" → "Week 3" → "Cost Projection".

**What Happens:**
- Menu Costing Agent calculates recipe costs using latest vendor prices
- Projects total cost for Week 3 menu
- Shows cost breakdown by recipe

**What User Sees:**
- Week 3 menu: 5 recipes, 200 servings total
- Projected cost: $1,247.50
- Breakdown:
  - Chicken Caesar Salad: $650.00 (200 servings × $3.25)
  - Beef Stew: $450.00 (150 servings × $3.00)
  - etc.
- Each recipe shows "View Cost Details" (ingredient breakdown)

**Action:** Staff clicks "View Cost Details" on "Chicken Caesar Salad".

**What User Sees:**
- Ingredients list with latest prices:
  - Chicken: $4.95/lb (from invoice #3312345678)
  - Lettuce: $2.10/head (from invoice #3312345690)
  - etc.
- Cost per serving: $3.25
- "Price updated 2024-12-15" (when last price changed)

**Key Point:** Menu costing uses live vendor prices, updates automatically.

---

### Scene 7: Show Finance Close Pack (1.5 minutes)

**Action:** Finance manager runs "December 2024 Close Pack".

**What Happens:**
- Finance Close Assistant generates period summary
- Lists all invoices processed (45 total)
- Flags exceptions (2 unmapped items, 1 price anomaly)
- Lists missing invoices (1 expected but not received)

**What User Sees:**
- Period summary:
  - Total invoices: 45
  - Total value: $125,450.00
  - By vendor: Sysco ($95,200), GFS ($30,250)
- Exceptions:
  - 2 unmapped items (resolved)
  - 1 price anomaly (chicken +$0.25, confirmed legitimate)
- Missing invoices:
  - Sysco invoice expected by 2024-12-05 (today is 2024-12-08)
- "Close Period" button (disabled until all exceptions reviewed)

**Key Point:** Finance close support with exception reporting and completeness checks.

---

## 6. ROADMAP: 30 / 60 / 90 DAYS

### 30-DAY DELIVERABLES

**Focus:** Reliability + OCR Foundation

**Deliverables:**
1. **Robust Invoice → Document Linking**
   - Fix edge cases where invoice records don't link to document records
   - Add validation: every invoice must have a document ID
   - Add "repair links" utility for existing data

2. **OCR Integration (Optional)**
   - Add OCR service integration (Google Cloud Vision or AWS Textract)
   - Route `OCR_REQUIRED` flagged PDFs to OCR queue
   - Store OCR text in `documents.raw_text` column
   - Re-run parsers on OCR text

3. **Price Bank Enhancements**
   - Add price history charts (line graphs per item)
   - Add price delta alerts (email/Slack when > 10% change)
   - Add bulk price export (CSV for finance analysis)

**Risks:**
- OCR costs: ~$1.50 per 1000 pages (Google Cloud Vision). Mitigation: Make OCR optional, only for scanned PDFs.
- Invoice linking: Some legacy data may have broken links. Mitigation: Repair utility runs on-demand, doesn't block new imports.

**Acceptance Tests:**
- Upload scanned PDF → System flags `OCR_REQUIRED` → Staff routes to OCR → OCR text extracted → Parser runs successfully
- All new invoices have valid `document_id` links
- Price history charts render correctly for items with 10+ price updates

---

### 60-DAY DELIVERABLES

**Focus:** Menu + Recipe Costing Integration

**Deliverables:**
1. **Recipe Costing Engine**
   - Create `recipes` table (recipe name, servings, ingredients with quantities)
   - Create `recipe_ingredients` table (recipe_id, inventory_item_id, quantity_per_serving)
   - Calculate recipe cost: `sum(ingredient_quantity × latest_vendor_price)`
   - Store calculated cost in `recipes.cost_per_serving`

2. **Menu Planning UI**
   - Create `menu_plans` table (plan name, week, recipes, quantities)
   - UI to create/edit 4-week menu plans
   - Show projected cost per week using recipe costs
   - Track theoretical vs. actual cost variance

3. **Price Bank → Recipe Integration**
   - Recipe costing pulls latest prices from `supplier_item_prices`
   - When prices update, recipe costs recalculate automatically
   - Show price source (which invoice, which date) per ingredient

**Risks:**
- Recipe complexity: Some recipes have 20+ ingredients. Mitigation: Lazy-load ingredient prices, cache recipe costs.
- Price updates: Frequent price changes could cause recipe cost churn. Mitigation: Recipe costs update on-demand (not real-time), show "last updated" timestamp.

**Acceptance Tests:**
- Create recipe "Chicken Caesar Salad" with 5 ingredients → System calculates $3.25 per serving using latest prices → Update chicken price → Recipe cost updates to $3.45
- Create 4-week menu plan → System projects total cost $5,200 using recipe costs → Staff views cost breakdown per week

---

### 90-DAY DELIVERABLES

**Focus:** FIFO + COGS Reporting + Forecasting MVP

**Deliverables:**
1. **FIFO Cost Layers**
   - Create `inventory_cost_layers` table (item_id, quantity, cost_per_unit, source_invoice_id, received_date)
   - Create layers from invoice line items on import
   - Implement FIFO logic: oldest layer consumed first
   - Calculate weighted average cost per item

2. **COGS Reporting**
   - Create `cogs_report` view (item, quantity_sold, cost_per_unit, total_cogs, source_invoice_ids)
   - Link COGS to source invoices (full traceability)
   - Export COGS data for finance period close

3. **Forecasting MVP**
   - Create `purchasing_forecasts` table (forecast_date, item_id, suggested_quantity, projected_cost)
   - Generate forecasts from 4-week menu plans
   - Account for vendor lead times (order X days before needed)
   - Show purchasing suggestions grouped by vendor

4. **Finance Close MVP**
   - Create `period_close_packs` table (period_id, summary_json, exceptions_json, generated_at)
   - Generate period summaries (total invoices, by vendor, exceptions)
   - Flag missing invoices (expected but not received)
   - Export accrual data (invoices received but not paid)

**Risks:**
- FIFO complexity: Multi-location inventory requires location-specific layers. Mitigation: Start with single-location, add multi-location in v2.
- Forecasting accuracy: Menu plans may change, causing forecast drift. Mitigation: Forecasts are suggestions only, staff can adjust, show "last updated" timestamp.

**Acceptance Tests:**
- Import invoice with 100 units chicken @ $4.50 → System creates FIFO layer → Sell 50 units → COGS = $225 (50 × $4.50) → Layer reduced to 50 units
- Create 4-week menu plan → System generates purchasing forecast → Shows "order 50 lbs chicken by Week 1 (2-week lead time)" → Projects cost $247.50
- Run "December 2024 Close Pack" → System generates summary → Lists 45 invoices, 2 exceptions, 1 missing invoice → Finance reviews → Closes period

---

## 7. "RENT VS SELL" PACKAGING

### SaaS Subscription (Rent)

**Who Uses It:**
- Multi-unit restaurant groups (5-50 locations)
- Food service operations with centralized finance/ops teams
- Organizations that want zero infrastructure management

**Onboarding Steps:**
1. **Account Creation:** Finance/ops manager signs up via web portal
2. **Org Setup:** Configure org name, timezone, fiscal periods
3. **Google Drive Integration:** Connect Google Drive account, specify inbox/processed folders
4. **Vendor Configuration:** Add vendors (Sysco, GFS, etc.), configure parsers
5. **Inventory Item Master:** Import existing item list (CSV) or build manually
6. **Staff Access:** Invite team members, assign roles (ops, finance, admin)
7. **Training:** 2-hour onboarding session (PDF upload, unknown queue, price bank)

**What's Included:**
- Hosted platform (Railway cloud infrastructure)
- Automatic updates (new features, parser improvements)
- Support: Email support (24-48 hour response), documentation portal
- Data retention: Unlimited (all historical data preserved)
- Backup: Daily automated backups, 30-day point-in-time recovery

**Pricing Model:** (Unknown / needs confirmation)
- Per-org monthly subscription
- Tiered by: number of invoices/month, number of locations, number of users

---

### License / Self-Host (Sell)

**Who Uses It:**
- Large enterprises (50+ locations) with IT infrastructure teams
- Organizations with data residency requirements (must host on-premises)
- Franchise operations that want to white-label the platform

**Infrastructure Needed:**
- **Compute:** Node.js 20+ runtime (2 CPU, 4GB RAM minimum per instance)
- **Database:** PostgreSQL 14+ (separate instance, 50GB storage minimum)
- **Storage:** File storage for PDFs (local filesystem or S3-compatible)
- **Optional:** Redis for caching (improves performance for large orgs)

**What Support Includes:**
- **License:** Perpetual license for current version + 1 year of updates
- **Support:** Email support (24-48 hour response), documentation, deployment guides
- **Updates:** 1 year of version updates included, then optional maintenance contract
- **Customization:** Code is open-source (private repo), customer can modify (no warranty on customizations)

**Deployment:**
- **Docker:** Provided Docker Compose setup for local deployment
- **Kubernetes:** Helm charts available for K8s deployments
- **Manual:** Standard Node.js + Postgres deployment (customer manages)

**Data Ownership:**
- Customer owns all data (stored in their infrastructure)
- No data sent to NeuroPilot servers (fully self-contained)
- Customer responsible for backups, security, compliance

---

### Data Ownership + Security Posture

**SaaS (Rent):**
- **Data Storage:** Customer data stored in Railway (PostgreSQL + file storage)
- **Access Control:** Org-scoped queries (`org_id` in every query), staff can only access their org's data
- **Secrets:** Environment variables encrypted at rest, never logged
- **Backups:** Daily automated backups, customer can request export (JSON/CSV)
- **Compliance:** SOC 2 Type II (planned), GDPR-compliant data export on request

**Self-Host (Sell):**
- **Data Storage:** Customer infrastructure (full control)
- **Access Control:** Customer manages (LDAP/SSO integration available)
- **Secrets:** Customer manages (no secrets sent to NeuroPilot)
- **Backups:** Customer responsible (backup scripts provided)
- **Compliance:** Customer's compliance posture applies (HIPAA, PCI-DSS, etc.)

**Least Privilege:**
- **Database:** Application uses least-privilege DB user (read/write to app tables only)
- **File Access:** PDFs stored with org-scoped paths (`org_id/document_id.pdf`)
- **API:** All endpoints require authentication, org_id validated on every request

---

## 8. RISKS + MITIGATIONS

### Risk 1: Parsing Failures

**Description:** Vendor changes invoice format, parser fails to extract line items.

**Mitigation:**
- **Detection:** System flags parsing failures immediately (creates review task)
- **Fallback:** Staff can manually enter line items if parser fails
- **Learning:** When staff corrects parsing errors, system learns new patterns (format learning in beta)
- **Operational Playbook:**
  1. Review task created → Staff reviews failed invoice
  2. If format change detected → Staff notifies engineering (parser update needed)
  3. If one-off error → Staff manually enters line items
  4. System logs all parsing failures for pattern analysis

**Status:** ✅ Production (failure detection); 🟡 Beta (format learning)

---

### Risk 2: Scanned PDFs

**Description:** Many invoices are scanned images, not text-based PDFs. Text extraction fails (< 50 chars).

**Mitigation:**
- **Detection:** System flags scanned PDFs as `OCR_REQUIRED` (doesn't attempt parsing)
- **OCR Integration:** Optional OCR service (Google Cloud Vision) routes scanned PDFs → extracts text → re-runs parser
- **Manual Entry:** Staff can manually enter invoice data if OCR fails or is unavailable
- **Operational Playbook:**
  1. Upload scanned PDF → System flags `OCR_REQUIRED`
  2. Staff reviews → Routes to OCR (if enabled) or manual entry
  3. OCR extracts text → System re-runs parser
  4. If OCR fails → Staff manually enters line items

**Status:** ✅ Production (detection); 🔵 Planned (OCR integration, 30 days)

---

### Risk 3: Vendor Changes Formats

**Description:** Vendor (e.g., Sysco) changes invoice layout, existing parser breaks.

**Mitigation:**
- **Format Learning:** System learns new patterns from staff corrections (beta)
- **Parser Versioning:** Parsers are versioned, can support multiple formats simultaneously
- **Alerting:** System alerts when parsing confidence drops below threshold (indicates format change)
- **Operational Playbook:**
  1. Parsing confidence drops → System alerts operations team
  2. Staff reviews sample invoices → Identifies format change
  3. Engineering updates parser → Adds new format pattern
  4. System supports both old and new formats (backward compatible)

**Status:** 🟡 Beta (format learning); ✅ Production (parser versioning)

---

### Risk 4: Item Master Quality

**Description:** Inventory item master has duplicates, typos, or missing items. Matching fails.

**Mitigation:**
- **Deduplication:** System flags potential duplicates (same name, different codes)
- **Fuzzy Matching:** Item Matching Agent uses fuzzy matching (description similarity) when exact match fails
- **Unknown Queue:** Unmapped items always create review tasks (never silently ignored)
- **Operational Playbook:**
  1. Unknown item appears → Staff reviews
  2. If item exists but name differs → Staff maps to existing item, system learns
  3. If item missing → Staff creates new inventory item
  4. If duplicate detected → Staff merges items, system updates mappings

**Status:** ✅ Production (unknown queue); 🟡 Beta (fuzzy matching)

---

### Risk 5: Multi-Site Complexity

**Description:** Organization has multiple locations, inventory must be tracked per location.

**Mitigation:**
- **Location Scoping:** All inventory queries are location-scoped (`location_id` in queries)
- **FIFO Layers:** Cost layers are location-specific (same item, different locations, different costs)
- **Reporting:** Reports can aggregate across locations or show per-location breakdown
- **Operational Playbook:**
  1. Staff assigns items to locations during receiving
  2. Counts are location-specific (cycle counts per location)
  3. FIFO layers track cost per location
  4. Reports show location breakdown (finance can see total or per-location)

**Status:** 🔵 Planned (Q1 2025 for FIFO); ✅ Production (location scoping in item master)

---

### Risk 6: Adoption Risk

**Description:** Staff don't use the system, continue using spreadsheets or manual processes.

**Mitigation:**
- **Ease of Use:** UI is simple (upload PDF, resolve unknowns, search prices) — no complex workflows
- **Time Savings:** System saves hours per week (no manual data entry, no invoice splitting)
- **Training:** 2-hour onboarding session, documentation portal, video tutorials
- **Operational Playbook:**
  1. Start with one power user (finance or ops manager)
  2. Power user processes invoices, resolves unknowns, uses price bank
  3. Power user trains team (show time savings, show audit trail benefits)
  4. Gradually expand usage (add more staff, add more vendors)

**Status:** ✅ Production (UI, training materials); 🔵 Planned (adoption metrics tracking)

---

## 9. NEXT 3 ACTIONS THIS WEEK

### Action 1: Complete OCR Integration (30-Day Deliverable)
**Owner:** Engineering  
**Tasks:**
- Integrate Google Cloud Vision API for OCR
- Add OCR queue UI (list of `OCR_REQUIRED` documents)
- Add "Route to OCR" button in review queue
- Test with 10 scanned PDFs, verify parsing success rate

**Acceptance:** Staff can route scanned PDFs to OCR, system extracts text, parser runs successfully.

---

### Action 2: Enhance Price Bank UI (30-Day Deliverable)
**Owner:** Engineering  
**Tasks:**
- Add price history charts (line graphs per item, last 12 months)
- Add price delta alerts (email/Slack when > 10% change)
- Add bulk price export (CSV for finance analysis)
- Test with 100 items, verify chart rendering and export accuracy

**Acceptance:** Staff can view price history charts, receive alerts on price changes, export price data to CSV.

---

### Action 3: Design Recipe Costing Schema (60-Day Deliverable Prep)
**Owner:** Product + Engineering  
**Tasks:**
- Design `recipes` and `recipe_ingredients` table schema
- Design recipe costing calculation logic (ingredient quantities × latest prices)
- Design menu planning UI mockups (4-week plan, recipe selection, cost projection)
- Review with ops team, get feedback on workflow

**Acceptance:** Schema designed, calculation logic documented, UI mockups approved by ops team.

---

## APPENDIX: Technical Foundation

**Stack:**
- **Backend:** Node.js 20+ with Express.js
- **Database:** PostgreSQL 14+ (multi-tenant with `org_id` scoping)
- **Hosting:** Railway (SaaS) or self-hosted (Docker/K8s)
- **File Storage:** Local filesystem or S3-compatible (PDFs)
- **PDF Processing:** `pdf-parse` (text extraction), `pdf-lib` (splitting, planned)

**Architecture:**
- **Multi-Tenant:** All queries scoped by `org_id` (tenant isolation)
- **Async Processing:** PDF parsing and splitting run asynchronously (job queue)
- **Idempotency:** Invoice imports are idempotent (no duplicate imports)
- **Audit Trail:** All user actions logged (who, what, when, why)

**Security:**
- **Authentication:** JWT tokens with org_id claims
- **Authorization:** Role-based access control (ops, finance, admin)
- **Data Isolation:** Org-scoped queries prevent cross-tenant data access
- **Secrets:** Environment variables encrypted at rest, never logged

---

**Document Version:** 1.0  
**Last Updated:** December 2024  
**Next Review:** January 2025

