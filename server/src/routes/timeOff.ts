// server/src/routes/timeOff.ts
import express from 'express';
import * as db from '../db';

const router = express.Router();

// Tiny build tag so you can verify the compiled file being loaded
// (you'll see this line echoed when you `require()` the route)
console.log(
    'TIMEOFF ROUTE BUILD TAG',
    new Date().toISOString(),
    __filename.replace(/\.ts$/, '.js').replace('/src/', '/dist/')
);

// ---------- helpers ----------
type AuthedReq = express.Request & {
    user?: {
        id: string;
        email?: string;
        fullName?: string;
        role?: string; // 'Employee' | 'Manager' | 'Admin' | 'HR' | ...
        managerUserId?: string | null;
    };
};

function getFromTo(req: express.Request) {
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw Object.assign(new Error('from/to must be YYYY-MM-DD'), { status: 400 });
    }
    return { from, to };
}

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

function toISODateStrings(dates: Date[] | string[]) {
    return (dates || []).map(d => new Date(d as any).toISOString());
}

// ---------- routes ----------

// Simple health check for this router
router.get('/_ping', (_req, res) => res.json({ ok: true, route: 'time-off' }));

/**
 * Create a time-off request for the current user
 * Body: { dates: string[] (YYYY-MM-DD), reason?: string }
 */
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
      RETURNING id
      `,
            [req.user.id, dates, reason]
        );

        return res.json({ ok: true, id: rows[0].id });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || 'failed to create request' });
    }
}

// Primary submit endpoint used by the UI
router.post('/', ensureAuthed, createRequestHandler);

// Back-compat alias some clients used: POST /api/time-off/requests
router.post('/requests', ensureAuthed, createRequestHandler);

/**
 * Pending requests (manager-only)
 * Returns most recent first with requester info
 */
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

        // normalize date output to ISO strings
        const out = rows.map(r => ({
            ...r,
            dates: toISODateStrings(r.dates),
        }));

        res.json(out);
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'failed to load pending' });
    }
});

/**
 * Approve / Deny a request (manager-only)
 * Body: { decision: 'APPROVED' | 'DENIED', note?: string }
 */
router.patch('/:id', ensureAuthed, ensureManager, async (req: AuthedReq, res) => {
    const id = String(req.params.id || '');
    const decision = String(req.body?.decision || '').toUpperCase();
    const note = (req.body?.note ?? '').toString().slice(0, 500);

    if (!/^[0-9a-f\-]{36}$/i.test(id)) {
        return res.status(400).json({ ok: false, error: 'invalid id' });
    }
    if (!['APPROVED', 'DENIED'].includes(decision)) {
        return res.status(400).json({ ok: false, error: 'decision must be APPROVED or DENIED' });
    }

    try {
        const result = await db.query(
            `
      UPDATE time_off_requests
      SET status = $2,
          decision_note = NULLIF($3,''),
          decided_at = now()
      WHERE id = $1
      `,
            [id, decision, note]
        );

        // pg compatible across codebases (some adapters return {rowCount}, some don't)
        const updated = (result as any).rowCount ?? (Array.isArray((result as any).rows) ? (result as any).rows.length : 0);
        if (!updated) return res.status(404).json({ ok: false, error: 'not found' });

        res.json({ ok: true });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'failed to update' });
    }
});

/**
 * Employee calendar: only this user's requests within [from,to]
 * Query: from=YYYY-MM-DD&to=YYYY-MM-DD
 */
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
        ARRAY(
          SELECT (d)::timestamptz FROM unnest(r.dates) AS d
        )                AS "dates"
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

/**
 * Manager calendar: ALL users’ requests within [from,to]
 * Query: from=YYYY-MM-DD&to=YYYY-MM-DD
 */
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
        ARRAY(
          SELECT (d)::timestamptz FROM unnest(r.dates) AS d
        )                AS "dates"
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
