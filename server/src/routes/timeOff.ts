// server/src/routes/timeOff.ts
import { Router, Request, Response } from 'express';
import * as db from '../db';
import { ensureAuthed, ensureManager } from '../auth';
import { sendTimeOffEmail } from '../services/timeoffEmail';

type AuthedReq = Request & {
    user?: {
        id: string;
        email: string;
        fullName: string;
        role: 'Employee' | 'Manager' | string;
    };
};

const router = Router();

// Helpful tag so you can see rebuilds in pm2 logs
console.log(
    'TIMEOFF ROUTE BUILD TAG',
    new Date().toISOString(),
    __filename.replace(process.cwd(), ''),
);

// ---- utils --------------------------------------------------------------

function toISODateStrings(dates: (string | Date)[]): string[] {
    // Ensure consistent ISO strings for the client
    return (dates || []).map((d) => new Date(d).toISOString());
}

function parseBodyDates(body: any): string[] {
    const raw = Array.isArray(body?.dates) ? body.dates : [];
    // normalize yyyy-mm-dd only
    return raw
        .map((s) => String(s).trim())
        .filter(Boolean)
        .map((s) => s.substring(0, 10));
}

function isManager(req: AuthedReq) {
    return (req.user?.role || '').toLowerCase().includes('manager');
}

// ---- health -------------------------------------------------------------

router.get('/_ping', (_req, res) => {
    res.json({ ok: true, route: 'time-off' });
});

// ---- create request -----------------------------------------------------
// POST /api/time-off               (kept for back-compat)
// POST /api/time-off/requests      (new alias, used by the new UI)
router.post('/', ensureAuthed, async (req: AuthedReq, res: Response) => {
    await createRequestHandler(req, res);
});
router.post('/requests', ensureAuthed, async (req: AuthedReq, res: Response) => {
    await createRequestHandler(req, res);
});

async function createRequestHandler(req: AuthedReq, res: Response) {
    try {
        const user = req.user!;
        const dates = parseBodyDates(req.body);
        const reason = String(req.body?.reason || '').trim();

        if (!dates.length) {
            return res.status(400).json({ ok: false, error: 'dates required' });
        }

        // Sort date strings (YYYY-MM-DD) before insert for consistency
        dates.sort();

        const { rows } = await db.query(
            `
      INSERT INTO time_off_requests (user_id, dates, reason, status, created_at)
      VALUES ($1, $2::date[], $3, 'PENDING', now())
      RETURNING id, user_id, dates, reason, status, created_at
      `,
            [user.id, dates, reason],
        );
        const row = rows[0];

        // Fire NEW_REQUEST email to approvers/HR
        try {
            await sendTimeOffEmail('NEW_REQUEST', {
                siteUrl: process.env.SITE_URL || '',
                employeeName: user.fullName,
                employeeEmail: user.email,
                reason,
                dates, // YYYY-MM-DD[]
            });
        } catch (e: any) {
            console.warn('[email] NEW_REQUEST failed:', e?.message || String(e));
        }

        res.json({ ok: true, id: row.id });
    } catch (e: any) {
        const status = (e && (e as any).status) || 500;
        res.status(status).json({ ok: false, error: e?.message || 'create failed' });
    }
}

// ---- pending list for managers -----------------------------------------

router.get('/pending', ensureAuthed, ensureManager, async (_req: AuthedReq, res: Response) => {
    try {
        const { rows } = await db.query(
            `
                SELECT
                    r.id,
                    r.user_id,
                    r.dates,
                    r.reason,
                    r.status,
                    r.created_at,
                    u.full_name AS user_name,
                    u.email     AS user_email
                FROM time_off_requests r
                         JOIN users u ON u.id = r.user_id
                WHERE r.status = 'PENDING'
                ORDER BY r.created_at DESC
            `,
            [],
        );
        res.json(
            rows.map((r: any) => ({
                id: r.id,
                user_id: r.user_id,
                dates: toISODateStrings(r.dates),
                reason: r.reason,
                status: r.status,
                created_at: r.created_at,
                user_name: r.user_name,
                user_email: r.user_email,
            })),
        );
    } catch (e: any) {
        const status = (e && (e as any).status) || 500;
        res.status(status).json({ ok: false, error: e?.message || 'pending failed' });
    }
});

