// server/src/routes/timeOff.ts

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

// Build tag so we can verify the compiled file loaded
// (you'll see this line in PM2 logs after restart)
console.log(
    'TIMEOFF ROUTE BUILD TAG',
    new Date().toISOString(),
    __filename.replace(process.cwd(), '')
);

// ---------- helpers ----------

function getUser(req: ReqWithUser): AppUser {
    // Prefer whatever upstream middleware populated
    if (req.user?.id) return req.user;

    // Dev header fallback: x-dev-user: {"id":"...","email":"...","fullName":"...","role":"Employee"}
    const raw = req.header('x-dev-user');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed?.id) return parsed as AppUser;
        } catch {
            // ignore parse error
        }
    }
    throw new Error('Unauthenticated: missing user (set x-dev-user in dev)');
}

function toDateArray(dates: unknown): string[] {
    if (!Array.isArray(dates)) return [];
    return dates
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        // accept "YYYY-MM-DD" or ISO; normalize to "YYYY-MM-DD"
        .map((s) => (s.length > 10 ? s.slice(0, 10) : s));
}

function isoMidnight(dateYYYYMMDD: string): string {
    // Render as UTC midnight ISO for the UI
    return new Date(dateYYYYMMDD + 'T00:00:00Z').toISOString();
}

// ---------- routes ----------

// quick healthcheck
router.get('/_ping', (_req, res) => {
    res.json({ ok: true, route: 'time-off' });
});

// Core create handler (mounted on two paths for compatibility)
async function createTimeOffRequest(req: ReqWithUser, res: Response) {
    try {
        const user = getUser(req);
        const { reason } = (req.body || {}) as { reason?: string };
        const dates = toDateArray((req.body || {}).dates);

        if (!dates.length) {
            return res.status(400).json({ ok: false, error: 'At least one date is required' });
        }
        if (!reason || !reason.trim()) {
            return res.status(400).json({ ok: false, error: 'Reason is required' });
        }

        const { rows } = await db.query(
            `
        INSERT INTO time_off_requests (user_id, dates, reason, status, created_at)
        VALUES ($1, $2::date[], $3, 'PENDING', now())
        RETURNING id
      `,
            [user.id, dates, reason.trim()]
        );

        return res.json({ ok: true, id: rows[0]?.id });
    } catch (err: any) {
        console.error('create time-off failed', err);
        return res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
}

// New endpoint (current client)
router.post('/', createTimeOffRequest);

// Back-compat alias for older clients (your UI was calling this)
router.post('/requests', createTimeOffRequest);

// List pending requests (for approvers)
router.get('/pending', async (_req: ReqWithUser, res: Response) => {
    try {
        const { rows } = await db.query(
            `
        SELECT r.id,
               r.user_id,
               r.dates,
               r.reason,
               r.status,
               r.created_at,
               COALESCE(u.full_name, '') AS user_name,
               COALESCE(u.email, '')     AS user_email
        FROM time_off_requests r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = 'PENDING'
        ORDER BY r.created_at DESC
      `,
            []
        );
        res.json(rows);
    } catch (err: any) {
        console.error('pending failed', err);
        res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
});

// Approve/Decline a request
router.patch('/:id', async (req: ReqWithUser, res: Response) => {
    try {
        // (Optionally) check approver role from req.user here
        const { id } = req.params;
        const { decision, note } = (req.body || {}) as {
            decision?: 'APPROVED' | 'DECLINED';
            note?: string;
        };

        if (decision !== 'APPROVED' && decision !== 'DECLINED') {
            return res.status(400).json({ ok: false, error: 'decision must be APPROVED or DECLINED' });
        }

        const { rowCount } = await db.query(
            `
        UPDATE time_off_requests
        SET status = $2,
            decision_note = COALESCE($3, decision_note),
            decided_at = now()
        WHERE id = $1
        RETURNING id
      `,
            [id, decision, note ?? null]
        );

        if (!rowCount) {
            return res.status(404).json({ ok: false, error: 'request not found' });
        }

        res.json({ ok: true });
    } catch (err: any) {
        console.error('decision failed', err);
        res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
});

// Team calendar within a range
// GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/calendar', async (req: ReqWithUser, res: Response) => {
    try {
        const user = getUser(req); // not used today, but keeps consistent auth path

        const from = String(req.query.from || '').slice(0, 10);
        const to = String(req.query.to || '').slice(0, 10);
        if (!from || !to) {
            return res.status(400).json({ ok: false, error: 'from and to are required (YYYY-MM-DD)' });
        }

        // Select requests that have at least one date within [from, to]
        const { rows } = await db.query(
            `
        SELECT r.id,
               r.user_id,
               COALESCE(u.full_name, '') AS name,
               r.status,
               r.reason,
               r.dates
        FROM time_off_requests r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE array_length(r.dates, 1) IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM unnest(r.dates) AS d(day)
            WHERE d.day BETWEEN $1::date AND $2::date
          )
        ORDER BY r.created_at DESC
      `,
            [from, to]
        );

        // Shape expected by the UI (keep backward-compatible keys)
        const entries = rows.map((r) => ({
            id: r.id as string,
            userId: r.user_id as string,
            name: (r.name as string) || '',
            status: r.status as string,
            reason: r.reason as string,
            dates: Array.isArray(r.dates)
                ? (r.dates as string[]).map((d) => isoMidnight(d))
                : [],
        }));

        res.json({ entries });
    } catch (err: any) {
        console.error('calendar failed error:', err);
        res.status(400).json({ ok: false, error: err?.message || 'failed' });
    }
});

export default router;
