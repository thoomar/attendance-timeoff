// server/src/routes/timeOff.ts
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import * as db from '../db';
import { sendEmail } from '../services/email';

const router = express.Router();

/* ===========================
   Config / Helpers
   =========================== */

const approverEmails: string[] = Array.from(
    new Set(
        String(process.env.APPROVER_EMAILS || process.env.HR_EMAILS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    ),
);

const HR_ALIAS = process.env.HR_ALIAS || 'hr@republicfinancialservices.com';

const CreateReq = z.object({
    // Expect array of YYYY-MM-DD strings
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    reason: z.string().min(3),
});

const DecisionReq = z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().max(2000).optional(),
});

// Parse YYYY-MM-DD (kept as string for SQL $2::date[] input)
const asDate = (d: string) => d;

/* ===========================
   Routes
   Mounted at /api/time-off (see src/index.ts)
   =========================== */

router.get('/_ping', (_req, res) => {
    res.json({ ok: true, route: 'time-off' });
});

/**
 * Create a request
 * POST /api/time-off
 * POST /api/time-off/requests
 * POST /api/time-off/request   (alias for convenience)
 */
router.post(['/', '/requests', '/request'], requireAuth, async (req: Request, res: Response) => {
    try {
        const user = (req as any).user as { id: string; email?: string | null; fullName?: string | null };
        const body = CreateReq.parse(req.body);
        const dates = body.dates.map(asDate);

        const { rows } = await (db as any).query(
            `
                INSERT INTO time_off_requests (user_id, dates, reason, status, created_at, updated_at)
                VALUES ($1, $2::date[], $3, 'PENDING', now(), now())
                    RETURNING id
            `,
            [user.id, dates, body.reason],
        );

        const id = rows?.[0]?.id as string | undefined;

        // Notify HR alias + approvers (best-effort)
        const subject = `${user.fullName || user.email || 'Employee'} submitted a time off request`;
        const summaryDates = body.dates.join(', ');
        const text =
            `${user.fullName || user.email || 'Employee'} has submitted a time off request for ${summaryDates}\n` +
            `Reason: ${body.reason}`;
        const to = [HR_ALIAS, ...approverEmails];
        try {
            await sendEmail({ to, subject, text });
        } catch {
            // swallow email errors so request creation still succeeds
        }

        return res.json({ ok: true, id });
    } catch (e: any) {
        return res.status(400).json({ ok: false, error: e?.message || 'create failed' });
    }
});

/**
 * Get my requests (current authed user)
 * GET /api/time-off/mine
 */
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
    try {
        const user = (req as any).user as { id: string };
        const { rows } = await (db as any).query(
            `
                SELECT r.id, r.user_id, r.dates, r.reason, r.status, r.created_at,
                       u.full_name AS user_name, u.email AS user_email
                FROM time_off_requests r
                         LEFT JOIN users u ON u.id = r.user_id
                WHERE r.user_id = $1
                ORDER BY r.created_at DESC
            `,
            [user.id],
        );
        return res.json({ ok: true, items: rows });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || 'mine failed' });
    }
});

/**
 * Pending list for approvers
 * GET /api/time-off/pending
 *
 * (Currently requires auth only; if you want Manager/Admin-only, we can add a role gate.)
 */
router.get('/pending', requireAuth, async (_req: Request, res: Response) => {
    try {
        const { rows } = await (db as any).query(
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
        return res.json(rows);
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || 'pending failed' });
    }
});

/**
 * Approve / Reject (primary)
 * PATCH /api/time-off/:id
 * Body: { decision: "APPROVED" | "REJECTED", note?: string }
 */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        const body = DecisionReq.parse(req.body);

        const { rows } = await (db as any).query(
            `
                UPDATE time_off_requests
                SET status = $2,
                    decision_note = $3,
                    decided_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                    RETURNING id
            `,
            [id, body.decision, body.note ?? null],
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'not found' });
        }
        return res.json({ ok: true });
    } catch (e: any) {
        return res.status(400).json({ ok: false, error: e?.message || 'decision failed' });
    }
});

/**
 * Approve / Reject (alias for convenience, same body as PATCH)
 * POST /api/time-off/:id/decision
 */
router.post('/:id/decision', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        const body = DecisionReq.parse(req.body);

        const { rows } = await (db as any).query(
            `
                UPDATE time_off_requests
                SET status = $2,
                    decision_note = $3,
                    decided_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                    RETURNING id
            `,
            [id, body.decision, body.note ?? null],
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'not found' });
        }
        return res.json({ ok: true });
    } catch (e: any) {
        return res.status(400).json({ ok: false, error: e?.message || 'decision failed' });
    }
});

/**
 * Calendar (range)
 * GET /api/time-off/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Defaults: from=today, to=+30 days
 */
router.get('/calendar', requireAuth, async (req: Request, res: Response) => {
    try {
        const from = (req.query.from as string) || new Date().toISOString().slice(0, 10);
        const to =
            (req.query.to as string) ||
            new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

        const { rows } = await (db as any).query(
            `
                SELECT
                    r.id,
                    r.user_id,
                    u.full_name AS user_name,
                    u.email     AS user_email,
                    r.dates,
                    r.status,
                    r.reason
                FROM time_off_requests r
                         LEFT JOIN users u ON u.id = r.user_id
                WHERE EXISTS (
                    SELECT 1
                    FROM unnest(r.dates) AS d(actual)
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
            reason: r.reason,
            dates: r.dates as string[],
        }));

        return res.json({ entries });
    } catch (e: any) {
        console.error('calendar failed', e);
        return res.status(500).json({ ok: false, error: e?.message || 'calendar failed' });
    }
});

export default router;
