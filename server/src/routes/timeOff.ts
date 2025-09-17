// server/src/routes/timeOff.ts
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { db } from '../db';
import { sendEmail } from '../services/email';

const router = express.Router();

/* ===========================
   Auth helpers
   =========================== */

const requireManagerOrAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any)?.user?.role as string | undefined;
    if (role === 'Manager' || role === 'Admin') return next();
    return res.status(403).json({ ok: false, error: 'Managers or Admins only.' });
};

/* ===========================
   Config
   =========================== */

const RAW_APPROVER_EMAILS =
    (process.env.APPROVER_EMAILS ?? process.env.HR_EMAILS ?? '')
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => Boolean(s));

/**
 * Final approver list (deduped). You mentioned:
 * sam@, zaid@, freddie@, donald@
 * Put them in APPPROVER_EMAILS env (comma-separated) in prod/CI.
 */
const approverEmails: string[] = Array.from(new Set(RAW_APPROVER_EMAILS));

/**
 * HR alias to notify on each new submission.
 * Default to your alias if env not set.
 */
const HR_ALIAS = process.env.HR_ALIAS ?? 'hr@republicfinancialservices.com';

/**
 * Optional default manager_user_id column value if your schema requires it.
 * Otherwise leave null and the INSERT will pass null.
 */
const DEFAULT_MANAGER_USER_ID = process.env.DEFAULT_MANAGER_USER_ID || null;

/* ===========================
   Schemas
   =========================== */

const CreateReq = z.object({
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1), // 'YYYY-MM-DD'
    reason: z.string().min(3)
});

const DecisionReq = z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    // Optional note to the employee (not persisted here unless you add a column)
    note: z.string().max(2000).optional()
});

/* ===========================
   Email helpers
   =========================== */

