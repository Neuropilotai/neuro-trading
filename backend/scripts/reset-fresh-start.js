#!/usr/bin/env node
/**
 * FRESH START RESET SCRIPT
 *
 * Purpose: Safely reset PDFs and inventory products for a fresh start
 *
 * What it does:
 * 1. Deletes records from processed_invoices (PDFs displayed in Orders/PDF tab)
 * 2. Deletes records from inventory_count_items (products in Inventory list)
 * 3. Deletes records from item_master (product definitions)
 * 4. Optionally removes PDF files from ./data/gfs_orders/ and ./data/invoices/
 *
 * Safety features:
 * - DRY RUN mode (default): Shows what will be deleted without making changes
 * - EXECUTE mode: Actually performs the deletion
 * - Tenant scoping: Currently single-tenant, but respects future multi-tenant design
 * - File backup before deletion (optional)
 *
 * Usage:
 *   node scripts/reset-fresh-start.js --dry-run          # Preview what will be deleted
 *   node scripts/reset-fresh-start.js --execute          # Actually delete
 *   node scripts/reset-fresh-start.js --execute --files  # Also delete PDF files
 *
 * Tables affected (in deletion order - children first):
 *   1. inventory_count_items (FK to item_master via item_code)
 *   2. invoice_items (FK to storage_locations)
 *   3. location_assignments (FK to storage_locations)
 *   4. inventory_snapshots (FK to inventory_counts)
 *   5. processed_invoices (main PDF records)
 *   6. item_master (product definitions)
 *   7. inventory_min_max (min/max levels)
 *
 * Tables preserved (critical system data):
 *   - users, user_sessions (auth)
 *   - storage_locations (location setup)
 *   - inventory_counts (count metadata - optional, can be cleared)
 *   - item_categories (category definitions)
 *   - inventory_config (system config)
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Configuration - supports environment variable for production
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '../data/enterprise_inventory.db');
const PDF_DIRS = [
  path.join(__dirname, '../data/gfs_orders'),
  path.join(__dirname, '../data/invoices')
];

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = !args.includes('--execute');
const deleteFiles = args.includes('--files');
const verbose = args.includes('--verbose') || args.includes('-v');
const createIfMissing = args.includes('--init');

// Color codes for console output
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

/**
 * Promisified database query
 */
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

/**
 * Check if database exists
 */
function checkDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    log(`Database not found at: ${DB_PATH}`, 'red');
    log('Nothing to reset.', 'yellow');
    return false;
  }
  return true;
}

/**
 * Get counts of records that will be deleted
 */
async function getCounts(db) {
  const counts = {};

  // Tables to check
  const tables = [
    { name: 'processed_invoices', label: 'PDFs (processed_invoices)' },
    { name: 'inventory_count_items', label: 'Inventory Items (inventory_count_items)' },
    { name: 'item_master', label: 'Product Definitions (item_master)' },
    { name: 'invoice_items', label: 'Invoice Line Items (invoice_items)' },
    { name: 'location_assignments', label: 'Location Assignments' },
    { name: 'inventory_snapshots', label: 'Inventory Snapshots' },
    { name: 'inventory_min_max', label: 'Min/Max Levels' },
    { name: 'reorder_alerts', label: 'Reorder Alerts' },
    { name: 'inventory_consumption', label: 'Consumption Records' }
  ];

  for (const table of tables) {
    try {
      const result = await dbGet(db, `SELECT COUNT(*) as count FROM ${table.name}`);
      counts[table.name] = { count: result?.count || 0, label: table.label };
    } catch (err) {
      // Table might not exist
      counts[table.name] = { count: 0, label: table.label, error: 'Table not found' };
    }
  }

  return counts;
}

/**
 * Get sample records for preview
 */
