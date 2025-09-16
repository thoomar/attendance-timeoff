import nodemailer from 'nodemailer';

export type EmailMessage = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
};

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.office365.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ? true : false; // 587 -> false STARTTLS
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@republicfinancialservices.com';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  requireTLS: !SMTP_SECURE,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
});

function normalizeRecipients(to: string | string[]): string[] {
  const arr = Array.isArray(to) ? to : [to];
  return arr
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

export async function sendEmail(msg: EmailMessage) {
  const to = normalizeRecipients(msg.to);
  if (to.length === 0) {
    throw new Error('No valid recipient emails');
  }
  const from = msg.from || EMAIL_FROM;

  console.log(
    `[email] SMTP enabled host=${SMTP_HOST} port=${SMTP_PORT} secure=${SMTP_SECURE}`
  );
  console.log('[email] from=%s to=%s subject=%s', from, to.join(','), msg.subject);

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html
    });
    console.log('[email] sent', info.messageId);
    return info;
  } catch (err) {
    console.error('[email] sendMail failed:', err);
    throw err;
  }
}
