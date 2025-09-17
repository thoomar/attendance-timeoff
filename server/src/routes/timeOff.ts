// server/src/routes/timeOff.ts
import express, { Request, Response } from 'express';
import { z } from 'zod';
import * as db from '../db';                 // ✅ import module namespace; use db.query(...)
import { requireAuth } from '../auth';
import { sendEmail } from '../services/email';

const router = express.Router();

/** -------- Env / Config -------- */
const RAW_APPROVER_EMAILS =
    (process.env.APPROVER_EMAILS ?? process.env.HR_EMAILS ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

const approverEmails: string[] = Array.from(new Set(RAW_APPROVER_EMAILS));

/** -------- Schemas -------- */
const CreateReq = z.object({
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1), // 'YYYY-MM-DD'
    reason: z.string().min(3),
});

const DecisionReq = z.object({
    decision: z.enum(['APPROVED', 'DENIED']),
    note: z.string().optional(),
});

/** Utilities */
function asDate(s: string) {
    return new Date(`${s}T00:00:00.000Z`);
}

/** -------- Routes -------- */

// Create a request
router.post('/time-off', requireAuth, async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const body = CreateReq.parse(req.body);
        const dates = body.dates.map(asDate);

        const { rows } = await db.query(
            `
                INSERT INTO time_off_requests (user_id, dates, reason, status)
                VALUES ($1, $2::date[], $3, 'PENDING')
                    RETURNING id
            `,
            [user.id, dates, body.reason],
        );
        const id = rows[0]?.id as string;

        // notify HR alias + approvers
        const subject = `${user.fullName || user.email} submitted a time off request`;
        const summaryDates = body.dates.join(', ');
        const text =
            `${user.fullName || user.email} has submitted a time off request for ${summaryDates}\n` +
            `Reason: ${body.reason}`;
        const to = ['hr@republicfinancialservices.com', ...approverEmails];

        await sendEmail({
            // no `from` field — EmailMessage doesn't include it; default sender is used by mailer
            to,
            subject,
            text,
        }).catch(() => null);

        return res.json({ ok: true, id });
    } catch (e: any) {
        return res.status(400).json({ ok: false, error: e?.message || 'create failed' });
    }
});

// Pending list for approvers
router.get('/time-off/pending', requireAuth, async (_req: Request, res: Response) => {
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
        return res.json(rows);
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || 'pending failed' });
    }
});

// Approve / Deny
router.patch('/time-off/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        const body = DecisionReq.parse(req.body);

        const { rowCount } = await db.query(
            `
                UPDATE time_off_requests
                SET status = $2, decision_note = $3, decided_at = NOW()
                WHERE id = $1
            `,
            [id, body.decision, body.note ?? null],
        );

        if (!rowCount) return res.status(404).json({ ok: false, error: 'not found' });
        return res.json({ ok: true });
    } catch (e: any) {
        return res.status(400).json({ ok: false, error: e?.message || 'decision failed' });
    }
});

// Calendar (range)
router.get('/time-off/calendar', requireAuth, async (req: Request, res: Response) => {
    try {
        const from = (req.query.from as string) || new Date().toISOString().slice(0, 10);
        const to = (req.query.to as string) || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

        const { rows } = await db.query(
            `
                SELECT
                    r.id,
                    r.user_id,
                    u.full_name AS user_name,
                    u.email AS user_email,
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

        const entries = rows.map((r: any) => ({
            id: r.id,
            userId: r.user_id,
            name: r.user_name || r.user_email,
            status: r.status,
            reason: r.reason,
            dates: r.dates,
        }));

        return res.json({ entries });
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('calendar failed', e);
        return res.status(500).json({ ok: false, error: e?.message || 'calendar failed' });
    }
});

export default router;
