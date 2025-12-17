const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

/**
 * GET /api/owner/reports/finance
 * Get financial report data for owner console
 * Requires: JWT token + X-Owner-Device header
 */
router.get('/reports/finance', async (req, res) => {
    try {
        const dbPath = path.join(__dirname, '../data/enterprise_inventory.db');
        
        // Check if database exists
        if (!fs.existsSync(dbPath)) {
            return res.json({
                success: true,
                report: {
                    totalRevenue: 0,
                    totalExpenses: 0,
                    netProfit: 0,
                    period: 'N/A',
                    breakdown: []
                }
            });
        }

        const db = new sqlite3.Database(dbPath);

        // Get financial data from processed invoices
        const financeData = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 
                    COUNT(*) as totalInvoices,
                    COALESCE(SUM(total_amount), 0) as totalRevenue,
                    MIN(invoice_date) as startDate,
                    MAX(invoice_date) as endDate
                FROM processed_invoices
            `, [], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        // Get breakdown by invoice date (monthly)
        const breakdown = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    strftime('%Y-%m', invoice_date) as month,
                    COUNT(*) as invoiceCount,
                    COALESCE(SUM(total_amount), 0) as amount
                FROM processed_invoices
                WHERE invoice_date IS NOT NULL
                GROUP BY strftime('%Y-%m', invoice_date)
                ORDER BY month DESC
                LIMIT 12
            `, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });

        // Calculate expenses (simplified - can be enhanced with actual expense data)
        // For now, estimate expenses as 70% of revenue (typical food service margin)
        const estimatedExpenses = financeData.totalRevenue * 0.7;
        const netProfit = financeData.totalRevenue - estimatedExpenses;

        // Format period
        let period = 'All time';
        if (financeData.startDate && financeData.endDate) {
            const start = new Date(financeData.startDate);
            const end = new Date(financeData.endDate);
            period = `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
        }

        // Format breakdown
        const breakdownFormatted = breakdown.map(item => ({
            category: new Date(item.month + '-01').toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'long' 
            }),
            amount: item.amount,
            invoiceCount: item.invoiceCount
        }));

        db.close();

        res.json({
            success: true,
            report: {
                totalRevenue: financeData.totalRevenue || 0,
                totalExpenses: estimatedExpenses,
                netProfit: netProfit,
                period: period,
                totalInvoices: financeData.totalInvoices || 0,
                breakdown: breakdownFormatted
            }
        });

    } catch (error) {
        console.error('Finance report error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate finance report',
            message: error.message
        });
    }
});

/**
 * GET /api/owner/status
 * Get owner console status and system info
 */
router.get('/status', (req, res) => {
    res.json({
        success: true,
        status: 'operational',
        user: {
            email: req.owner.email,
            role: req.owner.role,
            deviceId: req.owner.deviceId
        },
        timestamp: new Date().toISOString()
    });
});

/**
 * GET /api/owner/test
 * Test endpoint to verify authentication is working
 */
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Owner authentication is working!',
        user: req.owner,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;

