import * as db from '../db';
import { sendCalendarInvite } from '../services/calendarInvite';

const BACKFILL_FROM_DATE = '2026-01-14';

interface ApprovedRequest {
    id: string;
    dates: string[];
    reason: string;
    user_name: string;
    user_email: string;
    decided_at: Date;
}

async function backfillCalendarInvites() {
    console.log(`[backfill] Starting calendar invite backfill from ${BACKFILL_FROM_DATE}...`);
    
    try {
        // Find all approved requests where any date is >= BACKFILL_FROM_DATE
        const { rows } = await db.query<ApprovedRequest>(
            `
            SELECT r.id, r.dates, r.reason, r.decided_at,
                   u.full_name AS user_name, u.email AS user_email
            FROM time_off_requests r
            LEFT JOIN users u ON u.id = r.user_id
            WHERE r.status = 'APPROVED'
              AND EXISTS (
                  SELECT 1 FROM unnest(r.dates) AS d(actual)
                  WHERE d.actual >= $1::date
              )
            ORDER BY r.decided_at ASC
            `,
            [BACKFILL_FROM_DATE]
        );

        console.log(`[backfill] Found ${rows.length} approved requests from ${BACKFILL_FROM_DATE} forward`);

        let successCount = 0;
        let errorCount = 0;

        for (const request of rows) {
            const employeeName = request.user_name || request.user_email;
            const sortedDates = [...request.dates].sort();
            const dateRange = sortedDates.length > 1 
                ? `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`
                : sortedDates[0];

            console.log(`[backfill] Processing: ${employeeName} - ${dateRange}`);

            try {
                await sendCalendarInvite({
                    requestId: request.id,
                    employeeName,
                    employeeEmail: request.user_email,
                    dates: request.dates,
                    reason: request.reason || 'Time Off',
                });
                successCount++;
                console.log(`[backfill] ✓ Sent calendar invite for ${employeeName}`);
                
                // Small delay between emails to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                errorCount++;
                console.error(`[backfill] ✗ Failed to send for ${employeeName}:`, error);
            }
        }

        console.log(`\n[backfill] Complete!`);
        console.log(`[backfill] Success: ${successCount}`);
        console.log(`[backfill] Errors: ${errorCount}`);
        console.log(`[backfill] Total: ${rows.length}`);

    } catch (error) {
        console.error('[backfill] Fatal error:', error);
        process.exit(1);
    }
}

// Run if executed directly
backfillCalendarInvites()
    .then(() => {
        console.log('[backfill] Script finished');
        process.exit(0);
    })
    .catch((err) => {
        console.error('[backfill] Unhandled error:', err);
        process.exit(1);
    });
