import { Router, Request, Response } from 'express';
import * as db from '../db';

type AppUser = {
    id: string;
    email?: string;
    fullName?: string;
    role?: string;
    managerUserId?: string | null;
};
type ReqWithUser = Request & { user?: AppUser };

const router = Router();

// Build tag + quick route inspector
console.log('TIMEOFF ROUTE BUILD TAG', new Date().toISOString(), __filename);

router.get('/_routes', (_req, res) => {
    type Layer = { route?: { path: string; methods: Record<string, boolean> } };
    const stack: Layer[] = ((router as unknown as { stack?: Layer[] }).stack ?? []);
    const list = stack
        .filter(l => !!l.route)
        .map(l => {
            const method = l.route ? Object.keys(l.route.methods)[0] : 'get';
            return `${method.toUpperCase()} ${l.route?.path}`;
        });
    res.json({ routes: list });
});

function getUser(req: ReqWithUser): AppUser {
    if (req.user?.id) return req.user;
    const raw = req.header('x-dev-user');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed?.id) return parsed as AppUser;
        } catch {
            // ignore
        }
    }
    throw new Error('Unauthenticated: missing user (set x-dev-user in dev)');
}

function toDateArray(dates: unknown): string[] {
    if (!Array.isArray(dates)) return [];
    return dates
        .map(String)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => (s.length > 10 ? s.slice(0, 10) : s)); // YYYY-MM-DD
}

function isoMidnight(dateYYYYMMDD: string): string {
    return new Date(dateYYYYMMDD + 'T00:00:00Z').toISOString();
}

router.get('/_ping', (_req, res) => res.json({ ok: true, route: 'time-off' }));

// ---- create handler (shared by two paths) ----
async function createTimeOffRequest(req: ReqWithUser, res: Response) {
    try {
        const user = getUser(req);
        const body = (req.body || {}) as { dates?: unknown; reason?: string };
        const dates = toDateArray(body.dates);
        const reason = (body.reason || '').trim();

        if (!dates.length) return res.status(400).json({ ok: false, error: 'At least one date is required' });
        if (!reason) return res.status(400).json({ ok: false, error: 'Reason is required' });

        const { rows } = await db.query(
            `INSERT INTO time_off_requests (user_id, dates, reason, status, created_at)
             VALUES ($1, $2::date[], $3, 'PENDING', now())
                 RETURNING id`,
            [user.id, dates, reason]
        );

        return res.json({ ok: true, id: rows[0]?.id });
    } catch (err: any) {
        console.error('create time-off failed', { error: err?.message || String(err) });
        return res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
}

// Both paths below are intentional so old/new UIs work
router.post('/', createTimeOffRequest);            // NEW: POST /api/time-off
router.post('/requests', createTimeOffRequest);    // OLD: POST /api/time-off/requests

router.get('/pending', async (_req: ReqWithUser, res: Response) => {
    try {
        const { rows } = await db.query(
            `SELECT r.id, r.user_id, r.dates, r.reason, r.status, r.created_at,
                    COALESCE(u.full_name,'') AS user_name,
                    COALESCE(u.email,'')     AS user_email
             FROM time_off_requests r
                      LEFT JOIN users u ON u.id = r.user_id
             WHERE r.status = 'PENDING'
             ORDER BY r.created_at DESC`,
            []
        );
        res.json(rows);
    } catch (err: any) {
        console.error('pending failed', err);
        res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
});

router.patch('/:id', async (req: ReqWithUser, res: Response) => {
    try {
        const { id } = req.params;
        const { decision, note } = (req.body || {}) as { decision?: 'APPROVED'|'DECLINED'; note?: string };

        if (decision !== 'APPROVED' && decision !== 'DECLINED') {
            return res.status(400).json({ ok: false, error: 'decision must be APPROVED or DECLINED' });
        }

        const { rows } = await db.query(
            `UPDATE time_off_requests
             SET status = $2,
                 decision_note = COALESCE($3, decision_note),
                 decided_at = now()
             WHERE id = $1
                 RETURNING id`,
            [id, decision, note ?? null]
        );

        if (!rows.length) return res.status(404).json({ ok: false, error: 'request not found' });
        res.json({ ok: true });
    } catch (err: any) {
        console.error('decision failed', err);
        res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
});

router.get('/calendar', async (req: ReqWithUser, res: Response) => {
    try {
        getUser(req); // ensure auth

        const from = String(req.query.from || '').slice(0, 10);
        const to   = String(req.query.to   || '').slice(0, 10);
        if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to are required (YYYY-MM-DD)' });

        const { rows } = await db.query(
            `SELECT r.id, r.user_id, COALESCE(u.full_name,'') AS name, r.status, r.reason, r.dates
             FROM time_off_requests r
                      LEFT JOIN users u ON u.id = r.user_id
             WHERE array_length(r.dates,1) IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM unnest(r.dates) AS d(day)
                 WHERE d.day BETWEEN $1::date AND $2::date
             )
             ORDER BY r.created_at DESC`,
            [from, to]
        );

        const entries = rows.map(r => ({
            id: r.id as string,
            userId: r.user_id as string,
            name: (r.name as string) || '',
            status: r.status as string,
            reason: r.reason as string,
            dates: Array.isArray(r.dates) ? (r.dates as string[]).map(d => isoMidnight(d)) : [],
        }));

        res.json({ entries });
    } catch (err: any) {
        console.error('calendar failed error:', err);
        res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
});

export default router;
