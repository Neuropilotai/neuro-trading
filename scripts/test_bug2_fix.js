// Test Bug 2 Fix: SQL syntax error with empty updates array
const path = require('path');
const tradeLedger = require(path.join(__dirname, '..', 'backend', 'db', 'tradeLedger'));
const crypto = require('crypto');

async function testBug2Fix() {
  try {
    await tradeLedger.initialize();
    
    // Insert a test trade with all required fields
    const testTrade = {
      symbol: 'TEST',
      action: 'BUY',
      quantity: 0.1,
      price: 100,
      status: 'PENDING',
      alert_id: 'test-bug2-' + Date.now(),
      timestamp: Date.now(),
      idempotency_key: 'test-key-' + crypto.randomBytes(8).toString('hex')
    };
    
    const tradeId = await tradeLedger.insertTrade(testTrade);
    console.log('✅ Created test trade:', tradeId);
    
    // Test Bug 2: Call updateTradeStatus with ONLY status (empty additionalData)
    // This should NOT cause SQL syntax error
    try {
      await tradeLedger.updateTradeStatus(tradeId, 'REJECTED', {});
      console.log('✅ PASS: updateTradeStatus with empty additionalData succeeded - no SQL syntax error');
      process.exit(0);
    } catch (error) {
      if (error.message.includes('syntax error') || 
          error.message.includes('SQLITE_ERROR') ||
          error.message.includes('near "WHERE"')) {
        console.log('❌ FAIL: SQL syntax error detected:', error.message);
        process.exit(1);
      } else {
        // Other errors (like constraint violations) are OK - we're just testing SQL syntax
        console.log('✅ PASS: No SQL syntax error (other error is acceptable):', error.message);
        process.exit(0);
      }
    }
  } catch (error) {
    console.log('❌ FAIL: Test setup error:', error.message);
    process.exit(1);
  }
}

testBug2Fix();

