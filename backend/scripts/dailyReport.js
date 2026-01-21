#!/usr/bin/env node

/**
 * Daily Trading Report Generator
 * Generates daily PnL and performance reports
 * 
 * Run daily via cron: 0 9 * * * node backend/scripts/dailyReport.js
 * Or manually: node backend/scripts/dailyReport.js
 */

const tradeLedger = require('../db/tradeLedger');
const paperTradingService = require('../services/paperTradingService');
const fs = require('fs').promises;
const path = require('path');

async function generateDailyReport() {
    const today = new Date().toISOString().split('T')[0];
    const reportDir = path.join(process.cwd(), 'TradingDrive', 'reports');
    
    try {
        console.log(`📊 Generating daily report for ${today}...`);
        
        // Ensure report directory exists
        await fs.mkdir(reportDir, { recursive: true });
        
        // Initialize trade ledger
        await tradeLedger.initialize();
        
        // Get daily PnL from ledger
        const dailyPnL = await tradeLedger.getDailyPnL(today);
        
        // Get account summary
        const accountSummary = paperTradingService.getAccountSummary();
        
        // Get all trades for today
        const allTrades = await tradeLedger.getTrades(1000, 0);
        const todayTrades = allTrades.filter(t => t.created_at.startsWith(today));
        
        // Calculate metrics
        const winningTrades = todayTrades.filter(t => t.pnl > 0);
        const losingTrades = todayTrades.filter(t => t.pnl < 0);
        const winRate = todayTrades.length > 0 
            ? (winningTrades.length / todayTrades.length) * 100 
            : 0;
        
        const avgWin = winningTrades.length > 0
            ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length
            : 0;
        
        const avgLoss = losingTrades.length > 0
            ? losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length
            : 0;
        
        const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
        
        // Calculate max drawdown (simplified - would need running balance)
        const tradesWithPnL = todayTrades.filter(t => t.pnl !== null && t.pnl !== undefined);
        let runningBalance = accountSummary.initialBalance;
        let peakBalance = runningBalance;
        let maxDrawdown = 0;
        
        for (const trade of tradesWithPnL) {
            runningBalance += trade.pnl;
            if (runningBalance > peakBalance) {
                peakBalance = runningBalance;
            }
            const drawdown = ((peakBalance - runningBalance) / peakBalance) * 100;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }
        
        // Build report
        const report = {
            date: today,
            generatedAt: new Date().toISOString(),
            account: {
                initialBalance: accountSummary.initialBalance,
                currentBalance: accountSummary.balance,
                totalValue: accountSummary.totalValue,
                totalPnL: accountSummary.totalPnL,
                dailyPnL: accountSummary.dailyPnL
            },
            trades: {
                total: todayTrades.length,
                filled: todayTrades.filter(t => t.status === 'FILLED').length,
                rejected: todayTrades.filter(t => t.status === 'REJECTED').length,
                pending: todayTrades.filter(t => t.status === 'PENDING' || t.status === 'VALIDATED').length
            },
            performance: {
                totalPnL: dailyPnL.totalPnL || 0,
                winRate: winRate.toFixed(2),
                winningTrades: winningTrades.length,
                losingTrades: losingTrades.length,
                avgWin: avgWin.toFixed(2),
                avgLoss: avgLoss.toFixed(2),
                profitFactor: profitFactor.toFixed(2),
                maxDrawdown: maxDrawdown.toFixed(2)
            },
            positions: {
                open: accountSummary.openPositions,
                details: accountSummary.positions
            },
            recentTrades: todayTrades.slice(-10).map(t => ({
                trade_id: t.trade_id,
                symbol: t.symbol,
                action: t.action,
                quantity: t.quantity,
                price: t.price,
                pnl: t.pnl,
                status: t.status,
                created_at: t.created_at
            }))
        };
        
        // Save report to file
        const reportFile = path.join(reportDir, `daily_${today}.json`);
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
        
        console.log(`✅ Daily report saved: ${reportFile}`);
        
        // Print summary to console
        console.log('\n📊 Daily Trading Report Summary');
        console.log('================================');
        console.log(`Date: ${today}`);
        console.log(`Total Trades: ${report.trades.total}`);
        console.log(`Filled: ${report.trades.filled} | Rejected: ${report.trades.rejected} | Pending: ${report.trades.pending}`);
        console.log(`Daily P&L: $${report.performance.totalPnL.toFixed(2)}`);
        console.log(`Win Rate: ${report.performance.winRate}%`);
        console.log(`Profit Factor: ${report.performance.profitFactor}`);
        console.log(`Max Drawdown: ${report.performance.maxDrawdown}%`);
        console.log(`Open Positions: ${report.positions.open}`);
        console.log(`Account Balance: $${report.account.currentBalance.toFixed(2)}`);
        console.log(`Total Value: $${report.account.totalValue.toFixed(2)}`);
        console.log('================================\n');
        
        // Optional: Send email/Slack notification
        if (process.env.EMAIL_REPORTS === 'true') {
            await sendEmailReport(report);
        }
        
        return report;
        
    } catch (error) {
        console.error('❌ Error generating daily report:', error);
        throw error;
    }
}

async function sendEmailReport(report) {
    // Placeholder for email notification
    // Would integrate with nodemailer or similar
    console.log('📧 Email notification would be sent here');
    // Implementation would go here
}

// Run if called directly
if (require.main === module) {
    generateDailyReport()
        .then(() => {
            console.log('✅ Report generation complete');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Report generation failed:', error);
            process.exit(1);
        });
}

module.exports = { generateDailyReport };


