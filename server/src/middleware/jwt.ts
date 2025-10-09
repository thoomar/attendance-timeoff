import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../auth/jwt';

// Note: Express.Request.user type is defined in auth.ts

export function requireJWT(req: Request, res: Response, next: NextFunction) {
    // Check Authorization header for Bearer token
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const payload = verifyToken(token);

    if (!payload) {
        return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    }

    // Attach user to request
    req.user = payload;
    next();
}
