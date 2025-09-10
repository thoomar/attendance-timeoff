
import dotenv from 'dotenv'; dotenv.config();
type EmailType = 'NEW_REQUEST'|'APPROVED'|'REJECTED';
export async function sendTimeOffEmail(type: EmailType, ctx: any) {
  // TODO: Integrate SES/SendGrid; log to console for now.
  const to = process.env.HR_EMAILS || 'hr@example.com';
  console.log(`[EMAIL:${type}] to=${to} payload=${JSON.stringify(ctx)}`);
}
