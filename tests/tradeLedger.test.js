/**
 * Trade Ledger Unit Tests
 * Tests for SQLite trade ledger append-only behavior and integrity
 */

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;

describe('TradeLedger', () => {
  let testDbPath;
  let tradeLedger;
  let originalEnv;

  before(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  after(() => {
    // Restore environment
    process.env = originalEnv;
    // Clear require cache
    delete require.cache[require.resolve('../backend/db/tradeLedger')];
  });

  beforeEach(async () => {
    // Create unique test DB path for each test
    testDbPath = path.join(__dirname, '../data/test_trade_ledger.db');
    
    // Clean up any existing test DB
    try {
      await fs.unlink(testDbPath);
    } catch (e) {
      // Ignore if doesn't exist
    }

    // Ensure data directory exists
    const dataDir = path.dirname(testDbPath);
    await fs.mkdir(dataDir, { recursive: true });

    // Set test DB path via env var
    process.env.LEDGER_DB_PATH = testDbPath;
    process.env.ENABLE_TRADE_LEDGER = 'true';

    // Clear require cache to get fresh instance
    delete require.cache[require.resolve('../backend/db/tradeLedger')];
    tradeLedger = require('../backend/db/tradeLedger');
  });

  afterEach(async () => {
    // Close ledger
    if (tradeLedger && typeof tradeLedger.close === 'function') {
      tradeLedger.close();
    }

    // Clean up test DB
    try {
      await fs.unlink(testDbPath);
    } catch (e) {
      // Ignore if doesn't exist
    }
  });

  describe('TradeLedger init', () => {
    it('should initialize a new ledger DB file', async () => {
      await tradeLedger.initialize();

      // Verify DB file exists
      const exists = await fs.access(testDbPath).then(() => true).catch(() => false);
      assert.strictEqual(exists, true, 'DB file should be created');
    });

    it('should create expected tables and indexes', async () => {
      await tradeLedger.initialize();

      // Query sqlite_master to verify tables and indexes
      const tables = await new Promise((resolve, reject) => {
        tradeLedger.db.all(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name",
          [],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      // Verify trades table exists
      const tradesTable = tables.find(r => r.name === 'trades' && r.type === 'table');
      assert(tradesTable, 'trades table should exist');

      // Verify indexes exist
      const expectedIndexes = [
        'idx_trades_symbol',
        'idx_trades_created_at',
        'idx_trades_status',
        'idx_trades_idempotency_key'
      ];

      for (const idxName of expectedIndexes) {
        const index = tables.find(r => r.name === idxName && r.type === 'index');
        assert(index, `Index ${idxName} should exist`);
      }
    });

    it('should close cleanly', async () => {
      await tradeLedger.initialize();
      
      // Should not throw
      tradeLedger.close();
      
      // Verify DB is closed (subsequent operations should fail or require re-init)
      assert.strictEqual(tradeLedger.db, null, 'DB should be null after close');
    });
  });

  describe('Append-only & idempotency', () => {
    it('should insert a trade with idempotency key', async () => {
      await tradeLedger.initialize();

      const trade = {
        trade_id: 'TEST_TRADE_1',
        idempotency_key: 'IDEMPOTENT_KEY_1',
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 100,
        price: 150.0,
        stop_loss: 145.0,
        take_profit: 160.0,
        confidence: 0.8,
        account_balance: 100000,
        pnl: 0,
        status: 'PENDING'
      };

      const rowId = await tradeLedger.insertTrade(trade);
      assert(rowId > 0, 'Should return inserted row ID');
    });

    it('should reject duplicate idempotency key', async () => {
      await tradeLedger.initialize();

      const trade = {
        trade_id: 'TEST_TRADE_1',
        idempotency_key: 'IDEMPOTENT_KEY_1',
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 100,
        price: 150.0,
        status: 'PENDING'
      };

      // First insert should succeed
      await tradeLedger.insertTrade(trade);

      // Second insert with same idempotency_key should fail
      let errorThrown = false;
      try {
        await tradeLedger.insertTrade(trade);
      } catch (err) {
        errorThrown = true;
        assert(err.message.includes('Duplicate trade'), 'Should throw duplicate error');
      }

      assert.strictEqual(errorThrown, true, 'Should throw error on duplicate');

      // Verify only 1 row exists
      const count = await new Promise((resolve, reject) => {
        tradeLedger.db.get(
          'SELECT COUNT(*) as count FROM trades WHERE idempotency_key = ?',
          ['IDEMPOTENT_KEY_1'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
          }
        );
      });

      assert.strictEqual(count, 1, 'Should have exactly 1 row');
    });

    it('should allow different trades with different idempotency keys', async () => {
      await tradeLedger.initialize();

      const trade1 = {
        trade_id: 'TEST_TRADE_1',
        idempotency_key: 'IDEMPOTENT_KEY_1',
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 100,
        price: 150.0,
        status: 'PENDING'
      };

      const trade2 = {
        trade_id: 'TEST_TRADE_2',
        idempotency_key: 'IDEMPOTENT_KEY_2',
        symbol: 'TSLA',
        action: 'BUY',
        quantity: 50,
        price: 200.0,
        status: 'PENDING'
      };

      await tradeLedger.insertTrade(trade1);
      await tradeLedger.insertTrade(trade2);

      // Verify both exist
      const count = await new Promise((resolve, reject) => {
        tradeLedger.db.get(
          'SELECT COUNT(*) as count FROM trades',
          [],
          (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
          }
        );
      });

      assert.strictEqual(count, 2, 'Should have 2 rows');
    });
  });

  describe('Readback integrity', () => {
    it('should store and retrieve trade fields correctly', async () => {
      await tradeLedger.initialize();

      const originalTrade = {
        trade_id: 'TEST_TRADE_READBACK',
        idempotency_key: 'IDEMPOTENT_READBACK',
        symbol: 'MSFT',
        action: 'BUY',
        quantity: 200,
        price: 300.0,
        stop_loss: 290.0,
        take_profit: 320.0,
        confidence: 0.85,
        account_balance: 50000,
        pnl: 0,
        status: 'PENDING',
        metadata: { patternId: 'PATTERN_123', source: 'test' }
      };

      await tradeLedger.insertTrade(originalTrade);

      // Read back using getTrade
      const retrieved = await tradeLedger.getTrade('TEST_TRADE_READBACK');

      assert(retrieved, 'Should retrieve trade');
      assert.strictEqual(retrieved.trade_id, originalTrade.trade_id, 'trade_id should match');
      assert.strictEqual(retrieved.idempotency_key, originalTrade.idempotency_key, 'idempotency_key should match');
      assert.strictEqual(retrieved.symbol, originalTrade.symbol, 'symbol should match');
      assert.strictEqual(retrieved.action, originalTrade.action, 'action should match');
      assert.strictEqual(retrieved.quantity, originalTrade.quantity, 'quantity should match');
      assert.strictEqual(retrieved.price, originalTrade.price, 'price should match');
      assert.strictEqual(retrieved.stop_loss, originalTrade.stop_loss, 'stop_loss should match');
      assert.strictEqual(retrieved.take_profit, originalTrade.take_profit, 'take_profit should match');
      assert.strictEqual(retrieved.confidence, originalTrade.confidence, 'confidence should match');
      assert.strictEqual(retrieved.account_balance, originalTrade.account_balance, 'account_balance should match');
      assert.strictEqual(retrieved.pnl, originalTrade.pnl, 'pnl should match');
      assert.strictEqual(retrieved.status, originalTrade.status, 'status should match');

      // Verify metadata JSON is stored and parsed correctly
      const metadata = JSON.parse(retrieved.metadata);
      assert.strictEqual(metadata.patternId, originalTrade.metadata.patternId, 'metadata.patternId should match');
      assert.strictEqual(metadata.source, originalTrade.metadata.source, 'metadata.source should match');
    });

    it('should handle null/optional fields correctly', async () => {
      await tradeLedger.initialize();

      const minimalTrade = {
        trade_id: 'TEST_MINIMAL',
        idempotency_key: 'IDEMPOTENT_MINIMAL',
        symbol: 'GOOGL',
        action: 'SELL',
        quantity: 10,
        price: 2500.0
        // No stop_loss, take_profit, confidence, etc.
      };

      await tradeLedger.insertTrade(minimalTrade);

      const retrieved = await tradeLedger.getTrade('TEST_MINIMAL');
      assert(retrieved, 'Should retrieve minimal trade');
      assert.strictEqual(retrieved.symbol, 'GOOGL', 'symbol should match');
      assert.strictEqual(retrieved.stop_loss, null, 'stop_loss should be null');
      assert.strictEqual(retrieved.take_profit, null, 'take_profit should be null');
      assert.strictEqual(retrieved.confidence, null, 'confidence should be null');
      assert.strictEqual(retrieved.metadata, null, 'metadata should be null');
    });
  });

  describe('Multiple trades ordering', () => {
    it('should return trades in newest-first order', async () => {
      await tradeLedger.initialize();

      // Insert 3 trades with increasing timestamps (by waiting a bit)
      const baseTime = Date.now();

      const trade1 = {
        trade_id: 'TRADE_1',
        idempotency_key: 'IDEM_1',
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 100,
        price: 100.0,
        status: 'PENDING'
      };

      const trade2 = {
        trade_id: 'TRADE_2',
        idempotency_key: 'IDEM_2',
        symbol: 'TSLA',
        action: 'BUY',
        quantity: 50,
        price: 200.0,
        status: 'PENDING'
      };

      const trade3 = {
        trade_id: 'TRADE_3',
        idempotency_key: 'IDEM_3',
        symbol: 'MSFT',
        action: 'BUY',
        quantity: 200,
        price: 300.0,
        status: 'PENDING'
      };

      // Insert with small delays to ensure different timestamps
      await tradeLedger.insertTrade(trade1);
      await new Promise(resolve => setTimeout(resolve, 10));
      await tradeLedger.insertTrade(trade2);
      await new Promise(resolve => setTimeout(resolve, 10));
      await tradeLedger.insertTrade(trade3);

      // Get trades (should be newest first)
      const trades = await tradeLedger.getTrades(10, 0);

      assert.strictEqual(trades.length, 3, 'Should return 3 trades');

      // Verify ordering (newest first)
      const timestamps = trades.map(t => new Date(t.created_at).getTime());
      assert(timestamps[0] >= timestamps[1], 'First trade should be newer or equal');
      assert(timestamps[1] >= timestamps[2], 'Second trade should be newer or equal');

      // Verify newest is TRADE_3
      assert.strictEqual(trades[0].trade_id, 'TRADE_3', 'Newest should be TRADE_3');
      assert.strictEqual(trades[1].trade_id, 'TRADE_2', 'Second should be TRADE_2');
      assert.strictEqual(trades[2].trade_id, 'TRADE_1', 'Oldest should be TRADE_1');
    });

    it('should respect limit and offset in getTrades', async () => {
      await tradeLedger.initialize();

      // Insert 5 trades
      for (let i = 1; i <= 5; i++) {
        await tradeLedger.insertTrade({
          trade_id: `TRADE_${i}`,
          idempotency_key: `IDEM_${i}`,
          symbol: 'AAPL',
          action: 'BUY',
          quantity: 100,
          price: 100.0 + i,
          status: 'PENDING'
        });
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Get first 2
      const firstPage = await tradeLedger.getTrades(2, 0);
      assert.strictEqual(firstPage.length, 2, 'Should return 2 trades');

      // Get next 2
      const secondPage = await tradeLedger.getTrades(2, 2);
      assert.strictEqual(secondPage.length, 2, 'Should return 2 trades');

      // Verify no overlap
      const firstIds = firstPage.map(t => t.trade_id);
      const secondIds = secondPage.map(t => t.trade_id);
      const overlap = firstIds.filter(id => secondIds.includes(id));
      assert.strictEqual(overlap.length, 0, 'Pages should not overlap');
    });
  });

  describe('Status updates', () => {
    it('should update trade status correctly', async () => {
      await tradeLedger.initialize();

      const trade = {
        trade_id: 'TEST_STATUS',
        idempotency_key: 'IDEM_STATUS',
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 100,
        price: 150.0,
        status: 'PENDING'
      };

      await tradeLedger.insertTrade(trade);

      // Update to EXECUTED
      const executedAt = new Date().toISOString();
      await tradeLedger.updateTradeStatus('TEST_STATUS', 'EXECUTED', {
        executed_at: executedAt
      });

      const retrieved = await tradeLedger.getTrade('TEST_STATUS');
      assert.strictEqual(retrieved.status, 'EXECUTED', 'Status should be EXECUTED');
      assert.strictEqual(retrieved.executed_at, executedAt, 'executed_at should be set');

      // Update to FILLED with PnL
      const filledAt = new Date().toISOString();
      await tradeLedger.updateTradeStatus('TEST_STATUS', 'FILLED', {
        filled_at: filledAt,
        pnl: 500.0
      });

      const filled = await tradeLedger.getTrade('TEST_STATUS');
      assert.strictEqual(filled.status, 'FILLED', 'Status should be FILLED');
      assert.strictEqual(filled.filled_at, filledAt, 'filled_at should be set');
      assert.strictEqual(filled.pnl, 500.0, 'pnl should be updated');
    });

    it('should handle REJECTED status with reason', async () => {
      await tradeLedger.initialize();

      const trade = {
        trade_id: 'TEST_REJECTED',
        idempotency_key: 'IDEM_REJECTED',
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 100,
        price: 150.0,
        status: 'PENDING'
      };

      await tradeLedger.insertTrade(trade);

      await tradeLedger.updateTradeStatus('TEST_REJECTED', 'REJECTED', {
        rejection_reason: 'Risk limit exceeded'
      });

      const retrieved = await tradeLedger.getTrade('TEST_REJECTED');
      assert.strictEqual(retrieved.status, 'REJECTED', 'Status should be REJECTED');
      assert(retrieved.rejected_at, 'rejected_at should be set');
      assert.strictEqual(retrieved.rejection_reason, 'Risk limit exceeded', 'rejection_reason should be set');
    });
  });

  describe('Daily PnL summary', () => {
    it('should calculate daily PnL correctly', async () => {
      await tradeLedger.initialize();

      const today = new Date().toISOString().split('T')[0];

      // Insert filled trades with PnL
      await tradeLedger.insertTrade({
        trade_id: 'TRADE_PNL_1',
        idempotency_key: 'IDEM_PNL_1',
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 100,
        price: 150.0,
        pnl: 100.0,
        status: 'FILLED'
      });

      await tradeLedger.insertTrade({
        trade_id: 'TRADE_PNL_2',
        idempotency_key: 'IDEM_PNL_2',
        symbol: 'TSLA',
        action: 'BUY',
        quantity: 50,
        price: 200.0,
        pnl: -50.0,
        status: 'FILLED'
      });

      await tradeLedger.insertTrade({
        trade_id: 'TRADE_PNL_3',
        idempotency_key: 'IDEM_PNL_3',
        symbol: 'MSFT',
        action: 'BUY',
        quantity: 200,
        price: 300.0,
        pnl: 200.0,
        status: 'FILLED'
      });

      // Pending trade should not be counted
      await tradeLedger.insertTrade({
        trade_id: 'TRADE_PNL_4',
        idempotency_key: 'IDEM_PNL_4',
        symbol: 'GOOGL',
        action: 'BUY',
        quantity: 10,
        price: 2500.0,
        pnl: 0,
        status: 'PENDING'
      });

      const summary = await tradeLedger.getDailyPnL(today);

      assert.strictEqual(summary.date, today, 'Date should match');
      assert.strictEqual(summary.totalPnL, 250.0, 'Total PnL should be 100 - 50 + 200 = 250');
      assert.strictEqual(summary.tradeCount, 3, 'Should count only FILLED trades');
      assert.strictEqual(summary.winningTrades, 2, 'Should have 2 winning trades');
      assert.strictEqual(summary.losingTrades, 1, 'Should have 1 losing trade');
    });
  });
});

