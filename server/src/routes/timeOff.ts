// /opt/attendance-timeoff/server/src/routes/timeOff.ts
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { db } from '../db';
import { sendEmail } from '../services/email';
import * as templates from '../services/templates';

const router = express.Router();

/** -------- Env / Config -------- */
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@republicfinancialservices.com';

const parseCsv = (v?: string) =>
  (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const hrEmails: string[] = (() => {
  const arr = parseCsv(process.env.HR_EMAILS);
  return arr.length ? arr : ['hr@republicfinancialservices.com'];
})();

const approverEmails: string[] = Array.from(new Set(parseCsv(process.env.APPROVER_EMAILS)));

/** -------- Schemas -------- */
const CreateReq = z.object({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1), // YYYY-MM-DD
  reason: z.string().min(3)
});

/** -------- Routes -------- */

// GET /api/time-off/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/calendar', requireAuth, async (req: Request, res: Response) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  try {
    const params: any[] = [];
    const where: string[] = [];

    if (from) {
      params.push(from);
      where.push(`d >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`d <= $${params.length}`);
    }

    // Flatten the date arrays from rows into individual days for easy coloring on the calendar UI
    const sql = `
      with rows as (
        select r.id, r.user_id, r.dates, r.reason, r.status, u.full_name, u.email
        from time_off_requests r
        join users u on u.id = r.user_id
      ),
      expanded as (
        select id, user_id, unnest(dates)::date as d, reason, status, full_name, email
        from rows
      )
      select id, user_id, d as date, reason, status, full_name as "fullName", email
      from expanded
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by d desc
      limit 2000
    `;
    const result = await db.query(sql, params);

    return res.json({ ok: true, items: result.rows });
  } catch (err: any) {
    console.error('[timeOff] calendar failed:', err);
    return res.status(500).json({ ok: false, error: 'failed_to_load_calendar' });
  }
});

// POST /api/time-off
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = CreateReq.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const { dates, reason } = parsed.data;

  // @ts-ignore set by requireAuth
  const user = req.user as { id: string; fullName: string; email: string };

  try {
    // Persist
    const result = await db.query(
      `
        INSERT INTO time_off_requests (user_id, dates, reason, status)
        VALUES ($1, $2::date[], $3, 'PENDING')
        RETURNING id
      `,
      [user.id, dates, reason]
    );
    const inserted = result.rows[0] as { id: string };

    // Emails
    const createdTpl = templates.makeRequestCreatedEmail({ user, dates, reason });
    const approverTpl = templates.makeRequestApproverEmail({ user, dates, reason, requestId: inserted.id });

    // HR notice
    try {
      await sendEmail({
        from: EMAIL_FROM,
        to: hrEmails,
        subject: createdTpl.subject,
        text: createdTpl.text,
        html: createdTpl.html
      });
    } catch (err) {
      console.error('[timeOff] HR email send failed:', err);
    }

    // Approver notice(s)
    if (approverEmails.length > 0) {
      try {
        await sendEmail({
          from: EMAIL_FROM,
          to: approverEmails,
          subject: approverTpl.subject,
          text: approverTpl.text,
          html: approverTpl.html
        });
      } catch (err) {
        console.error('[timeOff] approver email send failed:', err);
      }
    }

    // Content-negotiation: HTML form vs JSON
    const accept = (req.get('accept') || '').toLowerCase();
    const wantsHtml = accept.includes('text/html') && !accept.includes('application/json');

    if (wantsHtml) {
      return res.redirect(303, '/time-off/sent.html');
    }

    return res.status(201).json({ id: inserted.id, ok: true });
  } catch (err: any) {
    console.error('[timeOff] create failed:', err);

    const accept = (req.get('accept') || '').toLowerCase();
    const wantsHtml = accept.includes('text/html') && !accept.includes('application/json');

    if (wantsHtml) {
      const msg = encodeURIComponent('Failed to create request');
      return res.redirect(303, `/time-off/sent.html?error=${msg}`);
    }

    return res.status(500).json({ error: 'Failed to create request' });
  }
});

export default router;