// ---- approve / reject ---------------------------------------------------
// PATCH /api/time-off/:id  { decision: "APPROVED" | "REJECTED", note?: string }
router.patch('/:id', ensureAuthed, ensureManager, async (req: AuthedReq, res: Response) => {
    try {
        const id = String(req.params.id);
        const decisionRaw = String(req.body?.decision || '').toUpperCase();
        const note = String(req.body?.note || '').trim();

        if (!['APPROVED', 'REJECTED'].includes(decisionRaw)) {
            return res.status(400).json({ ok: false, error: 'decision must be APPROVED or REJECTED' });
        }

        const { rows } = await db.query(
            `
      UPDATE time_off_requests
      SET status = $2,
          decision_note = $3,
          decided_at = now()
      WHERE id = $1
      RETURNING id, user_id, dates, status
      `,
            [id, decisionRaw, note],
        );

        if (!rows.length) {
            return res.status(404).json({ ok: false, error: 'request not found' });
        }

        // Email the employee with the decision
        const reqRow = rows[0];
        const { rows: urows } = await db.query(
            `SELECT full_name, email FROM users WHERE id = $1 LIMIT 1`,
            [reqRow.user_id],
        );
        if (urows.length) {
            const emp = urows[0];
            try {
                await sendTimeOffEmail(decisionRaw as any, {
                    siteUrl: process.env.SITE_URL || '',
                    employeeName: emp.full_name,
                    employeeEmail: emp.email,
                    // pick first date for subject/body (template supports single date)
                    date: String(reqRow.dates?.[0] || '').substring(0, 10),
                    decision: decisionRaw as 'APPROVED' | 'REJECTED',
                    reason: note,
                });
            } catch (e: any) {
                console.warn('[email] decision email failed:', e?.message || String(e));
            }
        }

        res.json({ ok: true });
    } catch (e: any) {
        const status = (e && (e as any).status) || 500;
        res.status(status).json({ ok: false, error: e?.message || 'patch failed' });
    }
});

// ---- employee calendar (self) -------------------------------------------
// GET /api/time-off/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/calendar', ensureAuthed, async (req: AuthedReq, res: Response) => {
    try {
        const from = String(req.query.from || '').substring(0, 10);
        const to = String(req.query.to || '').substring(0, 10);

        const { rows } = await db.query(
            `
      SELECT
        r.id,
        r.user_id           AS "userId",
        u.full_name         AS "name",
        u.email             AS "email",
        r.status,
        r.reason,
        r.created_at        AS "created_at",
        ARRAY(SELECT (d)::timestamptz FROM unnest(r.dates) AS d) AS "dates"
      FROM time_off_requests r
      JOIN users u ON u.id = r.user_id
      WHERE r.user_id = $3
        AND r.dates && daterange($1::date, $2::date, '[]')
        AND r.status IN ('PENDING', 'APPROVED')
      ORDER BY r.created_at DESC
      `,
            [from, to, req.user!.id],
        );

        res.json({
            entries: rows.map((r: any) => ({ ...r, dates: toISODateStrings(r.dates) })),
        });
    } catch (e: any) {
        const status = (e && (e as any).status) || 500;
        res.status(status).json({ ok: false, error: e?.message || 'calendar failed' });
    }
});

// ---- manager calendar (all) ---------------------------------------------
// GET /api/time-off/manager/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/manager/calendar', ensureAuthed, ensureManager, async (req: AuthedReq, res: Response) => {
    try {
        const from = String(req.query.from || '').substring(0, 10);
        const to = String(req.query.to || '').substring(0, 10);

        const { rows } = await db.query(
            `
      SELECT
        r.id,
        r.user_id                 AS "userId",
        u.full_name               AS "name",
        u.email                   AS "email",
        r.status,
        r.reason,
        r.created_at              AS "created_at",
        ARRAY(SELECT (d)::timestamptz FROM unnest(r.dates) AS d) AS "dates"
      FROM time_off_requests r
      JOIN users u ON u.id = r.user_id
      WHERE r.dates && daterange($1::date, $2::date, '[]')
        AND r.status IN ('PENDING','APPROVED')
      ORDER BY r.created_at DESC, u.full_name ASC
      `,
            [from, to],
        );

        res.json({
            entries: rows.map((r: any) => ({ ...r, dates: toISODateStrings(r.dates) })),
        });
    } catch (e: any) {
        const status = (e && (e as any).status) || 500;
        res.status(status).json({ ok: false, error: e?.message || 'manager calendar failed' });
    }
});

export default router;
