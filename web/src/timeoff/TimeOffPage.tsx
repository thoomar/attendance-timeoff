import React, { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { z } from 'zod';
import { CalendarDays, CheckCircle2, ClipboardList, SendHorizonal } from 'lucide-react';

const CreateReq = z.object({ dates: z.array(z.date()).min(1), reason: z.string().min(3) });
type Role = 'Enrollment Specialist'|'Senior Contract Specialist'|'Manager'|'Admin';
type User = { id: string; name: string; role: Role };
type PendingItem = { id: string; dates: string[]; reason: string; employee_name: string; employee_email: string };
type CalendarEntry = { dates: string[]; initials?: string; full_name?: string; reason?: string };

export default function TimeOffPage() {
    const [user, setUser] = useState<User | null>(null);
    const [selected, setSelected] = useState<Date[]>([]);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [pending, setPending] = useState<PendingItem[]>([]);
    const [calendar, setCalendar] = useState<CalendarEntry[]>([]);

    // NEW: Zoho connection gate
    const [zohoConnected, setZohoConnected] = useState<boolean | null>(null);
    useEffect(() => {
        fetch('/api/zoho/status')
            .then(r => r.json())
            .then(d => {
                setZohoConnected(!!d.connected);
                // If arriving from the portal with ?connected=zoho and not connected yet, kick off OAuth
                const params = new URLSearchParams(location.search);
                if (!d.connected && params.get('connected') === 'zoho') {
                    location.href = '/api/zoho/connect?returnTo=' + encodeURIComponent(location.pathname);
                }
            })
            .catch(() => setZohoConnected(false));
    }, []);

    useEffect(() => { fetch('/api/me').then(r=>r.json()).then(setUser); }, []);
    useEffect(() => {
        const from = new Date(); const to = new Date(); to.setMonth(to.getMonth()+2);
        fetch(`/api/time-off/calendar?from=${from.toISOString().slice(0,10)}&to=${to.toISOString().slice(0,10)}`)
            .then(r=>r.json()).then(d=>setCalendar(d.entries||[]));
    }, []);
    useEffect(() => {
        if (user && (user.role === 'Manager' || user.role === 'Admin')) {
            fetch('/api/time-off/pending').then(r=>r.json()).then(setPending);
        }
    }, [user]);

    const isRequester = useMemo(() => !['Manager','Admin'].includes(user?.role || ''), [user]);

    async function submit() {
        try {
            const parsed = CreateReq.parse({ dates: selected, reason });
            setSubmitting(true);
            const body = { dates: parsed.dates.map(d=>d.toISOString().slice(0,10)), reason };
            const res = await fetch('/api/time-off', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) });
            if (!res.ok) throw new Error(await res.text());
            setSelected([]); setReason('');
            alert('Request submitted!');
        } catch (e:any) {
            alert(e.message || 'Failed to submit');
        } finally { setSubmitting(false); }
    }

    async function decide(id:string, decision:'APPROVED'|'REJECTED'){
        const res = await fetch(`/api/time-off/${id}/decision`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ decision }) });
        if (res.ok) setPending(p => p.filter(i => i.id !== id));
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
                        href={`/api/zoho/connect?returnTo=${encodeURIComponent(location.pathname)}`}
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
                            onSelect={(val)=>setSelected(val || [])}
                            disabled={{ before: new Date() }}
                            className="rdp"
                        />

                        {isRequester && (
                            <div className="mt-4 space-y-3">
                <textarea
                    placeholder="Reason"
                    value={reason}
                    onChange={(e)=>setReason(e.target.value)}
                    className="w-full min-h-24 rounded-xl border border-slate-700 bg-slate-900 p-3"
                />
                                <div className="flex items-center justify-between">
                                    <div className="text-sm text-slate-400">
                                        {selected.length} day{selected.length===1?'':'s'} selected
                                    </div>
                                    <button
                                        onClick={submit}
                                        disabled={submitting || selected.length===0 || reason.length<3}
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
                                {calendar.map((e, i) => (
                                    <li key={i} className="flex items-start gap-3 text-sm">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 text-slate-200">
                      {e.initials ?? '✓'}
                    </span>
                                        <div className="space-y-0.5">
                                            {e.full_name && <div className="font-medium">{e.full_name}</div>}
                                            <div className="text-slate-300">
                                                {e.dates.join(', ')}{e.reason ? <span className="text-slate-400"> — {e.reason}</span> : null}
                                            </div>
                                        </div>
                                    </li>
                                ))}
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
                                                {p.employee_name}{' '}
                                                <span className="text-slate-400 text-sm">({p.employee_email})</span>
                                            </div>
                                            <div className="text-xs text-slate-400">
                                                {p.dates.length} day{p.dates.length===1?'':'s'}
                                            </div>
                                        </div>
                                        <div className="text-sm text-slate-200 mt-1">Dates: {p.dates.join(', ')}</div>
                                        <div className="text-sm text-slate-200 mb-3">Reason: {p.reason}</div>
                                        <div className="flex gap-2">
                                            <button onClick={()=>decide(p.id,'APPROVED')} className="btn-primary">
                                                <CheckCircle2 className="h-4 w-4" />
                                                Approve
                                            </button>
                                            <button onClick={()=>decide(p.id,'REJECTED')} className="btn">
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
