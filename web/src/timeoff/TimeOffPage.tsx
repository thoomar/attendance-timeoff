
import React, { useEffect, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { z } from 'zod';

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

  useEffect(() => {
    fetch('/api/me').then(r=>r.json()).then(setUser);
  }, []);

  useEffect(() => {
    const from = new Date();
    const to = new Date();
    to.setMonth(to.getMonth()+2);
    fetch(`/api/time-off/calendar?from=${from.toISOString().slice(0,10)}&to=${to.toISOString().slice(0,10)}`)
      .then(r=>r.json()).then(d=>setCalendar(d.entries||[]));
  }, []);

  useEffect(() => {
    if (user && (user.role === 'Manager' || user.role === 'Admin')) {
      fetch('/api/time-off/pending').then(r=>r.json()).then(setPending);
    }
  }, [user]);

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

  if (!user) return <div style={{padding:16}}>Loading…</div>;
  const isRequester = !['Manager','Admin'].includes(user.role);

  return (
    <div style={{maxWidth:960, margin:'0 auto', padding:16}}>
      <header style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <h1>Time Off</h1>
        <span style={{opacity:0.7, fontSize:12}}>Signed in as {user.name} ({user.role})</span>
      </header>

      <section style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
        <div style={{border:'1px solid #ddd', borderRadius:12, padding:12}}>
          <h2 style={{fontSize:16}}>Team Calendar</h2>
          <DayPicker
            mode="multiple"
            selected={selected}
            onSelect={(val)=>setSelected(val || [])}
            disabled={{ before: new Date() }}
          />
          {isRequester && (
            <div style={{marginTop:12}}>
              <textarea
                placeholder="Reason"
                value={reason}
                onChange={(e)=>setReason(e.target.value)}
                style={{width:'100%', minHeight:80, padding:8, borderRadius:8, border:'1px solid #ccc'}}
              />
              <button
                onClick={submit}
                disabled={submitting || selected.length===0 || reason.length<3}
                style={{marginTop:8, padding:'8px 12px', borderRadius:8, border:'1px solid #ccc'}}
              >Submit Request</button>
            </div>
          )}
        </div>

        <div style={{border:'1px solid #ddd', borderRadius:12, padding:12}}>
          <h2 style={{fontSize:16}}>Upcoming Approved Time Off</h2>
          <ul style={{listStyle:'none', padding:0}}>
            {calendar.map((e, i) => (
              <li key={i} style={{fontSize:14, display:'flex', alignItems:'center', gap:8}}>
                <span style={{display:'inline-flex', alignItems:'center', justifyContent:'center', width:28, height:28, borderRadius:999, border:'1px solid #ccc'}}>{e.initials ?? '✓'}</span>
                <span>{e.dates.join(', ')}</span>
                {e.reason && <span style={{opacity:0.6}}>— {e.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {(user.role === 'Manager' || user.role === 'Admin') && (
        <section style={{border:'1px solid #ddd', borderRadius:12, padding:12, marginTop:16}}>
          <h2 style={{fontSize:16}}>Pending Approvals</h2>
          {pending.length === 0 ? (
            <div style={{fontSize:14, opacity:0.7}}>No pending requests.</div>
          ) : (
            <ul style={{listStyle:'none', padding:0}}>
              {pending.map(p => (
                <li key={p.id} style={{border:'1px solid #eee', borderRadius:10, padding:10, marginBottom:8}}>
                  <div style={{fontWeight:600}}>{p.employee_name} <span style={{opacity:0.6}}>({p.employee_email})</span></div>
                  <div style={{fontSize:14}}>Dates: {p.dates.join(', ')}</div>
                  <div style={{fontSize:14, marginBottom:6}}>Reason: {p.reason}</div>
                  <div style={{display:'flex', gap:8}}>
                    <button onClick={()=>decide(p.id,'APPROVED')} style={{padding:'6px 10px', border:'1px solid #ccc', borderRadius:8}}>Approve</button>
                    <button onClick={()=>decide(p.id,'REJECTED')} style={{padding:'6px 10px', border:'1px solid #ccc', borderRadius:8}}>Reject</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
