import express, { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';

/**
 * If you are using the v2 physical table, create a compatibility view so the SQL below works unchanged:
 *
 *   create or replace view time_off_requests as
 *   select
 *     id,
 *     requester_user_id as employee_user_id,
 *     request_date       as date,
 *     status,
 *     reason
 *   from time_off_requests_v2;
 *
 * Then set TIME_OFF_TABLE=time_off_requests (the view).
 */

// --- tolerant import for your db module (supports named/default) ---
import * as dbmod from '../db';
const dbQuery: (sql: string, params?: any[]) => Promise<{ rows: any[] }> =
    (dbmod as any).query ?? ((dbmod as any).default?.query?.bind((dbmod as any).default));

// --- tolerant import for your email module (supports named/default) ---
import * as emailSvc from '../services/email';
const sendEmail: (args: { to: string[]; subject: string; html: string; text?: string }) => Promise<any> =
    (emailSvc as any).sendEmail ?? (emailSvc as any).default;

import { buildNewRequestEmail, buildDecisionEmail } from '../services/emailTemplates';

const router = express.Router();

/** -------- Env / Config -------- */
const TABLE = process.env.TIME_OFF_TABLE || 'time_off_requests';

const RAW_APPROVER_EMAILS = (process.env.APPROVER_EMAILS ?? process.env.HR_EMAILS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const approverEmails: string[] = Array.from(new Set(RAW_APPROVER_EMAILS));

// Prefer APP_BASE_URL, fall back to SITE_URL
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.SITE_URL || '';

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

/** -------- Routes (mounted at /api/time-off) -------- */

/**
 * POST /api/time-off/requests
 * Creates one row per selected date.
 * Works with:
 *  - v1 table (employee_user_id, date, reason, status)
 *  - a v2 compatibility view mapping requester_user_id→employee_user_id, request_date→date
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
            values.push(user.id, d, reason);
            params.push(`($${idx++}, $${idx++}, $${idx++})`);
        }

        const insertSql = `
            INSERT INTO ${TABLE} (employee_user_id, date, reason)
            VALUES ${params.join(', ')}
                RETURNING id, employee_user_id, date, reason, status
        `;

        const { rows } = await dbQuery(insertSql, values);

        // Email HR/Approvers (best-effort)
        try {
            const subject = `Time-Off Request: ${user.fullName || user.email} (${dates[0]}${
                dates.length > 1 ? ` → ${dates[dates.length - 1]}` : ''
            })`;
            const html = buildNewRequestEmail({
                siteUrl: APP_BASE_URL,
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
 * If requester is an approver (email matches APPROVER_EMAILS/HR_EMAILS), return all pending.
 * Otherwise, only this user’s pending rows.
 */
router.get('/pending', requireAuth, async (req: Request, res: Response) => {
    try {
        const user = getUser(req);
        const isApprover = approverEmails.some(e => e.toLowerCase() === user.email.toLowerCase());

        const sql = isApprover
            ? `SELECT r.id, r.employee_user_id, r.date, r.reason, r.status, u.full_name, u.email
               FROM ${TABLE} r
                        LEFT JOIN users u ON u.id = r.employee_user_id
               WHERE r.status = 'PENDING'
               ORDER BY r.date ASC`
            : `SELECT r.id, r.employee_user_id, r.date, r.reason, r.status
               FROM ${TABLE} r
               WHERE r.employee_user_id = $1 AND r.status = 'PENDING'
               ORDER BY r.date ASC`;

        const { rows } = await dbQuery(sql, isApprover ? [] : [user.id]);
        res.json(
            groupRows(
                rows as Array<{
                    id: string;
                    employee_user_id: string;
                    date: string;
                    reason: string;
                    status: string;
                    full_name?: string | null;
                    email?: string | null;
                }>,
            ),
        );
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
            FROM ${TABLE} r
                     LEFT JOIN users u ON u.id = r.employee_user_id
            WHERE r.date BETWEEN $1 AND $2
              AND r.status IN ('PENDING','APPROVED')
            GROUP BY r.employee_user_id, u.full_name, u.email
            ORDER BY COALESCE(u.full_name, u.email, r.employee_user_id::text)
        `;

        const { rows } = await dbQuery(sql, [from, to]);

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
 * Note: We only update status + decided_at to stay compatible with both v1 and a v2 view.
 */
router.post('/decision', requireAuth, async (req: Request, res: Response) => {
    try {
        assertApproversConfigured();
        const user = getUser(req);
        const isApprover = approverEmails.some(e => e.toLowerCase() === user.email.toLowerCase());
        if (!isApprover) return res.status(403).json({ ok: false, error: 'Not an approver' });

        const { id, decision } = DecisionReq.parse(req.body);

        const updateSql = `
            UPDATE ${TABLE}
            SET status = $1, decided_at = NOW()
            WHERE id = $2 AND status = 'PENDING'
                RETURNING id, employee_user_id, date, reason, status
        `;

        const { rows } = await dbQuery(updateSql, [decision, id]);
        if ((rows as Array<any>).length === 0) {
            return res.status(404).json({ ok: false, error: 'Not found or already decided' });
        }

        const row = (rows as Array<any>)[0];

        // Notify employee (best-effort)
        try {
            const emp = await dbQuery('SELECT full_name, email FROM users WHERE id = $1', [row.employee_user_id]);
            const employeeEmail = (emp.rows?.[0]?.email as string) || undefined;
            if (employeeEmail && typeof sendEmail === 'function') {
                const subject = `Your time-off request for ${row.date} was ${row.status.toLowerCase()}`;
                const html = buildDecisionEmail({
                    siteUrl: APP_BASE_URL,
                    employeeName: emp.rows?.[0]?.full_name || employeeEmail,
                    date: row.date,
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

/** -------- grouping helper for /pending -------- */
function groupRows(rows: Array<{ id: string; employee_user_id: string; date: string; reason: string }>) {
    type K = string;
    const byEmp = new Map<K, Array<{ id: string; date: string; reason: string }>>();
    for (const r of rows) {
        const k = r.employee_user_id;
        if (!byEmp.has(k)) byEmp.set(k, []);
        byEmp.get(k)!.push({ id: r.id, date: r.date, reason: r.reason });
    }
    const out: Array<{ employee_user_id: string; start: string; end: string; reason: string; ids: string[] }> = [];
    for (const [emp, list] of byEmp) {
        list.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        let cur: { employee_user_id: string; start: string; end: string; reason: string; ids: string[] } | null = null;
        for (const r of list) {
            if (!cur) {
                cur = { employee_user_id: emp, start: r.date, end: r.date, reason: r.reason, ids: [r.id] };
                continue;
            }
            const prev = new Date(cur.end);
            const next = new Date(r.date);
            const diffDays = (next.getTime() - prev.getTime()) / (24 * 3600 * 1000);
            if (diffDays === 1 && r.reason === cur.reason) {
                cur.end = r.date;
                cur!.ids.push(r.id);
            } else {
                out.push(cur);
                cur = { employee_user_id: emp, start: r.date, end: r.date, reason: r.reason, ids: [r.id] };
            }
        }
        if (cur) out.push(cur);
    }
    return out;
}
