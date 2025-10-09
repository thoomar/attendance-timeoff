import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import * as db from '../db';
import { sendTimeOffEmail } from '../services/timeoffEmail';

const router = express.Router();

/* ===========================
   Config / Helpers
   =========================== */

const VALID_ROLES = new Set([
    'Enrollment Specialist',
    'Senior Contract Specialist',
    'Timeshare Closer',
    'Timeshare Relief Consultant',
    'Manager',
    'Admin',
]);

const DEFAULT_ROLE =
    process.env.DEFAULT_USER_ROLE && VALID_ROLES.has(process.env.DEFAULT_USER_ROLE)
        ? process.env.DEFAULT_USER_ROLE
        : 'Enrollment Specialist';

const CreateReq = z.object({
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    reason: z.string().min(3),
});

const DecisionReq = z.object({
    decision: z.enum(['APPROVED', 'REJECTED', 'DENIED']),
    note: z.string().max(2000).optional(),
});

// Dev shim so curl with `x-dev-user` works even with Entra auth
function devUserShim(req: Request, _res: Response, next: NextFunction) {
    const h = req.headers['x-dev-user'];
    if (h) {
        try {
            const parsed = JSON.parse(String(h));
            (req as any).session = (req as any).session || {};
            (req as any).session.user = {
                email: parsed.email,
                name: parsed.fullName || parsed.name || null,
                id: parsed.id, // optional, not used by ensureUserId
            };
        } catch {
            // ignore
        }
    }
    next();
}

