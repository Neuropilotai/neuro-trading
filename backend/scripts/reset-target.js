#!/usr/bin/env node
/**
 * TARGETED RESET SCRIPT (PostgreSQL)
 *
 * Purpose: Safely reset PDFs and inventory products on Railway (PostgreSQL)
 *
 * What it does:
 * 1. Deletes records from processed_invoices (PDFs displayed in Orders/PDF tab)
 * 2. Deletes records from inventory_products (products in Inventory list)
 * 3. Optionally deletes from inventory_ledger if it exists
 *
 * Safety features:
 * - DRY RUN mode (default): Shows what will be deleted without making changes
 * - EXECUTE mode: Actually performs the deletion
 * - RESET_CONFIRM=YES required for execute mode
 * - Checks if tables exist before querying
 * - Tenant-scoped queries where applicable
 *
 * Usage:
 *   node scripts/reset-target.js --dry-run          # Preview what will be deleted
 *   RESET_CONFIRM=YES node scripts/reset-target.js --execute   # Actually delete
 *
 * Environment variables:
 *   DATABASE_URL       - PostgreSQL connection string (required)
 *   RESET_CONFIRM      - Must be 'YES' to execute
 *   TENANT_ID          - Optional: scope to specific tenant
 */

const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = !args.includes('--execute');
const verbose = args.includes('--verbose') || args.includes('-v');

// Color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logSection(title) {
  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.cyan}${title}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}\n`);
}

// Print environment info
console.log('\x1b[36m── Environment ──\x1b[0m');
console.log(`DATABASE_URL: ${process.env.DATABASE_URL ? '[SET]' : '(not set)'}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || '(not set)'}`);
console.log(`RAILWAY_ENVIRONMENT: ${process.env.RAILWAY_ENVIRONMENT || '(not set)'}`);
console.log(`TENANT_ID: ${process.env.TENANT_ID || '(all tenants)'}`);
console.log('');

// Safety gate: require RESET_CONFIRM=YES for execute mode
const confirmEnv = process.env.RESET_CONFIRM;
if (!isDryRun && confirmEnv !== 'YES') {
  console.error('\x1b[31m❌ Refusing to execute. Set RESET_CONFIRM=YES to proceed.\x1b[0m');
  console.error('   Example: RESET_CONFIRM=YES node scripts/reset-target.js --execute');
  process.exit(2);
}

// Check DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.error('\x1b[31m❌ DATABASE_URL not set. Cannot connect to PostgreSQL.\x1b[0m');
  process.exit(1);
}

/**
 * Check if a table exists in the database
 */
async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT to_regclass('public.${tableName}') as reg`
  );
  return result.rows[0].reg !== null;
}

/**
 * Get count from a table with optional tenant filter
 */
