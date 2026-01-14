import { sendEmail } from './email';
import nodemailer from 'nodemailer';

const CALENDAR_RECIPIENT = process.env.CALENDAR_RECIPIENT || 'freddie@republicfinancialservices.com';

export interface CalendarInviteData {
    requestId: string;
    employeeName: string;
    employeeEmail: string;
    dates: string[]; // 'YYYY-MM-DD' format
    reason: string;
}

function generateUID(requestId: string): string {
    return `timeoff-${requestId}@timesharehelpcenter.com`;
}

function normalizeDate(dateInput: string | Date): string {
    // Convert Date object or string to 'YYYY-MM-DD' format
    if (dateInput instanceof Date) {
        const year = dateInput.getFullYear();
        const month = String(dateInput.getMonth() + 1).padStart(2, '0');
        const day = String(dateInput.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    // If it's already a string, ensure it's in the right format
    const dateStr = String(dateInput);
    if (dateStr.includes('T')) {
        return dateStr.split('T')[0];
    }
    return dateStr;
}

function formatDateForICS(dateInput: string | Date, allDay: boolean = true): string {
    const dateStr = normalizeDate(dateInput);
    const [year, month, day] = dateStr.split('-');
    if (allDay) {
        return `${year}${month}${day}`;
    }
    return `${year}${month}${day}T000000Z`;
}

function addDays(dateInput: string | Date, days: number): string {
    const dateStr = normalizeDate(dateInput);
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function generateICSContent(data: CalendarInviteData): string {
    const { requestId, employeeName, dates, reason } = data;
    const uid = generateUID(requestId);
    const now = new Date();
    const dtstamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    
    // Normalize and sort dates
    const normalizedDates = dates.map(d => normalizeDate(d)).sort();
    const startDate = normalizedDates[0];
    const endDate = normalizedDates[normalizedDates.length - 1];
    
    // For all-day events, DTEND should be the day after the last day
    const dtstart = formatDateForICS(startDate);
    const dtend = addDays(endDate, 1);
    
    const summary = `Time Off: ${employeeName}`;
    const description = `Employee: ${employeeName}\\nReason: ${reason}\\nDates: ${normalizedDates.join(', ')}`;
    
    const icsContent = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Timeshare Help Center//Time Off System//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${dtstart}`,
        `DTEND;VALUE=DATE:${dtend}`,
        `SUMMARY:${summary}`,
        `DESCRIPTION:${description}`,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');
    
    return icsContent;
}

export async function sendCalendarInvite(data: CalendarInviteData): Promise<void> {
    const { employeeName, dates, reason } = data;
    const normalizedDates = dates.map(d => normalizeDate(d)).sort();
    const dateRange = normalizedDates.length > 1 
        ? `${normalizedDates[0]} to ${normalizedDates[normalizedDates.length - 1]}`
        : normalizedDates[0];
    
    const icsContent = generateICSContent(data);
    
    const subject = `Time Off Approved: ${employeeName} - ${dateRange}`;
    const htmlBody = `
        <p>A time-off request has been approved.</p>
        <p><strong>Employee:</strong> ${employeeName}</p>
        <p><strong>Dates:</strong> ${normalizedDates.join(', ')}</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Please see the attached calendar invite (.ics file) to add this to your calendar.</p>
    `;
    const textBody = `
Time Off Approved

Employee: ${employeeName}
Dates: ${normalizedDates.join(', ')}
Reason: ${reason}

Please see the attached calendar invite (.ics file) to add this to your calendar.
    `.trim();

    // Send email with ICS attachment
    await sendEmailWithAttachment({
        to: CALENDAR_RECIPIENT,
        subject,
        html: htmlBody,
        text: textBody,
        attachments: [
            {
                filename: `timeoff-${employeeName.replace(/[^a-zA-Z0-9]/g, '_')}.ics`,
                content: icsContent,
                contentType: 'text/calendar; method=PUBLISH',
            }
        ]
    });

    console.log(`[calendar] Sent calendar invite to ${CALENDAR_RECIPIENT} for ${employeeName} (${dateRange})`);
}

interface EmailWithAttachment {
    to: string | string[];
    subject: string;
    html: string;
    text: string;
    attachments: Array<{
        filename: string;
        content: string;
        contentType: string;
    }>;
}

async function sendEmailWithAttachment(msg: EmailWithAttachment): Promise<void> {
    const mode = (process.env.EMAIL_MODE || 'smtp').toLowerCase();
    const fromEmail = process.env.MAIL_FROM || process.env.FROM_EMAIL || 'no-reply@timesharehelpcenter.com';
    
    if (mode === 'graph') {
        // Use Microsoft Graph API with attachment
        await sendGraphWithAttachment(msg, fromEmail);
    } else {
        // Use SMTP with nodemailer
        await sendSmtpWithAttachment(msg, fromEmail);
    }
}

async function sendGraphWithAttachment(msg: EmailWithAttachment, fromEmail: string): Promise<void> {
    const { Client } = await import('@microsoft/microsoft-graph-client');
    const { ClientSecretCredential } = await import('@azure/identity');
    
    const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID || '';
    const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID || '';
    const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET || '';
    const GRAPH_SENDER_EMAIL = process.env.GRAPH_SENDER_EMAIL || fromEmail;

    if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
        throw new Error('Graph client not configured for calendar invites');
    }

    const credential = new ClientSecretCredential(
        GRAPH_TENANT_ID,
        GRAPH_CLIENT_ID,
        GRAPH_CLIENT_SECRET
    );

    const graphClient = Client.initWithMiddleware({
        authProvider: {
            getAccessToken: async () => {
                const token = await credential.getToken('https://graph.microsoft.com/.default');
                return token?.token || '';
            },
        },
    });

    const recipients = (Array.isArray(msg.to) ? msg.to : [msg.to]).map(addr => ({
        emailAddress: { address: addr },
    }));

    const message = {
        subject: msg.subject,
        body: {
            contentType: 'HTML',
            content: msg.html,
        },
        toRecipients: recipients,
        attachments: msg.attachments.map(att => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.filename,
            contentType: att.contentType,
            contentBytes: Buffer.from(att.content).toString('base64'),
        })),
    };

    await graphClient.api(`/users/${GRAPH_SENDER_EMAIL}/sendMail`).post({ message });
}

async function sendSmtpWithAttachment(msg: EmailWithAttachment, fromEmail: string): Promise<void> {
    const host = process.env.SMTP_HOST || '';
    const port = Number(process.env.SMTP_PORT || (host ? 587 : 0));
    const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ? true : (port === 465);
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';

    if (!host) {
        throw new Error('SMTP host not configured for calendar invites');
    }

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined,
        tls: { ciphers: 'TLSv1.2' },
    });

    await transporter.sendMail({
        from: fromEmail,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments.map(att => ({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType,
        })),
    });
}
