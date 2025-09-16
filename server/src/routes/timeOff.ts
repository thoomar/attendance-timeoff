import express, { Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../auth';

// --- tolerant import for your db module (default or named) ---
import * as dbmod from '../db';
const db: any = (dbmod as any).db ?? (dbmod as any).default ?? dbmod;

// --- tolerant import for your email module (default or named sendEmail) ---
import * as emailSvc from '../services/email';
const sendEmail: (args: { to: string[]; subject: string; html: string }) => Promise<any> =
    (emailSvc as any).sendEmail ?? (emailSvc as any).default;

import { buildNewRequestEmail, buildDecisionEmail } from '../services/emailTemplates';

const router = express.Router();

/** -------- Env / Config -------- */
const RAW_APPROVER_EMAILS = (process.env.APPROVER_EMAILS ?? process.env.HR_EMAILS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const approverEmails: string[] = Array.from(new Set(RAW_APPROVER_EMAILS));

const DEFAULT_MANAGER_USER_ID = process.env.DEFAULT_MANAGER_USER_ID || null;
const SITE_URL = process.env.SITE_URL || '';

/** -------- Schemas -------- */
const CreateReq = z.object({
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    reason: z.string().min(3),
});

const DecisionReq = z.object({
    id: z.string().uuid(),
    decision: z.enum(['APPROVED', 'REJECTED']),
});

/** -------- Types from auth -------- */
interface AuthedUser {
    id: string;
    email: string;
    fullName?: string;
    role?: 'Employee' | 'Manager' | 'HR' | string;
}

/** -------- Helpers -------- */
function getUser(req: Request): AuthedUser {
    const u = (req as any).user as AuthedUser | undefined;
    if (!u) throw new Error('Auth user missing. Ensure requireAuth is applied.');
    return u;
}

function assertApproversConfigured() {
    if (approverEmails.length === 0) {
        const err: any = new Error('No APPROVER_EMAILS/HR_EMAILS configured');
        err.status = 500;
        throw err;
    }
}

/** -------- Routes (relative paths; index.ts mounts at /api/time-off) -------- */

/**
 * POST /api/time-off/requests
 * Creates one row per selected date (uses the time_off_requests view -> v2 table).
 */
router.post('/requests', requireAuth, async (req: Request, res: Response) => {
    try {
        const { dates, reason } = CreateReq.parse(req.body);
        const user = getUser(req);
        assertApproversConfigured();

        // Insert one row per date
        const values: any[] = [];
        const params: string[] = [];
        let idx = 1;
        for (const d of dates) {
            values.push(user.id, d, reason, DEFAULT_MANAGER_USER_ID);
            params.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        }

        const insertSql = `
            INSERT INTO time_off_requests (employee_user_id, date, reason, manager_user_id)
            VALUES ${params.join(', ')}
                RETURNING id, employee_user_id, date, reason, status
        `;

        const { rows } = await db.query(insertSql, values);

        // Email HR/Approvers (best-effort)
        try {
            const subject = `Time-Off Request: ${user.fullName || user.email} (${dates[0]}${
                dates.length > 1 ? ` → ${dates[dates.length - 1]}` : ''
            })`;
            const html = buildNewRequestEmail({
                siteUrl: SITE_URL,
                employeeName: user.fullName || user.email,
                employeeEmail: user.email,
                reason,
                dates,
            });
            await sendEmail({ to: approverEmails, subject, html });
        } catch (err) {
            console.error('Failed sending approver email', err);
        }

        res.json({ ok: true, created: rows });
    } catch (err: any) {
        const status = err.status || 400;
        res.status(status).json({ ok: false, error: err.message || 'Invalid request' });
    }
});

/**
 * GET /api/time-off/pending
 * NEW: returns a FLAT list of pending items for approvers, each shaped:
 * { id, date, reason, full_name, email }
 * Non-approvers only see their own pending items in the same flat shape.
 */
router.get('/pending', requireAuth, async (req: Request, res: Response) => {
    try {
        const user = getUser(req);
        const isApprover = approverEmails.some(e => e.toLowerCase() === user.email.toLowerCase());

        const sql = isApprover
            ? `
                    SELECT
                        r.id,
                        r.date::text AS date,
           r.reason,
           COALESCE(u.full_name, u.email, 'Employee') AS full_name,
           u.email
                    FROM time_off_requests r
                        LEFT JOIN users u ON u.id = r.employee_user_id
                    WHERE r.status = 'PENDING'
                    ORDER BY r.date ASC
            `
            : `
                    SELECT
                        r.id,
                        r.date::text AS date,
           r.reason,
           COALESCE(u.full_name, u.email, 'Employee') AS full_name,
           u.email
                    FROM time_off_requests r
                        LEFT JOIN users u ON u.id = r.employee_user_id
                    WHERE r.employee_user_id = $1
                      AND r.status = 'PENDING'
                    ORDER BY r.date ASC
            `;

        const { rows } = await db.query(sql, isApprover ? [] : [user.id]);
        // rows already match desired shape
        res.json(rows as Array<{ id: string; date: string; reason: string; full_name: string; email: string | null }>);
    } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message || 'Failed to load pending' });
    }
});