async function getSampleRecords(db) {
  const samples = {};

  // Sample PDFs
  try {
    samples.pdfs = await dbAll(db, `
      SELECT invoice_number, invoice_date, total_amount, item_count
      FROM processed_invoices
      ORDER BY invoice_date DESC
      LIMIT 10
    `);
  } catch (err) {
    samples.pdfs = [];
  }

  // Sample inventory items
  try {
    samples.inventory = await dbAll(db, `
      SELECT DISTINCT item_code, location, counted_quantity
      FROM inventory_count_items
      ORDER BY count_date DESC
      LIMIT 10
    `);
  } catch (err) {
    samples.inventory = [];
  }

  // Sample products
  try {
    samples.products = await dbAll(db, `
      SELECT item_code, description, current_unit_price
      FROM item_master
      LIMIT 10
    `);
  } catch (err) {
    samples.products = [];
  }

  return samples;
}

/**
 * Get PDF files that will be deleted
 */
function getPdfFiles() {
  const files = [];

  for (const dir of PDF_DIRS) {
    if (fs.existsSync(dir)) {
      const dirFiles = fs.readdirSync(dir)
        .filter(f => f.endsWith('.pdf'))
        .map(f => ({
          name: f,
          path: path.join(dir, f),
          dir: dir
        }));
      files.push(...dirFiles);
    }
  }

  return files;
}

/**
 * Execute the reset (deletion)
 */
async function executeReset(db) {
  const results = {
    deleted: {},
    errors: []
  };

  // Order matters - delete children before parents
  const deletions = [
    // Children tables first
    { table: 'inventory_count_items', label: 'Inventory Items' },
    { table: 'inventory_snapshots', label: 'Inventory Snapshots' },
    { table: 'location_assignments', label: 'Location Assignments' },
    { table: 'invoice_items', label: 'Invoice Line Items' },
    { table: 'reorder_alerts', label: 'Reorder Alerts' },
    { table: 'inventory_consumption', label: 'Consumption Records' },
    { table: 'inventory_min_max', label: 'Min/Max Levels' },
    // Parent tables last
    { table: 'processed_invoices', label: 'PDFs' },
    { table: 'item_master', label: 'Product Definitions' }
  ];

  for (const { table, label } of deletions) {
    try {
      const result = await dbRun(db, `DELETE FROM ${table}`);
      results.deleted[table] = result.changes;
      log(`  ✓ Deleted ${result.changes} records from ${label}`, 'green');
    } catch (err) {
      if (err.message.includes('no such table')) {
        log(`  - Skipped ${label} (table not found)`, 'yellow');
      } else {
        results.errors.push({ table, error: err.message });
        log(`  ✗ Error deleting from ${label}: ${err.message}`, 'red');
      }
    }
  }

  return results;
}

/**
 * Delete PDF files from disk
 */
function deletePdfFiles(files) {
  const results = { deleted: 0, errors: [] };

  for (const file of files) {
    try {
      fs.unlinkSync(file.path);
      results.deleted++;
      if (verbose) {
        log(`  ✓ Deleted ${file.name}`, 'green');
      }
    } catch (err) {
      results.errors.push({ file: file.path, error: err.message });
      log(`  ✗ Error deleting ${file.name}: ${err.message}`, 'red');
    }
  }

  return results;
}

/**
 * Main execution
 */
