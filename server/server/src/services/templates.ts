// server/src/services/templates.ts
export function approverEmailSubject(employeeName: string, datesSummary: string) {
  return `Time Off Request: ${employeeName} – ${datesSummary}`;
}

export function approverEmailBodyHTML(employeeName: string, datesList: string[], reason: string, requestLink?: string) {
  const link = requestLink ? `<p><a href="${requestLink}">Review request</a></p>` : '';
  return `
    <div>
      <p><strong>${employeeName}</strong> submitted a time off request.</p>
      <p><strong>Dates:</strong> ${datesList.join(', ')}</p>
      <p><strong>Reason:</strong> ${reason || '(not provided)'}</p>
      ${link}
    </div>
  `;
}

export function approverEmailBodyText(employeeName: string, datesList: string[], reason: string, requestLink?: string) {
  const lines = [
    `${employeeName} submitted a time off request.`,
    `Dates: ${datesList.join(', ')}`,
    `Reason: ${reason || '(not provided)'}`,
    requestLink ? `Review: ${requestLink}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}
