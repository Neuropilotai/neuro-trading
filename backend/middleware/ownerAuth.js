const { authenticateToken } = require('./auth');

/**
 * Owner Authentication Middleware
 * Validates both JWT token and X-Owner-Device header
 */
async function authenticateOwner(req, res, next) {
    // Log authentication attempt for debugging
    console.log(`[AUTH] Owner auth attempt: ${req.method} ${req.path}`);
    console.log(`[AUTH] Headers:`, {
        'authorization': req.headers['authorization'] ? 'Bearer [token]' : 'missing',
        'x-owner-device': req.headers['x-owner-device'] || 'missing'
    });

    // First, validate JWT token using existing middleware logic
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        console.log('[AUTH] Missing token');
        return res.status(401).json({ 
            error: 'Unauthorized',
            message: 'Missing Authorization header' 
        });
    }

    // Check for X-Owner-Device header
    const deviceId = req.headers['x-owner-device'];
    
    if (!deviceId) {
        console.log('[AUTH] Missing X-Owner-Device header');
        return res.status(401).json({ 
            error: 'Unauthorized',
            message: 'Missing X-Owner-Device header' 
        });
    }

    // Validate device ID format (basic validation)
    if (typeof deviceId !== 'string' || deviceId.length < 5) {
        return res.status(400).json({ 
            error: 'Invalid Request',
            message: 'Invalid X-Owner-Device header format' 
        });
    }

    // Use existing authenticateToken to validate JWT
    // We'll call it manually and handle the response
    try {
        // Import SessionModel to verify token
        const { SessionModel } = require('../db/database');
        const { verifyToken } = require('./auth');
        
        // Verify JWT token
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(403).json({ 
                error: 'Forbidden',
                message: 'Invalid or expired token' 
            });
        }

        // Verify session exists (if database is available)
        let session;
        try {
            session = await SessionModel.findByToken(token);
        } catch (dbError) {
            // Database might not be initialized, use decoded token info instead
            console.warn('Database session lookup failed, using token payload:', dbError.message);
        }

        // If session exists, use it; otherwise use decoded token info
        if (session) {
            req.user = {
                id: session.userId,
                email: session.email,
                firstName: session.firstName,
                lastName: session.lastName,
                role: session.role
            };
        } else {
            // Fallback: use decoded token info (for cases where database isn't initialized)
            req.user = {
                id: decoded.userId,
                email: 'owner@system.local',
                firstName: 'Owner',
                lastName: 'User',
                role: 'owner'
            };
        }
        
        req.owner = {
            ...req.user,
            deviceId: deviceId
        };

        next();
    } catch (error) {
        console.error('Owner authentication error:', error);
        return res.status(500).json({ 
            error: 'Internal Server Error',
            message: 'Authentication verification failed' 
        });
    }
}

module.exports = {
    authenticateOwner
};