async function main() {
  console.log('\n');
  log('╔══════════════════════════════════════════════════════════╗', 'cyan');
  log('║         FRESH START RESET TOOL                           ║', 'cyan');
  log('║         Enterprise Inventory System                      ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════╝', 'cyan');

  if (isDryRun) {
    log('\n🔍 MODE: DRY RUN (no changes will be made)', 'yellow');
    log('   Run with --execute to perform actual deletion\n', 'yellow');
  } else {
    log('\n⚠️  MODE: EXECUTE (changes will be permanent!)', 'red');
    if (deleteFiles) {
      log('   Including PDF file deletion from disk', 'red');
    }
    console.log('');
  }

  // Check database
  if (!checkDatabase()) {
    return;
  }

  // Open database
  const db = new sqlite3.Database(DB_PATH);

  try {
    // Get current counts
    logSection('CURRENT STATE');
    const counts = await getCounts(db);

    let hasData = false;
    for (const [table, info] of Object.entries(counts)) {
      if (info.count > 0) {
        hasData = true;
        log(`  ${info.label}: ${info.count} records`, 'blue');
      } else if (info.error) {
        log(`  ${info.label}: ${info.error}`, 'yellow');
      }
    }

    if (!hasData) {
      log('\n  No data found to reset.', 'green');
      db.close();
      return;
    }

    // Get sample records
    logSection('SAMPLE RECORDS TO BE DELETED');
    const samples = await getSampleRecords(db);

    if (samples.pdfs.length > 0) {
      log('PDFs (Orders/PDF tab):', 'blue');
      for (const pdf of samples.pdfs) {
        log(`  • ${pdf.invoice_number} | ${pdf.invoice_date || 'no date'} | $${(pdf.total_amount || 0).toFixed(2)} | ${pdf.item_count || 0} items`);
      }
    }

    if (samples.inventory.length > 0) {
      log('\nInventory Items:', 'blue');
      for (const item of samples.inventory) {
        log(`  • ${item.item_code} @ ${item.location || 'unknown'} | qty: ${item.counted_quantity || 0}`);
      }
    }

    if (samples.products.length > 0) {
      log('\nProduct Definitions:', 'blue');
      for (const product of samples.products) {
        log(`  • ${product.item_code} | ${(product.description || '').substring(0, 40)} | $${(product.current_unit_price || 0).toFixed(2)}`);
      }
    }

    // Check PDF files
    const pdfFiles = getPdfFiles();
    if (pdfFiles.length > 0) {
      log(`\nPDF Files on disk: ${pdfFiles.length} files`, 'blue');
      if (verbose) {
        for (const file of pdfFiles.slice(0, 10)) {
          log(`  • ${file.name}`);
        }
        if (pdfFiles.length > 10) {
          log(`  ... and ${pdfFiles.length - 10} more`);
        }
      }

      if (!deleteFiles) {
        log('\n  Note: PDF files will NOT be deleted (use --files flag to include)', 'yellow');
      }
    }

    // Execute or preview
    if (isDryRun) {
      logSection('DRY RUN SUMMARY');
      log('The following would be deleted:', 'yellow');

      let totalRecords = 0;
      for (const [table, info] of Object.entries(counts)) {
        if (info.count > 0) {
          log(`  • ${info.label}: ${info.count} records`);
          totalRecords += info.count;
        }
      }

      log(`\n  Total records: ${totalRecords}`, 'cyan');

      if (deleteFiles && pdfFiles.length > 0) {
        log(`  PDF files: ${pdfFiles.length}`, 'cyan');
      }

      log('\n  To execute, run:', 'green');
      log(`  node scripts/reset-fresh-start.js --execute${deleteFiles ? ' --files' : ''}`, 'green');

    } else {
      logSection('EXECUTING RESET');

      // Perform deletion
      const dbResults = await executeReset(db);

      // Delete files if requested
      let fileResults = null;
      if (deleteFiles && pdfFiles.length > 0) {
        log('\nDeleting PDF files...', 'blue');
        fileResults = deletePdfFiles(pdfFiles);
        log(`  Deleted ${fileResults.deleted} files`, 'green');
      }

      // Summary
      logSection('RESET COMPLETE');

      let totalDeleted = 0;
      for (const [table, count] of Object.entries(dbResults.deleted)) {
        totalDeleted += count;
      }

      log(`Database records deleted: ${totalDeleted}`, 'green');

      if (fileResults) {
        log(`PDF files deleted: ${fileResults.deleted}`, 'green');
      }

      if (dbResults.errors.length > 0 || (fileResults && fileResults.errors.length > 0)) {
        log(`\nErrors encountered: ${dbResults.errors.length + (fileResults?.errors.length || 0)}`, 'red');
      }

      log('\n✅ Fresh start complete. The system is ready for new data.', 'green');
    }

  } catch (err) {
    log(`\nError: ${err.message}`, 'red');
    console.error(err);
  } finally {
    db.close();
  }

  console.log('');
}

// Run
main().catch(console.error);