function htmlEscape(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderSubmittedEmail(user: { fullName?: string | null; email?: string | null }, dates: string[], reason: string): string {
    const name = user.fullName || user.email || 'An employee';
    const datesList = dates.map(d => `<li>${htmlEscape(d)}</li>`).join('');
    return `
    <div>
      <p><strong>${htmlEscape(name)}</strong> has submitted a time off request for:</p>
      <ul>${datesList}</ul>
      <p><strong>Reason:</strong> ${htmlEscape(reason)}</p>
    </div>
  `;
}

function renderApproverEmail(user: { fullName?: string | null; email?: string | null }, dates: string[], reason: string): string {
    const name = user.fullName || user.email || 'Employee';
    const datesStr = dates.join(', ');
    return `
    <div>
      <p>New time off request submitted.</p>
      <p><strong>Employee:</strong> ${htmlEscape(name)}</p>
      <p><strong>Dates:</strong> ${htmlEscape(datesStr)}</p>
      <p><strong>Reason:</strong> ${htmlEscape(reason)}</p>
      <p>Please review in the Time Off dashboard.</p>
    </div>
  `;
}

function renderDecisionEmail(
    user: { fullName?: string | null; email?: string | null },
    decision: 'APPROVED' | 'REJECTED',
    date: string,
    note?: string
): string {
    const status = decision === 'APPROVED' ? 'approved' : 'rejected';
    const noteHtml = note ? `<p><strong>Note from manager:</strong> ${htmlEscape(note)}</p>` : '';
    return `
    <div>
      <p>Your time off request for <strong>${htmlEscape(date)}</strong> was <strong>${status.toUpperCase()}</strong>.</p>
      ${noteHtml}
    </div>
  `;
}

/* ===========================
   Routes
   =========================== */

/**
 * Create a time off request (one row per date)
 * - Notifies HR alias
 * - Notifies approvers list
 */
router.post('/time-off/request', requireAuth, async (req: Request, res: Response) => {
    const parse = CreateReq.safeParse(req.body);
    if (!parse.success) {
        return res.status(400).json({ ok: false, error: parse.error.flatten() });
    }

    const { dates, reason } = parse.data;
    const authed = (req as any).user as {
        id: string;
        email?: string | null;
        fullName?: string | null;
        role?: string;
    };

    try {
        // Insert one row per date
        const insertedRows: Array<{ id: string; date: string }> = [];
        for (const day of dates) {
            const q = `
        INSERT INTO time_off_requests (employee_user_id, date, reason, status, manager_user_id)
        VALUES ($1, $2::date, $3, 'PENDING', $4)
        RETURNING id, date::text
      `;
            const params = [authed.id, day, reason, DEFAULT_MANAGER_USER_ID];
            const { rows } = await db.query<{ id: string; date: string }>(q, params);
            if (rows?.[0]) insertedRows.push(rows[0]);
        }

        // Send HR notification (single email covering all dates)
        const hrHtml = renderSubmittedEmail(authed, dates, reason);
        await sendEmail({
            to: [HR_ALIAS],
            subject: `${authed.fullName || authed.email || 'Employee'} submitted time off (${dates.join(', ')})`,
            html: hrHtml
        });

        // Send approver notifications (one email to the group)
        if (approverEmails.length > 0) {
            const approverHtml = renderApproverEmail(authed, dates, reason);
            await sendEmail({
                to: approverEmails,
                subject: `Time off request: ${authed.fullName || authed.email || 'Employee'} (${dates.join(', ')})`,
                html: approverHtml
            });
        }

        return res.json({
            ok: true,
            created: insertedRows
        });
    } catch (e: any) {
        console.error('Create time off error:', e);
        return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

/**
 * Get my requests (all statuses)
 */
router.get('/time-off/mine', requireAuth, async (req: Request, res: Response) => {
    const authed = (req as any).user as { id: string };
    try {
        const q = `
      SELECT id, employee_user_id, date::text AS date, reason, status, created_at
      FROM time_off_requests
      WHERE employee_user_id = $1
      ORDER BY date ASC, created_at ASC
    `;
        const { rows } = await db.query(q, [authed.id]);
        return res.json({ ok: true, items: rows ?? [] });
    } catch (e: any) {
        console.error('Mine error:', e);
        return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

/**
 * Pending requests (manager/admin)
 * Returns a flat list of pending items with basic employee info if available.
 */
router.get('/time-off/pending', requireAuth, requireManagerOrAdmin, async (_req: Request, res: Response) => {
    try {
        const q = `
      SELECT
        r.id,
        r.employee_user_id,
        COALESCE(u.full_name, u.email) AS employee_label,
        r.date::text AS date,
        r.reason,
        r.status,
        r.created_at
      FROM time_off_requests r
      LEFT JOIN users u ON u.id = r.employee_user_id
      WHERE r.status = 'PENDING'
      ORDER BY r.date ASC, r.created_at ASC
    `;
        const { rows } = await db.query(q);
        return res.json({ ok: true, items: rows ?? [] });
    } catch (e: any) {
        console.error('Pending error:', e);
        return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

/**
 * Approve/Reject a single request row by id
 */
router.post('/time-off/:id/decision', requireAuth, requireManagerOrAdmin, async (req: Request, res: Response) => {
    const parse = DecisionReq.safeParse(req.body);
    if (!parse.success) {
        return res.status(400).json({ ok: false, error: parse.error.flatten() });
    }
    const { decision, note } = parse.data;

    const id = req.params.id;
    if (!id) {
        return res.status(400).json({ ok: false, error: 'Missing id param' });
    }

    try {
        // Update the request
        const upQ = `
      UPDATE time_off_requests
      SET status = $1
      WHERE id = $2
      RETURNING id, employee_user_id, date::text AS date, reason, status
    `;
        const { rows } = await db.query<{
            id: string;
            employee_user_id: string;
            date: string;
            reason: string;
            status: 'APPROVED' | 'REJECTED' | 'PENDING';
        }>(upQ, [decision, id]);

        const updated = rows?.[0];
        if (!updated) {
            return res.status(404).json({ ok: false, error: 'Request not found' });
        }

        // Get employee email/name to notify
        const uQ = `SELECT full_name, email FROM users WHERE id = $1`;
        const uRes = await db.query<{ full_name: string | null; email: string | null }>(uQ, [updated.employee_user_id]);
        const user = uRes.rows?.[0] ?? { full_name: null, email: null };

        const targetEmail = user.email;
        if (targetEmail) {
            const html = renderDecisionEmail({ fullName: user.full_name, email: user.email }, decision, updated.date, note);
            await sendEmail({
                to: [targetEmail],
                subject: `Your time off request for ${updated.date} was ${decision}`,
                html
            });
        }

        return res.json({ ok: true, item: updated });
    } catch (e: any) {
        console.error('Decision error:', e);
        return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

/**
 * Calendar view (approved + pending) in a date window.
 * Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
 */
router.get('/time-off/calendar', requireAuth, async (req: Request, res: Response) => {
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ ok: false, error: 'from/to must be YYYY-MM-DD' });
    }

    try {
        const q = `
      SELECT
        r.employee_user_id,
        COALESCE(u.full_name, u.email, r.employee_user_id::text) AS user_name,
        json_agg(json_build_object(
          'date', r.date::text,
          'status', r.status,
          'reason', r.reason,
          'id', r.id
        ) ORDER BY r.date ASC) AS days
      FROM time_off_requests r
      LEFT JOIN users u ON u.id = r.employee_user_id
      WHERE r.date >= $1::date
        AND r.date <= $2::date
      GROUP BY r.employee_user_id, u.full_name, u.email
      ORDER BY COALESCE(u.full_name, u.email, r.employee_user_id::text)
    `;
        const { rows } = await db.query(q, [from, to]);

        // Normalize for client
        const entries = (rows ?? []).map((row: any) => ({
            userId: row.employee_user_id,
            userName: row.user_name,
            dates: (row.days as Array<{ date: string }>).map((d) => d.date),
            statusByDate: row.days as Array<{ date: string; status: string; reason: string; id: string }>
        }));

        return res.json({ ok: true, entries });
    } catch (e: any) {
        console.error('Calendar error:', e);
        return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

/* ===========================
   Export
   =========================== */
export default router;
