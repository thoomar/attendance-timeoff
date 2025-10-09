import jwt from 'jsonwebtoken';
import type { Role } from '../auth';

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET or SESSION_SECRET must be set');
}

export interface JWTPayload {
    id: string;
    email: string;
    fullName: string;
    role: Role;
    managerUserId?: string | null;
}

export function signToken(payload: JWTPayload): string {
    return jwt.sign(payload, JWT_SECRET!, {
        expiresIn: '30d',
        issuer: 'timeoff-api',
    });
}

export function verifyToken(token: string): JWTPayload | null {
    try {
        const decoded = jwt.verify(token, JWT_SECRET!, {
            issuer: 'timeoff-api',
        }) as JWTPayload;
        return decoded;
    } catch (err) {
        console.error('[JWT] Verification failed:', err);
        return null;
    }
}
