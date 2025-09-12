import dotenv from 'dotenv'; dotenv.config();
import { sendEmail } from './email';
import { renderRequestSubmittedEmail } from './emailTemplates';

type EmailType = 'NEW_REQUEST'|'APPROVED'|'REJECTED';

type TimeOffCtx = {
    employeeName: string;
    dates: string[];          // 'YYYY-MM-DD' strings
    reason?: string;
    approverName?: string;
    notes?: string;           // optional approver notes
    toOverride?: string[];    // optional explicit recipients
};

function getApproverEmails(): string[] {
    const raw = process.env.APPROVER_EMAILS || process.env.HR_EMAILS || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export async function sendTimeOffEmail(type: EmailType, ctx: TimeOffCtx) {
    const to = (ctx.toOverride && ctx.toOverride.length > 0)
        ? ctx.toOverride
        : getApproverEmails();

    if (!to || to.length === 0) {
        console.warn('[email] No APPROVER_EMAILS/HR_EMAILS configured; skipping send');
        return;
    }

    let subject = '';
    let text = '';
    let html = '';

    if (type === 'NEW_REQUEST') {
        const tpl = renderRequestSubmittedEmail({
            employeeName: ctx.employeeName,
            dates: ctx.dates,
            reason: ctx.reason || ''
        });
        subject = tpl.subject;
        text = tpl.text;
        html = tpl.html;
    } else if (type === 'APPROVED') {
        subject = `Time Off Approved for ${ctx.employeeName}`;
        text = [
            `Employee: ${ctx.employeeName}`,
            `Dates: ${ctx.dates.join(', ')}`,
            `Approved by: ${ctx.approverName || '-'}`,
            ctx.notes ? `Notes: ${ctx.notes}` : ''
        ].filter(Boolean).join('\n');
        html = `<p><strong>Employee:</strong> ${ctx.employeeName}</p>
<p><strong>Dates:</strong> ${ctx.dates.join(', ')}</p>
<p><strong>Approved by:</strong> ${ctx.approverName || '-'}</p>
${ctx.notes ? `<p><strong>Notes:</strong> ${ctx.notes}</p>` : ''}`;
    } else if (type === 'REJECTED') {
        subject = `Time Off Rejected for ${ctx.employeeName}`;
        text = [
            `Employee: ${ctx.employeeName}`,
            `Dates: ${ctx.dates.join(', ')}`,
            `Rejected by: ${ctx.approverName || '-'}`,
            ctx.notes ? `Reason: ${ctx.notes}` : ''
        ].filter(Boolean).join('\n');
        html = `<p><strong>Employee:</strong> ${ctx.employeeName}</p>
<p><strong>Dates:</strong> ${ctx.dates.join(', ')}</p>
<p><strong>Rejected by:</strong> ${ctx.approverName || '-'}</p>
${ctx.notes ? `<p><strong>Reason:</strong> ${ctx.notes}</p>` : ''}`;
    }

    await sendEmail({ to, subject, text, html });
}
