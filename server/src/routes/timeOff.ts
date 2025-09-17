import express from 'express';
import * as db from '../db';
import { sendTimeOffEmail } from '../services/timeoffEmail';

const router = express.Router();

console.log(
    'TIMEOFF ROUTE BUILD TAG',
    new Date().toISOString(),
    __filename.replace(/\.ts$/, '.js').replace('/src/', '/dist/')
);

// ---------- types / helpers ----------
type AuthedReq = express.Request & {
    user?: {
        id: string;
        email?: string;
        fullName?: string;
        role?: string;            // 'Employee' | 'Manager' | 'Admin' | 'HR' | ...
        managerUserId?: string | null;
    };
};

function ensureAuthed(req: AuthedReq, res: express.Response, next: express.NextFunction) {
    if (!req.user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
}

function ensureManager(req: AuthedReq, res: express.Response, next: express.NextFunction) {
    const role = req.user?.role;
    if (!role || !['Manager', 'Admin', 'HR'].includes(role)) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    next();
}

function getFromTo(req: express.Request) {
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        const err: any = new Error('from/to must be YYYY-MM-DD');
        err.status = 400;
        throw err;
    }
    return { from, to };
}

function toISODateStrings(dates: Date[] | string[]) {
    return (dates || []).map(d => new Date(d as any).toISOString());
}

const SITE_URL = process.env.SITE_URL || process.env.PUBLIC_SITE_URL || '';

// ---------- routes ----------
router.get('/_ping', (_req, res) => res.json({ ok: true, route: 'time-off' }));

// Create handler shared by both POST endpoints
async function createRequestHandler(req: AuthedReq, res: express.Response) {
    if (!req.user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' });

    let dates: string[] = [];
    const reason = (req.body?.reason ?? '').toString().slice(0, 500);

    try {
        if (Array.isArray(req.body?.dates)) {
            dates = req.body.dates.map((s: any) => String(s).slice(0, 10));
        }
        if (!dates.length || !dates.every(s => /^\d{4}-\d{2}-\d{2}$/.test(s))) {
            return res.status(400).json({ ok: false, error: 'dates must be an array of YYYY-MM-DD' });
        }

        const { rows } = await db.query(
            `
                INSERT INTO time_off_requests (user_id, dates, reason, status, created_at)
                VALUES ($1, $2::date[], NULLIF($3,'') , 'PENDING', now())
                    RETURNING id, created_at
            `,
            [req.user.id, dates, reason]
        );

        const id = rows[0].id as string;
        const createdAt = rows[0].created_at as Date;

        // fire-and-forget NEW_REQUEST email to approvers/HR using your existing service
        Promise.resolve(
            sendTimeOffEmail('NEW_REQUEST', {
                siteUrl: SITE_URL,
                employeeName: req.user.fullName || req.user.email || 'Employee',
                employeeEmail: req.user.email || '',
                reason,
                dates, // array of 'YYYY-MM-DD'
            })
        ).catch(() => {});

        return res.json({ ok: true, id, created_at: createdAt });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || 'failed to create request' });
    }
}

// Primary create endpoint the UI already uses:
router.post('/', ensureAuthed, createRequestHandler);
// Back-compat alias requested:
router.post('/requests', ensureAuthed, createRequestHandler);

// Manager: list pending
router.get('/pending', ensureAuthed, ensureManager, async (_req: AuthedReq, res) => {
    try {
        const { rows } = await db.query(
            `
                SELECT
                    r.id,
                    r.user_id        AS user_id,
                    r.dates          AS dates,
                    r.reason         AS reason,
                    r.status         AS status,
                    r.created_at     AS created_at,
                    u.full_name      AS user_name,
                    u.email          AS user_email
                FROM time_off_requests r
                         JOIN users u ON u.id = r.user_id
                WHERE r.status = 'PENDING'
                ORDER BY r.created_at DESC
            `
        );

        res.json(
            rows.map(r => ({
                ...r,
                dates: toISODateStrings(r.dates),
            }))
        );
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'failed to load pending' });
    }
});

