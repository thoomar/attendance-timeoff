import React, { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { z } from 'zod';
import { CalendarDays, CheckCircle2, ClipboardList, SendHorizonal, Clock, LogOut, CalendarOff, ChevronDown, ChevronUp } from 'lucide-react';
import { getAuthHeaders, captureTokenFromURL, clearToken } from '../auth/token';

const CreateReq = z.object({ dates: z.array(z.date()).min(1), reason: z.string().min(3) });
type Role = 'Enrollment Specialist' | 'Senior Contract Specialist' | 'Manager' | 'Admin';
type User = { id: string; name: string; role: Role };

// Company Observed Holidays for 2025 (upcoming only - past holidays removed for clarity)
const COMPANY_HOLIDAYS_2025 = [
    { date: new Date(2025, 10, 27), name: 'Thanksgiving Day', dayOfWeek: 'Thursday', year: 2025 },
    { date: new Date(2025, 10, 28), name: 'Day After Thanksgiving', dayOfWeek: 'Friday', year: 2025 },
    { date: new Date(2025, 11, 24), name: 'Christmas Eve', dayOfWeek: 'Wednesday', year: 2025 },
    { date: new Date(2025, 11, 25), name: 'Christmas Day', dayOfWeek: 'Thursday', year: 2025 },
    { date: new Date(2025, 11, 31), name: 'New Year\'s Eve', dayOfWeek: 'Wednesday', year: 2025 },
];

// Company Observed Holidays for 2026
const COMPANY_HOLIDAYS_2026 = [
    { date: new Date(2026, 0, 1), name: 'New Year\'s Day', dayOfWeek: 'Thursday', year: 2026 },
    { date: new Date(2026, 4, 25), name: 'Memorial Day', dayOfWeek: 'Monday', year: 2026 },
    { date: new Date(2026, 6, 4), name: 'Independence Day', dayOfWeek: 'Saturday', year: 2026 },
    { date: new Date(2026, 6, 3), name: 'Independence Day (Observed)', dayOfWeek: 'Friday', year: 2026 },
    { date: new Date(2026, 8, 7), name: 'Labor Day', dayOfWeek: 'Monday', year: 2026 },
    { date: new Date(2026, 10, 26), name: 'Thanksgiving Day', dayOfWeek: 'Thursday', year: 2026 },
    { date: new Date(2026, 10, 27), name: 'Day After Thanksgiving', dayOfWeek: 'Friday', year: 2026 },
    { date: new Date(2026, 11, 24), name: 'Christmas Eve', dayOfWeek: 'Thursday', year: 2026 },
    { date: new Date(2026, 11, 25), name: 'Christmas Day', dayOfWeek: 'Friday', year: 2026 },
    { date: new Date(2026, 11, 31), name: 'New Year\'s Eve', dayOfWeek: 'Thursday', year: 2026 },
];

// Combined holidays for easy access
const ALL_COMPANY_HOLIDAYS = [...COMPANY_HOLIDAYS_2025, ...COMPANY_HOLIDAYS_2026];

// Server calendar entry shape (normalized below)
type CalendarEntry = {
    userId: string;
    userName: string;
    dates: string[];                 // ISO strings
    status: 'PENDING' | 'APPROVED';
    submittedAt?: string;            // ISO (created_at)
};

// Pending approval item (manager)
type PendingUIItem = {
    id: string;
    employeeName?: string;
    employeeEmail?: string;
    date: string;                    // "YYYY-MM-DD" or range
    reason: string;
    submittedAt?: string;            // ISO
};

// User's own request item
type MyRequestItem = {
    id: string;
    date: string;                    // "YYYY-MM-DD" or range
    reason: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    submittedAt?: string;            // ISO
    decidedAt?: string;              // ISO
    decisionNote?: string;           // Denial reason from manager/admin
};

/** ----------------- Helpers for the Zoho loop fix ----------------- */
function parseZohoCallbackFlag(): boolean {
    const params = new URLSearchParams(window.location.search);
    const a = params.get('zoho') === 'connected';
    const b = params.get('connected') === 'zoho';
    return a || b;
}
function stripQueryParams(): void {
    const url = new URL(window.location.href);
    if (url.search) {
        url.search = '';
        window.history.replaceState({}, '', url.toString());
    }
}
/** ----------------------------------------------------------------- */

// Formatting helpers
function fmtTimeLocal(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtMDY(isoDate: string): string {
    // Parse YYYY-MM-DD directly to avoid timezone conversion
    const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return isoDate;
    const [, year, month, day] = match;
    return `${month}/${day}/${year}`;
}
function fmtDateRange(isoDates: string[]): string {
    if (!isoDates?.length) return '';
    const uniques = Array.from(new Set(isoDates.map(s => s.slice(0, 10))));
    uniques.sort();
    const start = fmtMDY(uniques[0]);
    const end = uniques.length > 1 ? fmtMDY(uniques[uniques.length - 1]) : '';
    return end ? `${start} - ${end}` : start;
}

export default function TimeOffPage() {
    const [user, setUser] = useState<User | null>(null);
    const [selected, setSelected] = useState<Date[]>([]);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [pending, setPending] = useState<PendingUIItem[]>([]);
    const [myRequests, setMyRequests] = useState<MyRequestItem[]>([]);
    const [calendar, setCalendar] = useState<CalendarEntry[]>([]);
    const [selectedDatesInfo, setSelectedDatesInfo] = useState<Array<{ date: string; dateStr: string; people: string[] }>>([]);
    const [holidaysExpanded, setHolidaysExpanded] = useState(true);

    // Zoho disabled - using Microsoft O365 instead
    const zohoConnected = true;

    // Capture JWT token from URL if present (after OAuth redirect)
    useEffect(() => {
        if (captureTokenFromURL()) {
            // Token was captured - reload the page to fetch user data with token
            window.location.reload();
        }
    }, []);

    // --- Load current user ---
    useEffect(() => {
        (async () => {
            try {
                const r = await fetch('/api/me', { 
                    headers: getAuthHeaders(),
                });
                if (r.status === 401) {
                    // Not authenticated - explicitly set null to trigger login UI
                    clearToken(); // Clear any invalid token
                    setUser(null);
                    return;
                }
                const d = await r.json();
                // backend returns { id, email, fullName, role }
                const mapped: User = { id: d?.id, name: d?.fullName || d?.name || 'User', role: d?.role };
                setUser(mapped);
            } catch {
                setUser(null);
            }
        })();
    }, []);

    // --- Load calendar (all users come from the same endpoint) ---
    useEffect(() => {
        if (!user) return;

        const from = new Date();
        const to = new Date();
        to.setMonth(to.getMonth() + 2);
        const qs = `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`;

        fetch(`/api/time-off/calendar?${qs}`, { headers: getAuthHeaders() })
            .then(r => r.json())
            .then((d: any) => {
                const entries: CalendarEntry[] = Array.isArray(d?.entries)
                    ? d.entries
                        .filter((e: any) => e.status === 'APPROVED') // Only show approved requests
                        .map((e: any) => ({
                            userId: e.userId || e.user_id || '',
                            userName: e.name || e.userName || user.name,
                            dates: Array.isArray(e.dates) ? e.dates : [],
                            status: e.status,
                            submittedAt: e.created_at || e.submittedAt,
                        }))
                    : [];
                setCalendar(entries);
            })
            .catch(() => setCalendar([]));
    }, [user]);

    // --- Load pending approvals (managers only) ---
    useEffect(() => {
        if (!user) return;
        if (user.role === 'Manager' || user.role === 'Admin') {
            fetch('/api/time-off/pending', { headers: getAuthHeaders() })
                .then(r => r.json())
                .then((raw: any) => {
                    const out: PendingUIItem[] = [];
                    if (Array.isArray(raw?.items)) {
                        for (const item of raw.items) {
                            if (item?.id) {
                                const range =
                                    Array.isArray(item.dates) && item.dates.length
                                        ? fmtDateRange(item.dates)
                                        : (item.date ? fmtMDY(item.date) : '—');
                                out.push({
                                    id: item.id,
                                    employeeName: item.user_name ?? item.full_name ?? undefined,
                                    employeeEmail: item.user_email ?? item.email ?? undefined,
                                    date: range,
                                    reason: item.reason ?? '',
                                    submittedAt: item.created_at,
                                });
                            }
                        }
                    }
                    setPending(out);
                })
                .catch(() => setPending([]));
        }
    }, [user]);

    // --- Load my requests (all users) ---
    useEffect(() => {
        if (!user) return;
        fetch('/api/time-off/mine', { headers: getAuthHeaders() })
            .then(r => r.json())
            .then((raw: any) => {
                const out: MyRequestItem[] = [];
                if (Array.isArray(raw?.items)) {
                    for (const item of raw.items) {
                        if (item?.id) {
                            const range =
                                Array.isArray(item.dates) && item.dates.length
                                    ? fmtDateRange(item.dates)
                                    : '—';
                            out.push({
                                id: item.id,
                                date: range,
                                reason: item.reason ?? '',
                                status: item.status ?? 'PENDING',
                                submittedAt: item.created_at,
                                decidedAt: item.decided_at,
                                decisionNote: item.decision_note,
                            });
                        }
                    }
                }
                setMyRequests(out);
            })
            .catch(() => setMyRequests([]));
    }, [user]);

    const isRequester = useMemo(() => !['Manager', 'Admin'].includes(user?.role || ''), [user]);

    // --- Create request ---
    async function submit() {
        try {
            const parsed = CreateReq.parse({ dates: selected, reason });
            setSubmitting(true);
            const body = { dates: parsed.dates.map(d => d.toISOString().slice(0, 10)), reason };

            const res = await fetch('/api/time-off/requests', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    ...getAuthHeaders(),
                },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const ct = res.headers.get('content-type') || '';
                let msg: string = 'Failed to submit';
                if (ct.includes('application/json')) {
                    try {
                        const j = await res.json();
                        msg = j?.error || JSON.stringify(j);
                    } catch {
                        msg = 'Failed to submit';
                    }
                } else {
                    msg = await res.text();
                }
                throw new Error(typeof msg === 'string' ? msg : 'Failed to submit');
            }

            setSelected([]);
            setReason('');
            alert('Request submitted!');
            // Reload user's requests
            fetch('/api/time-off/mine', { headers: getAuthHeaders() })
                .then(r => r.json())
                .then((raw: any) => {
                    const out: MyRequestItem[] = [];
                    if (Array.isArray(raw?.items)) {
                        for (const item of raw.items) {
                            if (item?.id) {
                                const range = Array.isArray(item.dates) && item.dates.length ? fmtDateRange(item.dates) : '—';
                                out.push({
                                    id: item.id,
                                    date: range,
                                    reason: item.reason ?? '',
                                    status: item.status ?? 'PENDING',
                                    submittedAt: item.created_at,
                                    decidedAt: item.decided_at,
                                    decisionNote: item.decision_note,
                                });
                            }
                        }
                    }
                    setMyRequests(out);
                })
                .catch(() => {});
        } catch (e: any) {
            alert(e?.message || 'Failed to submit');
        } finally {
            setSubmitting(false);
        }
    }

    // --- Approve / Deny (PATCH /api/time-off/:id) ---
    async function decide(id: string, decision: 'APPROVED' | 'REJECTED') {
        try {
            let note = '';
            
            // If denying, ask for a reason
            if (decision === 'REJECTED') {
                const reason = prompt('Please provide a reason for denying this request:');
                if (reason === null) {
                    // User cancelled
                    return;
                }
                note = reason.trim();
                if (!note) {
                    alert('A reason is required when denying a request.');
                    return;
                }
            }

            const res = await fetch(`/api/time-off/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: { 
                    'Content-Type': 'application/json',
                    ...getAuthHeaders(),
                },
                body: JSON.stringify({ decision, note }),
            });
            if (!res.ok) {
                const ct = res.headers.get('content-type') || '';
                let msg = 'Failed to update';
                if (ct.includes('application/json')) {
                    try {
                        const j = await res.json();
                        msg = j?.error || JSON.stringify(j);
                    } catch {
                        msg = await res.text();
                    }
                } else {
                    msg = await res.text();
                }
                throw new Error(msg);
            }
            setPending(p => p.filter(i => i.id !== id));
            alert(`Request ${decision.toLowerCase()} successfully!`);
        } catch (e: any) {
            alert(e?.message || 'Failed to update');
        }
    }

    // Loading states
    if (!user) {
        return (
            <div className="min-h-dvh flex items-center justify-center p-6">
                <div className="card p-8 max-w-md w-full space-y-4">
                    <h2 className="text-lg font-semibold">Authentication Required</h2>
                    <p className="text-slate-400 text-sm">Please sign in with your Microsoft account to continue.</p>
                    <a
                        href={`/api/auth/login?returnTo=${encodeURIComponent('/time-off')}`}
                        className="btn-primary inline-flex w-full justify-center"
                    >
                        Sign in with Microsoft
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-dvh">
            {/* Top bar */}
            <header className="sticky top-0 z-30 backdrop-blur bg-black/40 border-b border-slate-800">
                <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <img src="/logo.png" alt="Timeshare Help Center" className="h-9 w-9 drop-shadow-lg" />
                        <span className="text-lg font-semibold tracking-tight">Time Off</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-400">
                            Signed in as {user.name}
                        </span>
                        <button
                            onClick={() => {
                                clearToken();
                                window.location.href = '/api/auth/login';
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded-md transition-colors"
                            title="Logout"
                        >
                            <LogOut size={14} />
                            Logout
                        </button>
                    </div>
                </div>
            </header>
            {/* Page */}
            <main className="mx-auto max-w-6xl px-6 py-8">
                {/* Company Holidays Section */}
                <section className="card p-6 mb-6">
                    <div 
                        className="flex items-center justify-between cursor-pointer mb-3"
                        onClick={() => setHolidaysExpanded(!holidaysExpanded)}
                    >
                        <h2 className="text-base font-semibold flex items-center gap-2">
                            <CalendarOff className="h-5 w-5 text-red-400" />
                            Company Observed Holidays
                        </h2>
                        <button 
                            className="text-slate-400 hover:text-slate-200 transition-colors"
                            aria-label={holidaysExpanded ? "Collapse" : "Expand"}
                        >
                            {holidaysExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                        </button>
                    </div>
                    {holidaysExpanded && (
                        <>
                            <p className="text-sm text-slate-400 mb-4">
                                Please take note the office will be closed on the dates posted below:
                            </p>
                            
                            {/* 2025 Holidays */}
                            <h3 className="text-sm font-semibold text-slate-300 mb-2 mt-4">2025</h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
                        {COMPANY_HOLIDAYS_2025.map((holiday, idx) => (
                            <div 
                                key={idx} 
                                className="rounded-lg border border-red-800 bg-red-950/30 p-3 flex items-center gap-3"
                            >
                                <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-lg bg-red-900/50 border border-red-700">
                                    <span className="text-lg font-bold text-red-200">
                                        {holiday.date.getMonth() + 1}/{holiday.date.getDate()}
                                    </span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="font-semibold text-sm text-slate-200 truncate">
                                        {holiday.name}
                                    </div>
                                    <div className="text-xs text-slate-400">
                                        {holiday.dayOfWeek}
                                    </div>
                                </div>
                            </div>
                        ))}
                            </div>
                            
                            {/* 2026 Holidays */}
                            <h3 className="text-sm font-semibold text-slate-300 mb-2 mt-2">2026</h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {COMPANY_HOLIDAYS_2026.map((holiday, idx) => (
                            <div 
                                key={idx} 
                                className="rounded-lg border border-red-800 bg-red-950/30 p-3 flex items-center gap-3"
                            >
                                <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-lg bg-red-900/50 border border-red-700">
                                    <span className="text-lg font-bold text-red-200">
                                        {holiday.date.getMonth() + 1}/{holiday.date.getDate()}
                                    </span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="font-semibold text-sm text-slate-200 truncate">
                                        {holiday.name}
                                    </div>
                                    <div className="text-xs text-slate-400">
                                        {holiday.dayOfWeek}
                                    </div>
                                </div>
                            </div>
                        ))}
                            </div>
                        </>
                    )}
                </section>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* LEFT */}
                    <section className="card p-6">
                        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
                            <CalendarDays className="h-5 w-5 text-yellow-500" />
                            {['Manager', 'Admin'].includes(user.role) ? 'Manager Calendar' : 'Team Calendar'}
                        </h2>

                        <DayPicker
                            mode="multiple"
                            selected={selected}
                            onSelect={(val) => setSelected(val || [])}
                            disabled={[
                                { before: new Date() },
                                ...ALL_COMPANY_HOLIDAYS.map(h => h.date)
                            ]}
                            className="rdp"
                            modifiers={{
                                hasTimeOff: (date) => {
                                    const dateStr = date.toISOString().slice(0, 10);
                                    return calendar.some(e => e.dates.some(d => d.startsWith(dateStr)));
                                },
                                holiday: (date) => {
                                    return ALL_COMPANY_HOLIDAYS.some(h => 
                                        h.date.getFullYear() === date.getFullYear() &&
                                        h.date.getMonth() === date.getMonth() &&
                                        h.date.getDate() === date.getDate()
                                    );
                                }
                            }}
                            modifiersClassNames={{
                                hasTimeOff: 'rdp-day_has_timeoff',
                                holiday: 'rdp-day_holiday'
                            }}
                            onDayClick={(day) => {
                                // Get local date parts to avoid timezone issues
                                const year = day.getFullYear();
                                const month = String(day.getMonth() + 1).padStart(2, '0');
                                const dayNum = String(day.getDate()).padStart(2, '0');
                                const dateStr = `${year}-${month}-${dayNum}`;
                                const displayDate = `${month}/${dayNum}/${year}`;
                                
                                const peopleOff = calendar
                                    .filter(e => e.dates.some(d => d.startsWith(dateStr)))
                                    .map(e => e.userName);
                                
                                if (peopleOff.length > 0) {
                                    // Toggle: if already in list, remove it; otherwise add it
                                    setSelectedDatesInfo(prev => {
                                        const exists = prev.find(d => d.dateStr === dateStr);
                                        if (exists) {
                                            return prev.filter(d => d.dateStr !== dateStr);
                                        } else {
                                            return [...prev, { date: displayDate, dateStr, people: peopleOff }].sort((a, b) => a.dateStr.localeCompare(b.dateStr));
                                        }
                                    });
                                }
                            }}
                        />

                        {selectedDatesInfo.length > 0 && (
                            <div className="mt-4 p-4 rounded-xl border border-yellow-600 bg-yellow-950/30">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold">Time Off Summary ({selectedDatesInfo.length} date{selectedDatesInfo.length === 1 ? '' : 's'})</h3>
                                    <button onClick={() => {
                                        setSelectedDatesInfo([]);
                                        setSelected([]);
                                    }} className="text-xs text-slate-400 hover:text-slate-200">Clear All</button>
                                </div>
                                <div className="space-y-3">
                                    {selectedDatesInfo.map((dateInfo, idx) => (
                                        <div key={idx} className="border-b border-slate-700 pb-2 last:border-0 last:pb-0">
                                            <div className="flex items-center justify-between mb-1">
                                                <h4 className="text-xs font-semibold text-yellow-500">{dateInfo.date}</h4>
                                                <button 
                                                    onClick={() => setSelectedDatesInfo(prev => prev.filter(d => d.dateStr !== dateInfo.dateStr))} 
                                                    className="text-xs text-slate-500 hover:text-slate-300"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                            <ul className="text-sm text-slate-300 space-y-1">
                                                {dateInfo.people.map((person, personIdx) => (
                                                    <li key={personIdx}>• {person}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {isRequester && (
                            <div className="mt-4 space-y-3">
                <textarea
                    placeholder="Reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full min-h-24 rounded-xl border border-slate-700 bg-slate-900 p-3"
                />
                                <div className="flex items-center justify-between">
                                    <div className="text-sm text-slate-400">
                                        {selected.length} day{selected.length === 1 ? '' : 's'} selected
                                    </div>
                                    <button
                                        onClick={submit}
                                        disabled={submitting || selected.length === 0 || reason.trim().length < 3}
                                        className="btn-primary disabled:opacity-50 disabled:pointer-events-none"
                                    >
                                        <SendHorizonal className="h-4 w-4" />
                                        {submitting ? 'Submitting…' : 'Submit Request'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>

                    {/* RIGHT: Upcoming */}
                    <aside className="card p-6">
                        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
                            <CheckCircle2 className="h-5 w-5 text-emerald-400" /> Upcoming Approved Time Off
                        </h2>

                        {calendar.length === 0 ? (
                            <div className="text-sm text-slate-400">Nothing scheduled yet.</div>
                        ) : (
                            <ul className="space-y-3">
                                {calendar.map((e, i) => {
                                    const initials =
                                        e.userName?.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '✓';
                                    const submitted = e.submittedAt ? fmtTimeLocal(e.submittedAt) : '';
                                    const range = fmtDateRange(e.dates || []);
                                    return (
                                        <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 text-slate-200">
                        {initials}
                      </span>
                                            <div className="space-y-0.5">
                                                {/* “Submitted: 2:40 PM — Name — for 09/17/2025 - 09/18/2025” */}
                                                <div className="text-slate-300">
                                                    {submitted && <strong>Approved:</strong>} {submitted || '—'}
                                                    {e.userName ? <> — <strong>{e.userName}</strong></> : null}
                                                    {range ? <> — for <strong>{range}</strong></> : null}
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </aside>
                </div>

                {(user.role === 'Manager' || user.role === 'Admin') && (
                    <section className="card p-6 mt-6">
                        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
                            <ClipboardList className="h-5 w-5 text-amber-400" /> Pending Approvals
                        </h2>

                        {pending.length === 0 ? (
                            <div className="text-sm text-slate-400">No pending requests.</div>
                        ) : (
                            <ul className="space-y-3">
                                {pending.map(p => (
                                    <li key={p.id} className="rounded-xl border border-slate-800 p-4">
                                        <div className="flex items-center justify-between">
                                            <div className="font-semibold">
                                                {p.employeeName ?? 'Employee'}{' '}
                                                {p.employeeEmail ? <span className="text-slate-400 text-sm">({p.employeeEmail})</span> : null}
                                            </div>
                                            <div className="text-xs text-slate-400">
                                                {p.submittedAt ? `Submitted: ${fmtTimeLocal(p.submittedAt)}` : ''}
                                            </div>
                                        </div>
                                        <div className="text-xs text-slate-400">{p.date || '—'}</div>
                                        <div className="text-sm text-slate-200 mb-3">Reason: {p.reason || '—'}</div>
                                        <div className="flex gap-2">
                                            <button onClick={() => decide(p.id, 'APPROVED')} className="btn-primary">
                                                <CheckCircle2 className="h-4 w-4" />
                                                Approve
                                            </button>
                                            <button onClick={() => decide(p.id, 'REJECTED')} className="btn">
                                                Reject
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                )}

                {/* My Requests section for all users */}
                <section className="card p-6 mt-6">
                    <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
                        <Clock className="h-5 w-5 text-yellow-500" /> My Requests
                    </h2>

                    {myRequests.length === 0 ? (
                        <div className="text-sm text-slate-400">You haven't submitted any requests yet.</div>
                    ) : (
                        <ul className="space-y-3">
                            {myRequests.map(req => {
                                const statusColor = req.status === 'APPROVED' ? 'text-emerald-400 bg-emerald-950/30 border-emerald-700' : 
                                                   req.status === 'REJECTED' ? 'text-red-400 bg-red-950/30 border-red-700' : 
                                                   'text-amber-400 bg-amber-950/30 border-amber-700';
                                return (
                                    <li key={req.id} className="rounded-xl border border-slate-800 p-4">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <span className={`px-2 py-1 rounded-md text-xs font-semibold border ${statusColor}`}>
                                                    {req.status}
                                                </span>
                                                <span className="text-sm font-semibold text-slate-300">{req.date}</span>
                                            </div>
                                            <div className="text-xs text-slate-400">
                                                {req.submittedAt ? `Submitted: ${fmtTimeLocal(req.submittedAt)}` : ''}
                                            </div>
                                        </div>
                                        <div className="text-sm text-slate-200">
                                            <span className="text-slate-400">Reason:</span> {req.reason || '—'}
                                        </div>
                                        {req.status === 'REJECTED' && req.decisionNote && (
                                            <div className="mt-2 p-3 rounded-lg bg-red-950/50 border border-red-800">
                                                <div className="text-xs font-semibold text-red-400 mb-1">Denial Reason:</div>
                                                <div className="text-sm text-slate-300">{req.decisionNote}</div>
                                            </div>
                                        )}
                                        {req.decidedAt && (
                                            <div className="text-xs text-slate-500 mt-1">
                                                Decided: {fmtTimeLocal(req.decidedAt)}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </main>
        </div>
    );
}
