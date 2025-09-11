import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, requireRole } from '../auth';
import { sendTimeOffEmail } from '../services/email';
import { createCalendarEntry } from '../services/calendar';

const r = Router();

const CreateReq = z.object({
    dates: z.array(z.string()).min(1),
    reason: z.string().min(3).max(2000)
});

r.post('/', requireAuth, async (req, res) => {
    const parsed = CreateReq.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const { dates, reason } = parsed.data;

    if (['Manager','Admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Managers/Admins cannot file requests' });
    }

    // ensure manager exists
    const { rows: mgrs } = await query(
        'SELECT id, email, full_name FROM users WHERE id = $1',
        [req.user.managerUserId]
    );
    if (mgrs.length === 0) return res.status(400).json({ error: 'Manager not set for user' });

    const { rows } = await query(
        `
            INSERT INTO time_off_requests (requester_user_id, manager_user_id, dates, reason)
            VALUES ($1,$2,$3::date[],$4)
                RETURNING id, status
        `,
        [req.user.id, req.user.managerUserId, dates, reason]
    );

    await sendTimeOffEmail('NEW_REQUEST', { requestId: rows[0].id, requester: req.user.email });
    res.json(rows[0]);
});

r.get('/my', requireAuth, async (req, res) => {
    const { rows } = await query(
        `
            SELECT id, dates, reason, status, created_at
            FROM time_off_requests
            WHERE requester_user_id = $1
            ORDER BY created_at DESC
        `,
        [req.user.id]
    );
    res.json(rows);
});

r.get('/calendar', requireAuth, async (req, res) => {
    const { from, to } = req.query as any;
    const { rows } = await query(
        `
            SELECT tor.id, tor.dates, u.full_name, tor.reason, tor.status
            FROM time_off_requests tor
                     JOIN users u ON u.id = tor.requester_user_id
            WHERE EXISTS (
                SELECT 1 FROM unnest(tor.dates) d
                WHERE d BETWEEN $1::date AND $2::date
            ) AND tor.status = 'APPROVED'
        `,
        [from, to]
    );

    if (['Manager','Admin'].includes(req.user.role)) {
        return res.json({ entries: rows });
    }
    const redacted = rows.map((r: any) => ({
        dates: r.dates,
        initials: (r.full_name || '').split(' ').map((s: string) => s[0]).join('')
    }));
    res.json({ entries: redacted });
});

r.get('/pending', requireAuth, requireRole(['Manager','Admin']), async (req, res) => {
    const { rows } = await query(
        `
            SELECT tor.id, tor.dates, tor.reason, tor.created_at,
                   u.full_name AS employee_name, u.email AS employee_email
            FROM time_off_requests tor
                     JOIN users u ON u.id = tor.requester_user_id
            WHERE tor.manager_user_id = $1 AND tor.status = 'PENDING'
            ORDER BY tor.created_at ASC
        `,
        [req.user.id]
    );
    res.json(rows);
});

const DecisionReq = z.object({
    decision: z.enum(['APPROVED','REJECTED']),
    manager_comment: z.string().max(2000).optional()
});

r.patch('/:id/decision', requireAuth, requireRole(['Manager','Admin']), async (req, res) => {
    const parsed = DecisionReq.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const { id } = req.params;
    const { decision, manager_comment } = parsed.data;

    const { rows } = await query(
        `
            UPDATE time_off_requests
            SET status = $1, manager_comment = $2, decided_at = now()
            WHERE id = $3 AND manager_user_id = $4 AND status = 'PENDING'
                RETURNING *
        `,
        [decision, manager_comment ?? null, id, req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Not found or not pending' });
    const tor = rows[0];

    if (decision === 'APPROVED') {
        const dates: string[] = tor.dates;
        const min = dates.reduce((a,b)=> a < b ? a : b);
        const max = dates.reduce((a,b)=> a > b ? a : b);
        await createCalendarEntry({
            requestId: tor.id,
            startDate: min,
            endDate: max,
            summary: `${tor.requester_user_id} PTO`
        });
        await sendTimeOffEmail('APPROVED', { tor });
    } else {
        await sendTimeOffEmail('REJECTED', { tor });
    }
    res.json({ id: tor.id, status: tor.status });
});

export default r;
