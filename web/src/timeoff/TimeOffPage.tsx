import React, { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { z } from 'zod';
import { CalendarDays, CheckCircle2, ClipboardList, SendHorizonal } from 'lucide-react';

const CreateReq = z.object({ dates: z.array(z.date()).min(1), reason: z.string().min(3) });
type Role = 'Enrollment Specialist' | 'Senior Contract Specialist' | 'Manager' | 'Admin';
type User = { id: string; name: string; role: Role };

// Server calendar entry shape
type CalendarEntry = { userId: string; userName: string; dates: string[]; status: 'PENDING' | 'APPROVED' };

// We’ll normalize “pending” into this UI-friendly item
type PendingUIItem = {
    id: string;                 // single request id (per date)
    employeeName?: string;
    employeeEmail?: string;
    date: string;               // one date
    reason: string;
};

/** ----------------- Helpers for the Zoho loop fix ----------------- */
function parseZohoCallbackFlag(): boolean {
    const params = new URLSearchParams(window.location.search);
    const a = params.get('zoho') === 'connected';     // supports ?zoho=connected
    const b = params.get('connected') === 'zoho';     // supports ?connected=zoho
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

export default function TimeOffPage() {
    const [user, setUser] = useState<User | null>(null);
    const [selected, setSelected] = useState<Date[]>([]);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [pending, setPending] = useState<PendingUIItem[]>([]);
    const [calendar, setCalendar] = useState<CalendarEntry[]>([]);

    // Zoho connection gate
    const [zohoConnected, setZohoConnected] = useState<boolean | null>(null);

    // Sentinel: did we just return from Zoho?
    const justReturnedFromZoho = useMemo<boolean>(parseZohoCallbackFlag, []);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const r = await fetch('/api/zoho/status', { credentials: 'include' });
                const d = await r.json();
                if (cancelled) return;

                // ensure boolean (not string | null)
                const isConnected = Boolean(d?.connected);
                setZohoConnected(isConnected);

                // If connected and came back with a query flag, clean the URL once
                if (isConnected && justReturnedFromZoho) {
                    stripQueryParams();
                    return;
                }

                // If NOT connected and we did NOT just return from Zoho, start OAuth exactly once
                if (!isConnected && !justReturnedFromZoho) {
                    const returnTo = '/'; // Landing page after consent
                    window.location.assign(`/api/zoho/start?returnTo=${encodeURIComponent(returnTo)}`);
                }
                // If not connected but we *did* just return, wait for next pass (server may be finalizing)

            } catch (_e) {
                if (!cancelled) setZohoConnected(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [justReturnedFromZoho]);

    useEffect(() => {
        fetch('/api/me').then(r => r.json()).then(setUser).catch(() => setUser(null));
    }, []);

    useEffect(() => {
        const from = new Date();
        const to = new Date();
        to.setMonth(to.getMonth() + 2);
        const qs = `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`;
        fetch(`/api/time-off/calendar?${qs}`)
            .then(r => r.json())
            .then(d => setCalendar(Array.isArray(d.entries) ? d.entries : []))
            .catch(() => setCalendar([]));
    }, []);

    useEffect(() => {
        if (!user) return;
        if (user.role === 'Manager' || user.role === 'Admin') {
            fetch('/api/time-off/pending')
                .then(r => r.json())
                .then((raw: any) => {
                    // Normalize either grouped response or flat items
                    // Grouped example item: { employee_user_id, start, end, reason, ids: [...] }
                    // Flat example item: { id, employee_user_id, date, reason, status, full_name?, email? }
                    const out: PendingUIItem[] = [];
                    if (Array.isArray(raw)) {
                        for (const item of raw) {
                            if (Array.isArray(item?.ids) && (item.start || item.end)) {
                                for (const id of item.ids) {
                                    out.push({
                                        id,
                                        employeeName: item.full_name ?? undefined,
                                        employeeEmail: item.email ?? undefined,
                                        date:
                                            (item.start ?? '').slice(0, 10) +
                                            (item.end && item.end !== item.start ? ` – ${String(item.end).slice(0, 10)}` : ''),
                                        reason: item.reason ?? '',
                                    });
                                }
                            } else if (item?.id) {
                                out.push({
                                    id: item.id,
                                    employeeName: item.full_name ?? undefined,
                                    employeeEmail: item.email ?? undefined,
                                    date: (item.date ?? '').slice(0, 10),
                                    reason: item.reason ?? '',
                                });
                            }
                        }
                    }
                    setPending(out);
                })
                .catch(() => setPending([]));
        }
    }, [user]);

    const isRequester = useMemo(() => !['Manager', 'Admin'].includes(user?.role || ''), [user]);

    async function submit() {
        try {
            const parsed = CreateReq.parse({ dates: selected, reason });
            setSubmitting(true);
            const body = { dates: parsed.dates.map(d => d.toISOString().slice(0, 10)), reason };

            const res = await fetch('/api/time-off/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
        } catch (e: any) {
            alert(e?.message || 'Failed to submit');
        } finally {
            setSubmitting(false);
        }
    }

    async function decide(id: string, decision: 'APPROVED' | 'REJECTED') {
        try {
            const res = await fetch(`/api/time-off/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, decision }),
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(txt);
            }
            setPending(p => p.filter(i => i.id !== id));
        } catch (e: any) {
            alert(e?.message || 'Failed to update');
        }
    }

    // Loading states
    if (!user) return <div className="p-6 text-sm text-slate-400">Loading…</div>;
    if (zohoConnected === null) return <div className="p-6 text-sm text-slate-400">Checking Zoho…</div>;

    if (!zohoConnected) {
        return (
            <div className="min-h-dvh flex items-center justify-center p-6">
                <div className="card p-8 max-w-md w-full space-y-4">
                    <h2 className="text-lg font-semibold">Connect Zoho</h2>
                    <p className="text-slate-400 text-sm">Please connect your Zoho account to continue.</p>
                    <a
                        href={`/api/zoho/start?returnTo=${encodeURIComponent('/')}`}
                        className="btn-primary inline-flex"
                    >
                        Connect Zoho
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-dvh">
            {/* Top bar with dark logo */}
            <header className="sticky top-0 z-30 backdrop-blur bg-black/40 border-b border-slate-800">
                <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="relative h-9 w-9">
                            <div className="absolute inset-0 rounded-xl bg-blue-600/30 blur-md"></div>
                            <div className="relative h-full w-full rounded-xl bg-gradient-to-br from-blue-600 to-indigo-500"></div>
                        </div>
                        <span className="text-lg font-semibold tracking-tight">Time Off</span>
                    </div>
                    <span className="text-xs text-slate-400">
            Signed in as {user.name} ({user.role})
          </span>
                </div>
            </header>

            {/* Page */}
            <main className="mx-auto max-w-6xl px-6 py-8">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* LEFT: Calendar + request form */}
                    <section className="card p-6">
                        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
                            <CalendarDays className="h-5 w-5 text-blue-400" /> Team Calendar
                        </h2>

                        <DayPicker
                            mode="multiple"
                            selected={selected}
                            onSelect={(val) => setSelected(val || [])}
                            disabled={{ before: new Date() }}
                            className="rdp"
                        />

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

                    {/* RIGHT: Upcoming approved */}
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
                                    return (
                                        <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 text-slate-200">
                        {initials}
                      </span>
                                            <div className="space-y-0.5">
                                                {e.userName && <div className="font-medium">{e.userName}</div>}
                                                <div className="text-slate-300">
                                                    {e.dates.join(', ')}{' '}
                                                    {e.status === 'PENDING' ? <span className="text-amber-400">(pending)</span> : null}
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
                                                {p.date || '—'}
                                            </div>
                                        </div>
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
            </main>
        </div>
    );
}
