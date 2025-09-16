// server/src/services/email.ts
import nodemailer from 'nodemailer';

const host = process.env.SMTP_HOST || 'smtp.office365.com';
const port = Number(process.env.SMTP_PORT || 587);
const secure = String(process.env.SMTP_SECURE || 'false') === 'true'; // O365 on 587 => false
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';

// IMPORTANT: From must match the authenticated mailbox (or an alias with Send As delegated)
const fromEmail = process.env.FROM_EMAIL || user;
// Where replies should go (often an HR alias/distribution list)
const replyTo = process.env.REPLY_TO || process.env.HR_EMAILS || fromEmail;

if (!user || !pass) {
  throw new Error('SMTP_USER and SMTP_PASS are required for email transport.');
}

export const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
  // O365 tends to like keepAlive for bursts
  keepAlive: true,
});

export async function sendMail(opts: {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
}) {
  const toList = Array.isArray(opts.to)
    ? opts.to
    : String(opts.to).split(',').map(s => s.trim()).filter(Boolean);

  const ccList = typeof opts.cc === 'string'
    ? opts.cc.split(',').map(s => s.trim()).filter(Boolean)
    : (opts.cc || undefined);

  const bccList = typeof opts.bcc === 'string'
    ? opts.bcc.split(',').map(s => s.trim()).filter(Boolean)
    : (opts.bcc || undefined);

  return transporter.sendMail({
    from: fromEmail, // DO NOT override this elsewhere unless you have SendAs rights
    to: toList,
    cc: ccList,
    bcc: bccList,
    subject: opts.subject,
    replyTo,
    html: opts.html,
    text: opts.text,
  });
}