// Manager: approve/deny
router.patch('/:id', ensureAuthed, ensureManager, async (req: AuthedReq, res) => {
    const id = String(req.params.id || '');
    const decision = String(req.body?.decision || '').toUpperCase();
    const note = (req.body?.note ?? '').toString().slice(0, 500);

    if (!/^[0-9a-f\-]{36}$/i.test(id)) {
        return res.status(400).json({ ok: false, error: 'invalid id' });
    }
    if (!['APPROVED', 'DENIED', 'REJECTED'].includes(decision)) {
        return res.status(400).json({ ok: false, error: 'decision must be APPROVED or DENIED/REJECTED' });
    }

    try {
        // Use RETURNING so we know if anything was updated and grab data for email in one go.
        const { rows } = await db.query(
            `
      UPDATE time_off_requests r
      SET status = $2,
          decision_note = NULLIF($3,''),
          decided_at = now()
      WHERE r.id = $1
      RETURNING
        r.id,
        r.reason,
        r.dates,
        r.created_at,
        r.decided_at,
        (SELECT u.full_name FROM users u WHERE u.id = r.user_id) AS user_name,
        (SELECT u.email     FROM users u WHERE u.id = r.user_id) AS user_email
      `,
            [id, decision === 'REJECTED' ? 'DENIED' : decision, note]
        );

        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'not found' });

        const row = rows[0];

        // fire-and-forget decision email to the employee using your existing service
        const firstDate = Array.isArray(row.dates) && row.dates.length
            ? String(row.dates[0]).slice(0, 10)
            : '';
        Promise.resolve(
            sendTimeOffEmail(
                (decision === 'REJECTED' ? 'REJECTED' : decision) as 'APPROVED' | 'REJECTED',
                {
                    siteUrl: SITE_URL,
                    employeeName: row.user_name || row.user_email || 'Employee',
                    employeeEmail: row.user_email || '',
                    date: firstDate || new Date().toISOString().slice(0, 10),
                    decision: (decision === 'REJECTED' ? 'REJECTED' : 'APPROVED'),
                    reason: note || row.reason || '',
                }
            )
        ).catch(() => {});

        res.json({ ok: true });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'failed to update' });
    }
});

// Employee calendar (only my requests)
router.get('/calendar', ensureAuthed, async (req: AuthedReq, res) => {
    try {
        const { from, to } = getFromTo(req);

        const { rows } = await db.query(
            `
                SELECT
                    r.id,
                    r.user_id        AS "userId",
                    u.full_name      AS "name",
                    u.email          AS "email",
                    r.status,
                    r.reason,
                    r.created_at     AS "created_at",
                    ARRAY(SELECT (d)::timestamptz FROM unnest(r.dates) AS d) AS "dates"
                FROM time_off_requests r
                         JOIN users u ON u.id = r.user_id
                WHERE r.dates && daterange($1::date, $2::date, '[]')
                  AND r.status IN ('PENDING','APPROVED')
                  AND r.user_id = $3
                ORDER BY r.created_at DESC
            `,
            [from, to, req.user!.id]
        );

        res.json({
            entries: rows.map(r => ({ ...r, dates: toISODateStrings(r.dates) })),
        });
    } catch (e: any) {
        const status = (e && (e as any).status) || 500;
        res.status(status).json({ ok: false, error: e?.message || 'calendar failed' });
    }
});

// Manager calendar (all employees)
router.get('/manager/calendar', ensureAuthed, ensureManager, async (req: AuthedReq, res) => {
    try {
        const { from, to } = getFromTo(req);

        const { rows } = await db.query(
            `
                SELECT
                    r.id,
                    r.user_id        AS "userId",
                    u.full_name      AS "name",
                    u.email          AS "email",
                    r.status,
                    r.reason,
                    r.created_at     AS "created_at",
                    ARRAY(SELECT (d)::timestamptz FROM unnest(r.dates) AS d) AS "dates"
                FROM time_off_requests r
                         JOIN users u ON u.id = r.user_id
                WHERE r.dates && daterange($1::date, $2::date, '[]')
                  AND r.status IN ('PENDING','APPROVED')
                ORDER BY r.created_at DESC, u.full_name ASC
            `,
            [from, to]
        );

        res.json({
            entries: rows.map(r => ({ ...r, dates: toISODateStrings(r.dates) })),
        });
    } catch (e: any) {
        const status = (e && (e as any).status) || 500;
        res.status(status).json({ ok: false, error: e?.message || 'manager calendar failed' });
    }
});

export default router;