/**
 * GET /api/time-off/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns entries aggregated by employee with a dates[] array and combined status.
 * Combined status: PENDING if any date in range is pending, else APPROVED.
 */
router.get('/calendar', requireAuth, async (req: Request, res: Response) => {
    try {
        const from = String(req.query.from || '').slice(0, 10);
        const to = String(req.query.to || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return res.status(400).json({ ok: false, error: 'from/to must be YYYY-MM-DD' });
        }

        const sql = `
            SELECT
                r.employee_user_id AS user_id,
                u.full_name         AS user_name,
                u.email             AS user_email,
                ARRAY_AGG(r.date::text ORDER BY r.date) AS dates,
                CASE WHEN BOOL_OR(r.status = 'PENDING') THEN 'PENDING' ELSE 'APPROVED' END AS status
            FROM time_off_requests r
                     LEFT JOIN users u ON u.id = r.employee_user_id
            WHERE r.date BETWEEN $1 AND $2
              AND r.status IN ('PENDING','APPROVED')
            GROUP BY r.employee_user_id, u.full_name, u.email
            ORDER BY COALESCE(u.full_name, u.email, r.employee_user_id::text)
        `;

        const { rows } = await db.query(sql, [from, to]);

        const entries = (rows as Array<any>).map(r => ({
            userId: r.user_id,
            userName: r.user_name || r.user_email || 'Employee',
            dates: r.dates as string[],
            status: r.status as 'PENDING' | 'APPROVED',
        }));

        return res.json({ entries });
    } catch (err: any) {
        console.error('calendar failed', err);
        return res.status(500).json({ ok: false, error: 'internal_error' });
    }
});

/**
 * POST /api/time-off/decision
 * Updates one row (specific date) and emails the employee.
 */
router.post('/decision', requireAuth, async (req: Request, res: Response) => {
    try {
        assertApproversConfigured();
        const user = getUser(req);
        const isApprover = approverEmails.some(e => e.toLowerCase() === user.email.toLowerCase());
        if (!isApprover) return res.status(403).json({ ok: false, error: 'Not an approver' });

        const { id, decision } = DecisionReq.parse(req.body);

        const updateSql = `
            UPDATE time_off_requests
            SET status = $1, decided_by = $2, decided_at = NOW()
            WHERE id = $3 AND status = 'PENDING'
                RETURNING id, employee_user_id, date, reason, status
        `;

        const { rows } = await db.query(updateSql, [decision, user.id, id]);
        if ((rows as Array<any>).length === 0) {
            return res.status(404).json({ ok: false, error: 'Not found or already decided' });
        }

        const row = (rows as Array<any>)[0];

        // Notify employee (best-effort)
        try {
            const emp = await db.query('SELECT full_name, email FROM users WHERE id = $1', [row.employee_user_id]);
            const employeeEmail = (emp.rows?.[0]?.email as string) || undefined;
            if (employeeEmail && typeof sendEmail === 'function') {
                const subject = `Your time-off request for ${new Date(row.date).toISOString().slice(0, 10)} was ${row.status.toLowerCase()}`;
                const html = buildDecisionEmail({
                    siteUrl: SITE_URL,
                    employeeName: emp.rows?.[0]?.full_name || employeeEmail,
                    date: new Date(row.date).toISOString().slice(0, 10),
                    decision: row.status,
                    reason: row.reason,
                });
                await sendEmail({ to: [employeeEmail], subject, html });
            }
        } catch (e) {
            console.error('Failed sending decision email', e);
        }

        res.json({ ok: true, updated: row });
    } catch (err: any) {
        const status = err.status || 400;
        res.status(status).json({ ok: false, error: err.message || 'Invalid request' });
    }
});

export default router;
