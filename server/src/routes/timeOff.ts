// server/src/routes/timeOff.ts

import { Router, Request, Response } from 'express';
import * as db from '../db';

const router = Router();

/** tiny build marker so we can see the compiled file got deployed */
(() => {
    // eslint-disable-next-line no-console
    console.log(
        'TIMEOFF ROUTE BUILD TAG',
        new Date().toISOString(),
        __filename.replace(process.cwd(), ''),
    );
})();

type ReqUser = {
    id: string;
    email?: string;
    fullName?: string;
    role?: string;
    managerUserId?: string | null;
};

function getReqUser(req: Request): ReqUser | null {
    const u = (req as any).user as ReqUser | undefined;
    if (u && u.id) return u;

    const raw = req.header('x-dev-user');
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.id) return parsed;
    } catch {
        /* ignore */
    }
    return null;
}

function bad(res: Response, status: number, msg: string) {
    return res.status(status).json({ ok: false, error: msg });
}

/* -------------------- health -------------------- */
router.get('/_ping', (_req, res) => {
    res.json({ ok: true, route: 'time-off' });
});

/* -------------------- create request -------------------- */

async function createRequestHandler(req: Request, res: Response) {
    const me = getReqUser(req);
    if (!me?.id) return bad(res, 401, 'unauthorized');

    const { dates, reason } = req.body ?? {};

    if (!Array.isArray(dates) || dates.length === 0) {
        return bad(res, 400, 'dates[] is required');
    }

    // Normalize to yyyy-mm-dd unique + sorted
    const normalized = Array.from(
        new Set(
            dates
                .map((d: any) => String(d || '').slice(0, 10))
                .filter((s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
        ),
    ).sort();

    if (normalized.length === 0) {
        return bad(res, 400, 'no valid ISO dates provided');
    }

    try {
        const q = `
      INSERT INTO time_off_requests (user_id, dates, reason, status, created_at)
      VALUES ($1, $2::date[], $3, 'PENDING', now())
      RETURNING id
    `;
        const { rows } = await db.query(q, [me.id, normalized, String(reason ?? '').trim()]);
        return res.json({ ok: true, id: rows[0]?.id });
    } catch (e: any) {
        return bad(res, 500, e?.message || 'create failed');
    }
}

// Back-compat for old UI
router.post('/requests', createRequestHandler);
// Canonical path
router.post('/', createRequestHandler);

/* -------------------- list pending -------------------- */

router.get('/pending', async (_req, res) => {
    try {
        const q = `
      SELECT
        r.id,
        r.user_id,
        r.dates,
        r.reason,
        r.status,
        r.created_at,
        COALESCE(u.full_name, u.name, u.email) AS user_name,
        u.email AS user_email
      FROM time_off_requests r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.status = 'PENDING'
      ORDER BY r.created_at DESC
      LIMIT 200
    `;
        const { rows } = await db.query(q, []);
        return res.json(rows);
    } catch (e: any) {
        return bad(res, 500, e?.message || 'query failed');
    }
});

/* -------------------- approve / reject -------------------- */

router.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const { decision, note } = req.body ?? {};
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) {
        return bad(res, 400, 'invalid id');
    }

    const DECISIONS = new Set(['APPROVED', 'REJECTED']);
    const next = String(decision || '').toUpperCase();
    if (!DECISIONS.has(next)) {
        return bad(res, 400, "decision must be 'APPROVED' or 'REJECTED'");
    }

    try {
        const q = `
      UPDATE time_off_requests
         SET status = $2,
             decision_note = COALESCE($3, decision_note),
             decided_at = now()
       WHERE id = $1
       RETURNING id
    `;
        const { rows } = await db.query(q, [id, next, note ?? null]);

        // Use rows.length (not rowCount) to satisfy TS in CI
        if (rows.length === 0) return bad(res, 404, 'not found');

        return res.json({ ok: true });
    } catch (e: any) {
        return bad(res, 500, e?.message || 'update failed');
    }
});

/* -------------------- calendar view -------------------- */

router.get('/calendar', async (req, res) => {
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return bad(res, 400, 'from/to (yyyy-mm-dd) required');
    }

    try {
        const q = `
      SELECT
        r.id,
        r.user_id,
        COALESCE(u.full_name, u.name, u.email) AS name,
        r.status,
        r.reason,
        r.dates
      FROM time_off_requests r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.status IN ('PENDING','APPROVED') -- show both; UI marks pending
        AND EXISTS (
          SELECT 1
          FROM unnest(r.dates) AS d
          WHERE d BETWEEN $1::date AND $2::date
        )
      ORDER BY COALESCE(u.full_name, u.name, u.email), r.created_at DESC
      LIMIT 1000
    `;
        const { rows } = await db.query(q, [from, to]);

        const entries = rows.map(r => ({
            id: r.id,
            userId: r.user_id,
            name: r.name,
            status: r.status,
            reason: r.reason,
            // return as UTC midnight ISO strings to match existing client behavior
            dates: (r.dates || []).map((d: string) => new Date(`${d}T00:00:00Z`).toISOString()),
        }));

        return res.json({ entries });
    } catch (e: any) {
        return bad(res, 500, e?.message || 'calendar failed');
    }
});

export default router;
