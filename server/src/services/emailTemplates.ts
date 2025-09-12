export function buildNewRequestEmail(args: {
  siteUrl: string;
  employeeName: string;
  employeeEmail: string;
  reason: string;
  dates: string[];
}) {
  const { siteUrl, employeeName, employeeEmail, reason, dates } = args;
  const range = dates.length > 1 ? `${dates[0]} → ${dates[dates.length - 1]}` : dates[0];
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
  date: string;
  decision: 'APPROVED' | 'REJECTED' | string;
  reason: string;
}) {
  const { siteUrl, employeeName, date, decision, reason } = args;
  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; line-height:1.5;">
    <h2>Time-Off ${escapeHtml(String(decision))}</h2>
    <p>Hi ${escapeHtml(employeeName)},</p>
    <p>Your time-off request for <strong>${escapeHtml(date)}</strong> was <strong>${escapeHtml(String(decision).toLowerCase())}</strong>.</p>
    <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
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