async function getCount(client, tableName, tenantId = null) {
  let sql = `SELECT COUNT(*) as count FROM ${tableName}`;
  const params = [];

  if (tenantId) {
    sql += ` WHERE tenant_id = $1`;
    params.push(tenantId);
  }

  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Get sample records for preview
 */
async function getSamples(client, tableName, columns, limit = 5, tenantId = null) {
  let sql = `SELECT ${columns.join(', ')} FROM ${tableName}`;
  const params = [];

  if (tenantId) {
    sql += ` WHERE tenant_id = $1`;
    params.push(tenantId);
  }

  sql += ` LIMIT ${limit}`;

  try {
    const result = await client.query(sql, params);
    return result.rows;
  } catch (err) {
    return [];
  }
}

/**
 * Delete records from a table with optional tenant filter
 */
async function deleteFromTable(client, tableName, tenantId = null) {
  let sql = `DELETE FROM ${tableName}`;
  const params = [];

  if (tenantId) {
    sql += ` WHERE tenant_id = $1`;
    params.push(tenantId);
  }

  sql += ` RETURNING *`;

  const result = await client.query(sql, params);
  return result.rowCount;
}

/**
 * Main execution
 */
async function main() {
  console.log('\n');
  log('╔══════════════════════════════════════════════════════════╗', 'cyan');
  log('║         TARGETED RESET TOOL (PostgreSQL)                 ║', 'cyan');
  log('║         Enterprise Inventory System                      ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════╝', 'cyan');

  if (isDryRun) {
    log('\n🔍 MODE: DRY RUN (no changes will be made)', 'yellow');
    log('   Run with --execute to perform actual deletion\n', 'yellow');
  } else {
    log('\n⚠️  MODE: EXECUTE (changes will be permanent!)', 'red');
    console.log('');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    log('✓ Connected to PostgreSQL', 'green');

    const tenantId = process.env.TENANT_ID || null;

    // Check which tables exist
    const processedInvoicesExists = await tableExists(client, 'processed_invoices');
    const inventoryProductsExists = await tableExists(client, 'inventory_products');
    const inventoryCountItemsExists = await tableExists(client, 'inventory_count_items');
    const itemMasterExists = await tableExists(client, 'item_master');
    const ledgerExists = await tableExists(client, 'inventory_ledger');

    if (!ledgerExists) {
      log('[WARN] inventory_ledger missing - skipping ledger cleanup (schema does not use ledger)', 'yellow');
    }

    // Get counts
    logSection('CURRENT STATE');

    const counts = {};

    if (processedInvoicesExists) {
      counts.processed_invoices = await getCount(client, 'processed_invoices', tenantId);
      log(`  PDFs (processed_invoices): ${counts.processed_invoices} records`, 'blue');
    } else {
      log('  processed_invoices: table not found', 'yellow');
    }

    if (inventoryProductsExists) {
      counts.inventory_products = await getCount(client, 'inventory_products', tenantId);
      log(`  Products (inventory_products): ${counts.inventory_products} records`, 'blue');
    } else {
      log('  inventory_products: table not found', 'yellow');
    }

    if (inventoryCountItemsExists) {
      counts.inventory_count_items = await getCount(client, 'inventory_count_items', tenantId);
      log(`  Inventory Items (inventory_count_items): ${counts.inventory_count_items} records`, 'blue');
    } else {
      log('  inventory_count_items: table not found', 'yellow');
    }

    if (itemMasterExists) {
      counts.item_master = await getCount(client, 'item_master', tenantId);
      log(`  Item Master (item_master): ${counts.item_master} records`, 'blue');
    } else {
      log('  item_master: table not found', 'yellow');
    }

    let ledgerCount = 0;
    if (ledgerExists) {
      ledgerCount = await getCount(client, 'inventory_ledger', tenantId);
      log(`  Ledger (inventory_ledger): ${ledgerCount} records`, 'blue');
    }

    const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0) + ledgerCount;

    if (totalRecords === 0) {
      log('\n  No data found to reset.', 'green');
      await client.end();
      return;
    }

    // Show samples
    if (verbose) {
      logSection('SAMPLE RECORDS TO BE DELETED');

      if (processedInvoicesExists && counts.processed_invoices > 0) {
        log('PDFs:', 'blue');
        const samples = await getSamples(client, 'processed_invoices',
          ['invoice_number', 'invoice_date', 'total_amount'], 5, tenantId);
        for (const row of samples) {
          log(`  • ${row.invoice_number} | ${row.invoice_date || 'no date'} | $${(row.total_amount || 0).toFixed(2)}`);
        }
      }

      if (inventoryProductsExists && counts.inventory_products > 0) {
        log('\nProducts:', 'blue');
        const samples = await getSamples(client, 'inventory_products',
          ['item_code', 'description', 'quantity'], 5, tenantId);
        for (const row of samples) {
          log(`  • ${row.item_code} | ${(row.description || '').substring(0, 40)} | qty: ${row.quantity || 0}`);
        }
      }
    }

    // Execute or preview
    if (isDryRun) {
      logSection('DRY RUN SUMMARY');
      log('The following would be deleted:', 'yellow');

      for (const [table, count] of Object.entries(counts)) {
        if (count > 0) {
          log(`  • ${table}: ${count} records`);
        }
      }
      if (ledgerExists && ledgerCount > 0) {
        log(`  • inventory_ledger: ${ledgerCount} records`);
      }

      log(`\n  Total records: ${totalRecords}`, 'cyan');
      log('\n  To execute, run:', 'green');
      log('  RESET_CONFIRM=YES node scripts/reset-target.js --execute', 'green');

    } else {
      logSection('EXECUTING RESET');

      // Delete in correct order (children first)
      const deleteOrder = [
        { table: 'inventory_count_items', exists: inventoryCountItemsExists },
        { table: 'inventory_ledger', exists: ledgerExists },
        { table: 'inventory_products', exists: inventoryProductsExists },
        { table: 'item_master', exists: itemMasterExists },
        { table: 'processed_invoices', exists: processedInvoicesExists }
      ];

      let totalDeleted = 0;

      for (const { table, exists } of deleteOrder) {
        if (exists) {
          try {
            const deleted = await deleteFromTable(client, table, tenantId);
            totalDeleted += deleted;
            log(`  ✓ Deleted ${deleted} records from ${table}`, 'green');
          } catch (err) {
            log(`  ✗ Error deleting from ${table}: ${err.message}`, 'red');
          }
        }
      }

      logSection('RESET COMPLETE');
      log(`Database records deleted: ${totalDeleted}`, 'green');
      log('\n✅ Fresh start complete. The system is ready for new data.', 'green');
    }

  } catch (err) {
    log(`\nError: ${err.message}`, 'red');
    if (verbose) {
      console.error(err);
    }
    process.exit(1);
  } finally {
    await client.end();
  }

  console.log('');
}

// Run
main().catch(console.error);
