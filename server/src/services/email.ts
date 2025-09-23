// src/services/email.ts
import nodemailer from 'nodemailer';

const mode = (process.env.EMAIL_MODE || 'smtp').toLowerCase();
const host = process.env.SMTP_HOST || '';
const port = Number(process.env.SMTP_PORT || (host ? 587 : 0));
const secure =
    String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ? true : (port === 465);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const fromEmail = process.env.MAIL_FROM || process.env.FROM_EMAIL || 'no-reply@timesharehelpcenter.com';

const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: { ciphers: 'TLSv1.2' }, // Office365 is strict
});

export type EmailMessage = {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    from?: string;
};

export async function sendEmail(msg: EmailMessage) {
    if (mode !== 'smtp' || !host) {
        console.warn('[email] SMTP not configured; skipping send to', msg.to);
        return { accepted: [], rejected: Array.isArray(msg.to) ? msg.to : [msg.to] };
    }
    return transporter.sendMail({ from: fromEmail, ...msg });
}
