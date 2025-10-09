// server/src/auth.ts
import { Request, Response, NextFunction } from 'express';
import * as db from './db'; // adjust if your db.ts path differs
import { verifyToken } from './auth/jwt';

// Keep type wide enough for your DB check constraint
export type Role =
    | 'Enrollment Specialist'
    | 'Senior Contract Specialist'
    | 'Timeshare Closer'
    | 'Timeshare Relief Consultant'
    | 'Manager'
    | 'Admin';

declare global {
    namespace Express {
        interface User {
            id: string;
            email: string;
            fullName: string;
            role: Role;
            managerUserId?: string | null;
        }
        interface Request {
            user: User;
        }
    }
}

// --- Demo fallback user (used only if nothing else provided) ---
const DEMO_USER: Express.User = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'agent@example.com',
    fullName: 'Agent Example',
    role: 'Enrollment Specialist',
    managerUserId: '00000000-0000-0000-0000-000000000099',
};

// Parse dev override header (JSON) if present
function parseDevUserHeader(req: Request): Express.User | null {
    const raw = req.header('x-dev-user');
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        return {
            id: String(o.id ?? DEMO_USER.id),
            email: String(o.email ?? DEMO_USER.email),
            fullName: String(o.fullName ?? o.name ?? DEMO_USER.fullName),
            role: (o.role ?? DEMO_USER.role) as Role,
            managerUserId: o.managerUserId ?? null,
        };
    } catch {
        return null;
    }
}

// Look up a user by email in Postgres and return app user
async function getUserByEmail(email: string): Promise<Express.User | null> {
    const sql = `
    SELECT id, email, full_name, role, manager_user_id
    FROM users
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1
  `;
    const { rows } = await db.query(sql, [email]);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
        id: r.id,
        email: r.email,
        fullName: r.full_name ?? r.email,
        role: r.role as Role,
        managerUserId: r.manager_user_id ?? null,
    };
}

/**
 * requireAuth precedence:
 * 1) JWT Bearer token (primary auth method)
 * 2) x-dev-user (explicit dev/testing override)
 * 3) x-auth-email -> DB lookup (legacy fallback)
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
    try {
        // 1) JWT Bearer token
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            console.log('[AUTH] Verifying JWT token...');
            const payload = verifyToken(token);
            if (payload) {
                console.log('[AUTH] JWT valid for:', payload.email);
                req.user = payload;
                return next();
            } else {
                console.log('[AUTH] JWT verification failed');
            }
        }

        // 2) Dev override
        const dev = parseDevUserHeader(req);
        if (dev) {
            req.user = dev;
            return next();
        }

        // 3) DB-backed auth via x-auth-email (legacy)
        const authEmail = req.header('x-auth-email');
        if (authEmail) {
            const dbUser = await getUserByEmail(authEmail);
            if (dbUser) {
                req.user = dbUser;
                return next();
            }
        }

        // 4) No user - require authentication
        return res.status(401).json({ error: 'Authentication required' });
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(500).json({ error: 'Auth failure' });
    }
}

export function requireRole(roles: Role[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}

// Nice helper if you need it elsewhere
export function currentUser(req: Request): Express.User {
    return req.user ?? DEMO_USER;
}

/**
 * Middleware to attach req.user from session
 * Used after session middleware to populate req.user for all routes
 */
export function attachSessionUser(req: Request, res: Response, next: NextFunction) {
    const sessionUser = (req.session as any)?.user;
    if (sessionUser) {
        req.user = {
            id: sessionUser.id || DEMO_USER.id,
            email: sessionUser.email || DEMO_USER.email,
            fullName: sessionUser.fullName || sessionUser.name || DEMO_USER.fullName,
            role: sessionUser.role || DEMO_USER.role,
            managerUserId: sessionUser.managerUserId || null,
        };
    }
    next();
}
