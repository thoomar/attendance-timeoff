// src/services/email.ts
import nodemailer from 'nodemailer';

const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const fromEmail = process.env.FROM_EMAIL || 'no-reply@timesharehelpcenter.com';

const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
});

export type EmailMessage = {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
};

export async function sendEmail(msg: EmailMessage) {
    if (!smtpHost) {
        // Safe no-op in CI or dev
        console.warn('sendEmail: SMTP not configured; skipping send');
        return { accepted: [], rejected: [msg.to] };
    }
    return transporter.sendMail({ from: fromEmail, ...msg });
}