// Upsert users row by email to satisfy NOT NULL constraints & UUID PK
async function ensureUserId(email: string, fullName?: string | null): Promise<string> {
    const found = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 LIMIT 1`,
        [email],
    );
    if (found.rows?.[0]?.id) return String(found.rows[0].id);

    const name = (fullName && fullName.trim()) ? fullName.trim() : email;
    const role = DEFAULT_ROLE;

    const upsert = await db.query<{ id: string }>(
        `
    INSERT INTO users (id, email, full_name, role, created_at, updated_at)
    VALUES (uuid_generate_v4(), $1, $2, $3, NOW(), NOW())
    ON CONFLICT (email) DO UPDATE
      SET full_name = EXCLUDED.full_name,
          updated_at = NOW()
    RETURNING id
    `,
        [email, name, role],
    );

    return String(upsert.rows[0].id);
}

/* ===========================
   Routes (mounted at /api/time-off)
   =========================== */

router.get('/_ping', (_req, res) => res.json({ ok: true, route: 'time-off' }));

// Apply dev shim so it runs before requireAuth on this router
router.use(devUserShim);

// Create time-off request
router.post(['/', '/requests', '/request'], requireAuth, async (req: Request, res: Response) => {
    try {
        const sessUser = req.user;
        if (!sessUser?.email) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

        const { dates, reason } = CreateReq.parse(req.body);
        const userId = await ensureUserId(sessUser.email, sessUser.fullName ?? null);

        // Insert as DATE[] (array)
        const { rows } = await db.query<{ id: string }>(
            `
                INSERT INTO time_off_requests (
                    id, user_id, dates, reason, status, created_at, updated_at
                )
                VALUES (
                           uuid_generate_v4(), $1, $2::date[], $3, 'PENDING', NOW(), NOW()
                       )
                    RETURNING id
            `,
            [userId, dates, reason],
        );

        const id = rows?.[0]?.id;

        // Notify HR + approvers
        try {
            await sendTimeOffEmail('NEW_REQUEST', {
                siteUrl: process.env.APP_BASE_URL || process.env.BASE_URL || 'https://timeoff.timesharehelpcenter.com',
                employeeName: sessUser.fullName || sessUser.email,
                employeeEmail: sessUser.email,
                reason,
                dates,
            });
        } catch (e) {
            console.warn('[email] NEW_REQUEST send failed:', e);
        }

        return res.json({ ok: true, id });
    } catch (e: any) {
        console.error('[time-off][create] error:', e?.stack || e);
        return res.status(400).json({ ok: false, error: e?.message || 'create failed' });
    }
});

// My requests
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
    try {
        const sessUser = req.user;
        if (!sessUser?.email) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

        const userId = await ensureUserId(sessUser.email, sessUser.fullName ?? null);

        const { rows } = await db.query(
            `
                SELECT r.id, r.user_id, r.dates, r.reason, r.status, r.created_at,
                       r.decided_at, r.decision_note,
                       u.full_name AS user_name, u.email AS user_email
                FROM time_off_requests r
                         LEFT JOIN users u ON u.id = r.user_id
                WHERE r.user_id = $1
                ORDER BY r.created_at DESC
            `,
            [userId],
        );
        return res.json({ ok: true, items: rows });
    } catch (e: any) {
        console.error('[time-off][mine] error:', e?.stack || e);
        return res.status(500).json({ ok: false, error: e?.message || 'mine failed' });
    }
});

// Pending list
router.get('/pending', requireAuth, async (_req: Request, res: Response) => {
    try {
        const { rows } = await db.query(
            `
                SELECT r.id, r.user_id, r.dates, r.reason, r.status, r.created_at,
                       u.full_name AS user_name, u.email AS user_email
                FROM time_off_requests r
                         LEFT JOIN users u ON u.id = r.user_id
                WHERE r.status = 'PENDING'
                ORDER BY r.created_at DESC
            `,
            [],
        );
        return res.json({ ok: true, items: rows });
    } catch (e: any) {
        console.error('[time-off][pending] error:', e?.stack || e);
        return res.status(500).json({ ok: false, error: e?.message || 'pending failed' });
    }
});

// Approve / Reject (PATCH)
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        const body = DecisionReq.parse(req.body);
        const sessUser = req.user;
        if (!sessUser?.email) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

        // Normalize DENIED to REJECTED for database consistency
        const normalizedDecision = body.decision === 'DENIED' ? 'REJECTED' : body.decision;

        // Get request details before updating
        const requestQuery = await db.query<{ 
            user_id: string; 
            dates: string[]; 
            user_name: string; 
            user_email: string;
        }>(
            `
                SELECT r.user_id, r.dates, u.full_name AS user_name, u.email AS user_email
                FROM time_off_requests r
                LEFT JOIN users u ON u.id = r.user_id
                WHERE r.id = $1
            `,
            [id],
        );

        if (!requestQuery.rows?.length) return res.status(404).json({ ok: false, error: 'not found' });
        const requestData = requestQuery.rows[0];

        // Update the request
        const { rows } = await db.query(
            `
                UPDATE time_off_requests
                SET status = $2,
                    decision_note = $3,
                    decided_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                    RETURNING id
            `,
            [id, normalizedDecision, body.note ?? null],
        );

        if (!rows?.length) return res.status(404).json({ ok: false, error: 'not found' });

        // Send email notification
        try {
            const emailType = normalizedDecision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
            await sendTimeOffEmail(emailType, {
                siteUrl: process.env.APP_BASE_URL || process.env.BASE_URL || 'https://timeoff.timesharehelpcenter.com',
                employeeName: requestData.user_name || requestData.user_email,
                employeeEmail: requestData.user_email,
                managerName: sessUser.fullName || sessUser.email,
                dates: requestData.dates || [],
                decision: normalizedDecision,
                denialReason: normalizedDecision === 'REJECTED' ? body.note || undefined : undefined,
            });
        } catch (e) {
            console.warn('[email] Decision notification send failed:', e);
        }

        return res.json({ ok: true });
    } catch (e: any) {
        console.error('[time-off][decision:patch] error:', e?.stack || e);
        return res.status(400).json({ ok: false, error: e?.message || 'decision failed' });
    }
});

// Approve / Reject (POST alias)
router.post('/:id/decision', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        const body = DecisionReq.parse(req.body);
        const sessUser = req.user;
        if (!sessUser?.email) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

        // Normalize DENIED to REJECTED for database consistency
        const normalizedDecision = body.decision === 'DENIED' ? 'REJECTED' : body.decision;

        // Get request details before updating
        const requestQuery = await db.query<{ 
            user_id: string; 
            dates: string[]; 
            user_name: string; 
            user_email: string;
        }>(
            `
                SELECT r.user_id, r.dates, u.full_name AS user_name, u.email AS user_email
                FROM time_off_requests r
                LEFT JOIN users u ON u.id = r.user_id
                WHERE r.id = $1
            `,
            [id],
        );

        if (!requestQuery.rows?.length) return res.status(404).json({ ok: false, error: 'not found' });
        const requestData = requestQuery.rows[0];

        // Update the request
        const { rows } = await db.query(
            `
                UPDATE time_off_requests
                SET status = $2,
                    decision_note = $3,
                    decided_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                    RETURNING id
            `,
            [id, normalizedDecision, body.note ?? null],
        );

        if (!rows?.length) return res.status(404).json({ ok: false, error: 'not found' });

        // Send email notification
        try {
            const emailType = normalizedDecision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
            await sendTimeOffEmail(emailType, {
                siteUrl: process.env.APP_BASE_URL || process.env.BASE_URL || 'https://timeoff.timesharehelpcenter.com',
                employeeName: requestData.user_name || requestData.user_email,
                employeeEmail: requestData.user_email,
                managerName: sessUser.fullName || sessUser.email,
                dates: requestData.dates || [],
                decision: normalizedDecision,
                denialReason: normalizedDecision === 'REJECTED' ? body.note || undefined : undefined,
            });
        } catch (e) {
            console.warn('[email] Decision notification send failed:', e);
        }

        return res.json({ ok: true });
    } catch (e: any) {
        console.error('[time-off][decision:post] error:', e?.stack || e);
        return res.status(400).json({ ok: false, error: e?.message || 'decision failed' });
    }
});

// Calendar (DATE[] via UNNEST)
router.get('/calendar', requireAuth, async (req: Request, res: Response) => {
    try {
        const from = (req.query.from as string) || new Date().toISOString().slice(0, 10);
        const to = (req.query.to as string) || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

        const { rows } = await db.query(
            `
                SELECT r.id, r.user_id, u.full_name AS user_name, u.email AS user_email,
                       r.dates, r.status, r.created_at
                FROM time_off_requests r
                         LEFT JOIN users u ON u.id = r.user_id
                WHERE EXISTS (
                    SELECT 1 FROM unnest(r.dates) AS d(actual)
                    WHERE d.actual BETWEEN $1::date AND $2::date
                )
                ORDER BY r.user_id, r.id DESC
            `,
            [from, to],
        );

        const entries = (rows || []).map((r: any) => ({
            id: r.id,
            userId: r.user_id,
            name: r.user_name || r.user_email,
            status: r.status,
            dates: r.dates as string[],
            created_at: r.created_at,
        }));

        return res.json({ ok: true, entries });
    } catch (e: any) {
        console.error('[time-off][calendar] error:', e?.stack || e);
        return res.status(500).json({ ok: false, error: e?.message || 'calendar failed' });
    }
});

export default router;
