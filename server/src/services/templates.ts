type UserLike = { fullName: string; email: string; id?: string };

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function datesList(dates: string[]) {
  return dates.join(', ');
}

export function makeRequestCreatedEmail(args: {
  user: UserLike;
  dates: string[];
  reason: string;
}) {
  const { user, dates, reason } = args;
  const subject = `${user.fullName} submitted a time off request for ${datesList(dates)}`;

  const text = `Heads up!

${user.fullName} (${user.email}) submitted a time off request.

Dates: ${datesList(dates)}
Reason: ${reason}

— Attendance Tracker`;

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
  <h2>New Time Off Request</h2>
  <p><strong>${esc(user.fullName)}</strong> &lt;${esc(user.email)}&gt; submitted a time off request.</p>
  <p><strong>Dates:</strong> ${esc(datesList(dates))}<br/>
     <strong>Reason:</strong> ${esc(reason)}</p>
  <p>— Attendance Tracker</p>
</div>`;

  return { subject, text, html };
}

export function makeRequestApproverEmail(args: {
  user: UserLike;
  dates: string[];
  reason: string;
  requestId: string;
}) {
  const { user, dates, reason, requestId } = args;
  const subject = `Approval needed: ${user.fullName} • ${datesList(dates)}`;

  const portalBase = process.env.PORTAL_BASE_URL || 'https://timeoff.timesharehelpcenter.com';
  const requestUrl = `${portalBase}/admin/time-off/${encodeURIComponent(requestId)}`;

  const text = `An approval is needed.

Employee: ${user.fullName} (${user.email})
Dates: ${datesList(dates)}
Reason: ${reason}

Review: ${requestUrl}

— Attendance Tracker`;

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
  <h2>Approval Needed</h2>
  <p><strong>Employee:</strong> ${esc(user.fullName)} &lt;${esc(user.email)}&gt;</p>
  <p><strong>Dates:</strong> ${esc(datesList(dates))}<br/>
     <strong>Reason:</strong> ${esc(reason)}</p>
  <p><a href="${esc(requestUrl)}" style="display:inline-block;padding:10px 14px;border-radius:8px;border:1px solid #0f172a;text-decoration:none">Open Request</a></p>
  <p>— Attendance Tracker</p>
</div>`;

  return { subject, text, html };
}
