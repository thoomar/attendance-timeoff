// Helper to format dates properly
function formatDate(d: string | Date): string {
  if (typeof d === 'string') {
    // Already a string, ensure it's YYYY-MM-DD format
    return d.slice(0, 10);
  }
  // Date object - convert to YYYY-MM-DD
  const date = new Date(d);
  return date.toISOString().slice(0, 10);
}

export function buildNewRequestEmail(args: {
  siteUrl: string;
  employeeName: string;
  employeeEmail: string;
  reason: string;
  dates: (string | Date)[];
}) {
  const { siteUrl, employeeName, employeeEmail, reason, dates } = args;
  const formattedDates = dates.map(formatDate);
  const range = formattedDates.length > 1 
    ? `${formattedDates[0]} → ${formattedDates[formattedDates.length - 1]}` 
    : formattedDates[0];
  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; line-height:1.5;">
    <h2>New Time-Off Request</h2>
    <p><strong>Employee:</strong> ${escapeHtml(employeeName)} (${escapeHtml(employeeEmail)})</p>
    <p><strong>Dates:</strong> ${escapeHtml(range)}</p>
    <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
    ${siteUrl ? `<p><a href="${siteUrl}" target="_blank" rel="noopener">Open Attendance Tracker</a></p>` : ''}
  </div>
  `;
}

export function buildDecisionEmail(args: {
  siteUrl: string;
  employeeName: string;
  managerName: string;
  dates: (string | Date)[];
  decision: 'APPROVED' | 'REJECTED' | string;
  denialReason?: string;
}) {
  const { siteUrl, employeeName, managerName, dates, decision, denialReason } = args;
  const formattedDates = dates.map(formatDate);
  const range = formattedDates.length > 1 
    ? `${formattedDates[0]} → ${formattedDates[formattedDates.length - 1]}` 
    : formattedDates[0];
  const isApproved = decision === 'APPROVED';
  
  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; line-height:1.5;">
    <h2>Time-Off ${escapeHtml(String(decision))}</h2>
    <p>Hi ${escapeHtml(employeeName)},</p>
    ${isApproved 
      ? `<p><strong>${escapeHtml(managerName)}</strong> has approved your request for the following days:</p>
         <p style="margin-left: 20px;"><strong>${escapeHtml(range)}</strong></p>`
      : `<p><strong>${escapeHtml(managerName)}</strong> has denied your request for the following days${denialReason ? ' due to:' : ':'}</p>
         <p style="margin-left: 20px;"><strong>${escapeHtml(range)}</strong></p>
         ${denialReason ? `<p style="margin-left: 20px; font-style: italic;">"${escapeHtml(denialReason)}"</p>` : ''}`
    }
    ${siteUrl ? `<p><a href="${siteUrl}" target="_blank" rel="noopener">Open Attendance Tracker</a></p>` : ''}
  </div>
  `;
}

// No replaceAll — works on ES2019+
function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
