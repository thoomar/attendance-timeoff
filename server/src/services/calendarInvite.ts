import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';

const CALENDAR_USER = process.env.CALENDAR_RECIPIENT || 'freddie@republicfinancialservices.com';

export interface CalendarInviteData {
    requestId: string;
    employeeName: string;
    employeeEmail: string;
    dates: (string | Date)[];
    reason: string;
}

function normalizeDate(dateInput: string | Date): string {
    if (dateInput instanceof Date) {
        const year = dateInput.getFullYear();
        const month = String(dateInput.getMonth() + 1).padStart(2, '0');
        const day = String(dateInput.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    const dateStr = String(dateInput);
    if (dateStr.includes('T')) {
        return dateStr.split('T')[0];
    }
    return dateStr;
}

function addDaysToDate(dateStr: string, days: number): string {
    const date = new Date(dateStr + 'T00:00:00');
    date.setDate(date.getDate() + days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getGraphClient(): Client {
    const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID || '';
    const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID || '';
    const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET || '';

    if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
        throw new Error('Microsoft Graph credentials not configured (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET)');
    }

    const credential = new ClientSecretCredential(
        GRAPH_TENANT_ID,
        GRAPH_CLIENT_ID,
        GRAPH_CLIENT_SECRET
    );

    return Client.initWithMiddleware({
        authProvider: {
            getAccessToken: async () => {
                const token = await credential.getToken('https://graph.microsoft.com/.default');
                return token?.token || '';
            },
        },
    });
}

export async function sendCalendarInvite(data: CalendarInviteData): Promise<void> {
    const { requestId, employeeName, employeeEmail, dates, reason } = data;
    
    // Normalize and sort dates
    const normalizedDates = dates.map(d => normalizeDate(d)).sort();
    const startDate = normalizedDates[0];
    const endDate = normalizedDates[normalizedDates.length - 1];
    
    // For all-day events, end date should be the day after
    const endDatePlusOne = addDaysToDate(endDate, 1);
    
    const dateRange = normalizedDates.length > 1 
        ? `${startDate} to ${endDate}`
        : startDate;

    const graphClient = getGraphClient();

    // Create event directly on Freddie's calendar
    const event = {
        subject: `Time Off: ${employeeName}`,
        body: {
            contentType: 'HTML',
            content: `
                <p><strong>Employee:</strong> ${employeeName}</p>
                <p><strong>Email:</strong> ${employeeEmail}</p>
                <p><strong>Dates:</strong> ${normalizedDates.join(', ')}</p>
                <p><strong>Reason:</strong> ${reason}</p>
                <p><em>Request ID: ${requestId}</em></p>
            `
        },
        start: {
            dateTime: startDate,
            timeZone: 'UTC'
        },
        end: {
            dateTime: endDatePlusOne,
            timeZone: 'UTC'
        },
        isAllDay: true,
        showAs: 'free',
        categories: ['Time Off'],
    };

    try {
        await graphClient.api(`/users/${CALENDAR_USER}/calendar/events`).post(event);
        console.log(`[calendar] Created calendar event for ${employeeName} (${dateRange}) on ${CALENDAR_USER}'s calendar`);
    } catch (error: any) {
        console.error(`[calendar] Failed to create event:`, error?.message || error);
        throw error;
    }
}
