// src/services/email.ts
import nodemailer from 'nodemailer';
import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';

const mode = (process.env.EMAIL_MODE || 'smtp').toLowerCase();
const fromEmail = process.env.MAIL_FROM || process.env.FROM_EMAIL || 'no-reply@timesharehelpcenter.com';

// SMTP config
const host = process.env.SMTP_HOST || '';
const port = Number(process.env.SMTP_PORT || (host ? 587 : 0));
const secure =
    String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ? true : (port === 465);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';

const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: { ciphers: 'TLSv1.2' }, // Office365 is strict
});

// Graph config
const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID || '';
const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID || '';
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET || '';
const GRAPH_SENDER_EMAIL = process.env.GRAPH_SENDER_EMAIL || fromEmail;

let graphClient: Client | null = null;

function getGraphClient(): Client | null {
    if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
        return null;
    }

    if (!graphClient) {
        const credential = new ClientSecretCredential(
            GRAPH_TENANT_ID,
            GRAPH_CLIENT_ID,
            GRAPH_CLIENT_SECRET
        );

        graphClient = Client.initWithMiddleware({
            authProvider: {
                getAccessToken: async () => {
                    const token = await credential.getToken('https://graph.microsoft.com/.default');
                    return token?.token || '';
                },
            },
        });
    }

    return graphClient;
}

export type EmailMessage = {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    from?: string;
};

async function sendGraph(msg: EmailMessage): Promise<any> {
    const client = getGraphClient();
    if (!client) {
        throw new Error('Graph client not configured');
    }

    const recipients = (Array.isArray(msg.to) ? msg.to : [msg.to]).map(addr => ({
        emailAddress: { address: addr },
    }));

    const message = {
        subject: msg.subject,
        body: {
            contentType: msg.html ? 'HTML' : 'Text',
            content: msg.html || msg.text || '',
        },
        toRecipients: recipients,
    };

    try {
        await client.api(`/users/${GRAPH_SENDER_EMAIL}/sendMail`).post({ message });
        return { accepted: msg.to, rejected: [] };
    } catch (err: any) {
        const statusCode = err?.statusCode || err?.code;
        const body = err?.body ? JSON.stringify(err.body) : '';
        throw new Error(`Graph sendMail error: ${statusCode} ${body}`);
    }
}

async function sendSmtp(msg: EmailMessage): Promise<any> {
    if (!host) {
        throw new Error('SMTP host not configured');
    }
    return transporter.sendMail({ from: msg.from || fromEmail, ...msg });
}

export async function sendEmail(msg: EmailMessage) {
    const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];

    // Try Graph first if mode is 'graph'
    if (mode === 'graph') {
        try {
            console.log('[email] NEW_REQUEST send via Graph to', recipients);
            return await sendGraph(msg);
        } catch (err: any) {
            console.error('[email] NEW_REQUEST send failed:', err);
            // Fall through to disabled message
        }
    }

    // Try SMTP if mode is 'smtp'
    if (mode === 'smtp' && host) {
        try {
            console.log('[email] Sending via SMTP to', recipients);
            return await sendSmtp(msg);
        } catch (err: any) {
            console.error('[email] SMTP send failed:', err);
            // Fall through to disabled message
        }
    }

    // If we get here, email is disabled or failed
    console.warn('[email] disabled; skipping send to', recipients);
    return { accepted: [], rejected: recipients };
}
