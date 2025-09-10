
import { query } from '../db';
export async function createCalendarEntry({ requestId, startDate, endDate, summary }:
  { requestId: string, startDate: string, endDate: string, summary: string }) {
  await query(`
    INSERT INTO time_off_calendar (request_id, start_date, end_date, summary)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (request_id) DO NOTHING
  `, [requestId, startDate, endDate, summary]);
}
