import { sendEmail } from './email';
import { buildNewRequestEmail, buildDecisionEmail } from './emailTemplates';

export type EmailType = 'NEW_REQUEST' | 'APPROVED' | 'REJECTED';

export type NewRequestCtx = {
    siteUrl?: string;
    employeeName: string;
    employeeEmail: string;
    reason: string;
    dates: string[]; // 'YYYY-MM-DD' strings
    toOverride?: string[]; // override recipients if provided
};

export type DecisionCtx = {
    siteUrl?: string;
    employeeName: string;
    employeeEmail: string;  // who gets the decision email
    managerName: string;    // who made the decision
    dates: string[];        // 'YYYY-MM-DD' strings
    decision: 'APPROVED' | 'REJECTED';
    denialReason?: string;  // optional note/explanation for denials
    toOverride?: string[];  // override recipients if provided
};

function getApproverEmails(): string[] {
    const raw = process.env.APPROVER_EMAILS || process.env.HR_EMAILS || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function htmlToText(html: string): string {
    // very small fallback; good enough for plain text bodies
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

export async function sendTimeOffEmail(
    type: EmailType,
    ctx: NewRequestCtx | DecisionCtx
) {
    if (type === 'NEW_REQUEST') {
        const c = ctx as NewRequestCtx;
        const html = buildNewRequestEmail({
            siteUrl: c.siteUrl || '',
            employeeName: c.employeeName,
            employeeEmail: c.employeeEmail,
            reason: c.reason || '',
            dates: c.dates || [],
        });
        const to = (c.toOverride && c.toOverride.length) ? c.toOverride : getApproverEmails();
        if (!to.length) {
            console.warn('[email] No APPROVER_EMAILS/HR_EMAILS configured; skipping NEW_REQUEST email');
            return;
        }
        await sendEmail({
            to,
            subject: `New Time-Off Request from ${c.employeeName}`,
            html,
            text: htmlToText(html),
        });
        return;
    }

    // APPROVED / REJECTED -> email the employee
    const c = ctx as DecisionCtx;
    const html = buildDecisionEmail({
        siteUrl: c.siteUrl || '',
        employeeName: c.employeeName,
        managerName: c.managerName,
        dates: c.dates,
        decision: type,
        denialReason: c.denialReason,
    });
    const to = (c.toOverride && c.toOverride.length) ? c.toOverride : [c.employeeEmail];
    const dateRange = c.dates.length > 1 ? `${c.dates[0]} - ${c.dates[c.dates.length - 1]}` : c.dates[0];
    await sendEmail({
        to,
        subject: `Time-Off ${type} — ${dateRange}`,
        html,
        text: htmlToText(html),
    });
}
