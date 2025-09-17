// /opt/attendance-timeoff/server/src/routes/timeOff.ts
import express, { Request, Response } from 'express';
import { z } from 'zod';
import * as db from '../db';
import { requireAuth } from '../auth';
import { sendEmail } from '../services/email';

const router = express.Router();

console.log('TIMEOFF ROUTE BUILD TAG', new Date().toISOString(), __filename);

/** Env */
const RAW_APPROVER_EMAILS =
    (process.env.APPROVER_EMAILS ?? process.env.HR_EMAILS ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
const approverEmails = Array.from(new Set(RAW_APPROVER_EMAILS));

/** Schemas */
const CreateReq = z.object({
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    reason: z.string().min(3),
});
const DecisionReq = z.object({
    decision: z.enum(['APPROVED', 'DENIED']),
    note: z.string().optional(),
});
const asDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Health */
router.get('/_ping', (_req, res) => res.json({ ok: true, route: 'time-off' }));

/** Create (POST /api/time-off) */
router.post('/', requireAuth, async (req, res) => {
    try {
        const user = (req as any).user;
        const body = CreateReq.parse(req.body);
        const dates = body.dates.map(asDate);

        const { rows } = await db.query(
            `
      INSERT INTO time_off_requests (user_id, dates, reason, status, created_at, updated_at)
      VALUES ($1, $2::date[], $3, 'PENDING', now(), now())
      RETURNING id
      `,
            [user.id, dates, body.reason],
        );
        const id = rows[0]?.id as string;

        const subject = `${user.fullName || user.email} submitted a time off request`;
        const summaryDates = body.dates.join(', ');
        const text =
            `${user.fullName || user.email} has submitted a time off request for ${summaryDates}\n` +
            `Reason: ${body.reason}`;
        const to = ['hr@republicfinancialservices.com', ...approverEmails];
        await sendEmail({ to, subject, text }).catch(() => null);

        res.json({ ok: true, id });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: e?.message || 'create failed' });
    }
});

/** Pending (GET /api/time-off/pending) */
router.get('/pending', requireAuth, async (_req, res) => {
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
        res.json(rows);
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'pending failed' });
    }
});

/** Decision (PATCH /api/time-off/:id) */
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const id = req.params.id;
        const body = DecisionReq.parse(req.body);
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
            [id, body.decision, body.note ?? null],
        );
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'not found' });
        res.json({ ok: true });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: e?.message || 'decision failed' });
    }
});

/** Calendar (GET /api/time-off/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD) */
router.get('/calendar', requireAuth, async (req, res) => {
    try {
        const from = (req.query.from as string) || new Date().toISOString().slice(0, 10);
        const to = (req.query.to as string) || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

        const { rows } = await db.query(
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

        const entries = rows.map((r: any) => ({
            id: r.id,
            userId: r.user_id,
            name: r.user_name || r.user_email,
            status: r.status,
            reason: r.reason,
            dates: r.dates,
        }));
        res.json({ entries });
    } catch (e: any) {
        console.error('calendar failed', e);
        res.status(500).json({ ok: false, error: e?.message || 'calendar failed' });
    }
});

export default router;
