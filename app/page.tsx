'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  Calendar, ChevronRight, Command, Home, Kanban, LayoutGrid, LogOut, Menu, Plus, Search,
  Settings, Users, CheckCircle2, Clock3, Phone, Mail, MessageCircle, Globe, MapPin, Sun, Moon,
  X, ArrowUpRight, Trash2, Pencil, Save
} from 'lucide-react'
import { startOfWeek, addDays, addWeeks, format, isSameDay } from 'date-fns'

const stages = ['Prospect','Cold DM Reply','Cold DM No Reply','Cold Call','Cold Call Failed','Qualified Lead','Discovery Call','Proposal Agreement Sent','Close Call','Verbal Approval','Agreement Signed','Initial Payment Received','Closed & Onboarding','Future Opportunity','Lost Opportunity']
const siteOptions = ['No Site','Not Working','Outdated','Not Good','Coming Soon / Under Construction','Decent','Good']
const clientTypes = ['old','not active','active','very active']
const activityTypes = [
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'instagram', label: 'Instagram DM' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'note', label: 'Note' },
]

function money(n: number | null) {
  return n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}
function initials(n: string) {
  return n.split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase()
}
function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

export default function Page() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [meetings, setMeetings] = useState<any[]>([])
  const [googleConn, setGoogleConn] = useState<any>(null)
  const [view, setView] = useState('home')
  const [selected, setSelected] = useState<any>(null)
  const [dark, setDark] = useState(false)
  const [q, setQ] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [editCompany, setEditCompany] = useState<any>(null)
  const [showActivity, setShowActivity] = useState<any>(null)
  const [showMeeting, setShowMeeting] = useState<any>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [ai, setAi] = useState('')
  const [aiResult, setAiResult] = useState<any[]>([])
  const searchRef = useRef<HTMLInputElement>(null)

  async function loadMeetings() {
    const { data: mt } = await supabase.from('meetings').select('*,companies(name)').order('starts_at', { ascending: true })
    setMeetings(mt || [])
  }

  async function loadGoogleConn() {
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) { setGoogleConn(null); return }
    // Only select non-secret columns here — this row also holds the OAuth access/refresh tokens,
    // and those should never leave the server or sit in client-side state.
    const { data: conn } = await supabase
      .from('calendar_connections')
      .select('user_id,connected_email,calendar_id,updated_at')
      .eq('user_id', auth.user.id)
      .maybeSingle()
    setGoogleConn(conn || null)
  }

  async function loadAll() {
    const [{ data: comp }, { data: tk }] = await Promise.all([
      supabase.from('companies').select('*,contacts(*),activities(*)').order('updated_at', { ascending: false }),
      supabase.from('tasks').select('*,companies(name)').order('due_at', { ascending: true, nullsFirst: false }),
    ])
    setCompanies((comp || []).map((x: any) => ({ ...x, contact: x.contacts?.[0] || null })))
    setTasks(tk || [])
    await Promise.all([loadMeetings(), loadGoogleConn()])
  }

  async function syncGoogleCalendar(manual = false) {
    const res = await fetch('/api/calendar/sync', { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (manual) alert(json.error || 'Could not sync with Google Calendar. Try reconnecting it in Settings.')
      return
    }
    await loadMeetings()
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setUser(data.session?.user || null)
      if (data.session?.user) await loadAll()
      setLoading(false)
    })
    const { data: l } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setUser(s?.user || null)
      if (s?.user) await loadAll()
    })
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const cal = params.get('calendar')
      if (cal === 'connected') {
        syncGoogleCalendar()
        window.history.replaceState({}, '', window.location.pathname)
      } else if (cal === 'error') {
        alert('Could not connect Google Calendar: ' + (params.get('reason') || 'unknown error'))
        window.history.replaceState({}, '', window.location.pathname)
      }
    }
    return () => l.subscription.unsubscribe()
  }, [])

  // The ⌘K hint next to the search box used to be decorative — wire it to actually focus search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Actually searches what the placeholder promises — companies, their contacts, and notes/activity
  // text — instead of just company name/website/address/status.
  const filtered = useMemo(() => {
    const needle = q.toLowerCase()
    if (!needle) return companies
    return companies.filter(c => {
      const haystack = [
        c.name, c.website, c.address, c.lead_status, c.remarks, c.company_email, c.company_phone,
        ...(c.contacts || []).flatMap((ct: any) => [ct.name, ct.email, ct.phone]),
        ...(c.activities || []).flatMap((a: any) => [a.title, a.body]),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [companies, q])

  async function login(e: React.FormEvent) {
    e.preventDefault()
    const f = new FormData(e.currentTarget as HTMLFormElement)
    const username = String(f.get('username'))
    const password = String(f.get('password'))
    const email = username.includes('@') ? username : `${username}@vesper.local`
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) alert(error.message)
  }
  async function logout() {
    await supabase.auth.signOut()
    setUser(null); setCompanies([]); setTasks([]); setMeetings([]); setSelected(null); setView('home')
  }

  async function addCompany(c: any) {
    const { data: auth } = await supabase.auth.getUser()
    const { data: row, error } = await supabase.from('companies').insert({
      name: c.name, lead_status: c.lead_status, lead_score: c.lead_score, website: c.website,
      site_condition: c.site_condition, gbp: c.gbp, deal_value: c.deal_value, deal_value_type: c.deal_value_type,
      client_type: c.client_type, company_email: c.company_email, company_phone: c.company_phone,
      instagram: c.instagram, linkedin: c.linkedin, address: c.address, remarks: c.remarks, owner_id: auth.user?.id,
    }).select().single()
    if (error) { alert(error.message); return }
    let contact = null
    if (c.contact?.name) {
      const { data: ct } = await supabase.from('contacts').insert({
        company_id: row.id, name: c.contact.name, title: c.contact.title, email: c.contact.email,
        phone: c.contact.phone, instagram: c.contact.instagram, linkedin: c.contact.linkedin, is_primary: true,
      }).select().single()
      contact = ct
    }
    await supabase.from('activities').insert({ company_id: row.id, user_id: auth.user?.id, type: 'system', title: 'Prospect added' })
    setCompanies(x => [{ ...row, contact, activities: [{ title: 'Prospect added', type: 'system', occurred_at: new Date().toISOString() }] }, ...x])
    setShowNew(false); setView('companies')
  }

  async function updateCompany(id: string, patch: any) {
    const { data, error } = await supabase.from('companies').update(patch).eq('id', id).select('*,contacts(*),activities(*)').single()
    if (error) { alert(error.message); return null }
    const updated = { ...data, contact: data.contacts?.[0] || null }
    setCompanies(x => x.map(z => (z.id === id ? updated : z)))
    return updated
  }
  async function handleStageChange(id: string, patch: any) {
    const updated = await updateCompany(id, patch)
    if (updated && selected?.id === id) setSelected(updated)
  }
  async function handleSaveNotes(id: string, remarks: string) {
    const updated = await updateCompany(id, { remarks })
    if (updated && selected?.id === id) setSelected(updated)
  }

  async function refetchCompany(id: string, alsoSelect = false) {
    const { data, error } = await supabase.from('companies').select('*,contacts(*),activities(*)').eq('id', id).single()
    if (error) { alert(error.message); return null }
    const updated = { ...data, contact: data.contacts?.[0] || null }
    setCompanies(x => x.map(z => (z.id === id ? updated : z)))
    if (alsoSelect) setSelected(updated)
    return updated
  }

  async function saveEditedCompany(id: string, c: any) {
    const { error } = await supabase.from('companies').update({
      name: c.name, lead_status: c.lead_status, lead_score: c.lead_score, website: c.website,
      site_condition: c.site_condition, gbp: c.gbp, deal_value: c.deal_value, deal_value_type: c.deal_value_type,
      client_type: c.client_type, company_email: c.company_email, company_phone: c.company_phone,
      instagram: c.instagram, linkedin: c.linkedin, address: c.address, remarks: c.remarks,
    }).eq('id', id)
    if (error) { alert(error.message); return }
    if (c.contact?.name) {
      if (c.contact.id) {
        await supabase.from('contacts').update({
          name: c.contact.name, title: c.contact.title, email: c.contact.email, phone: c.contact.phone,
          instagram: c.contact.instagram, linkedin: c.contact.linkedin,
        }).eq('id', c.contact.id)
      } else {
        await supabase.from('contacts').insert({
          company_id: id, name: c.contact.name, title: c.contact.title, email: c.contact.email,
          phone: c.contact.phone, instagram: c.contact.instagram, linkedin: c.contact.linkedin, is_primary: true,
        })
      }
    }
    await refetchCompany(id, selected?.id === id)
    setEditCompany(null)
  }

  async function deleteCompany(id: string) {
    if (!confirm('Delete this company? This cannot be undone.')) return
    setDeletingId(id)
    try {
      // Cancel the Google Calendar event for every meeting this company has, BEFORE deleting
      // the company — in parallel, not one at a time, since each is an independent network call
      // to Google and there's no reason to pay for them sequentially (this was the main source
      // of "delete feels slow" when a company had more than one meeting). Otherwise: the DB
      // cascade-deletes the local `meetings` rows, the Google event is left dangling, and the
      // next calendar sync re-imports it as a new, company-less meeting. Best-effort: a failed
      // Google call doesn't block deleting the company.
      const linkedMeetings = meetings.filter(m => m.company_id === id && m.google_event_id)
      await Promise.all(linkedMeetings.map(m =>
        fetch(`/api/calendar/events?eventId=${encodeURIComponent(m.google_event_id)}`, { method: 'DELETE' }).catch(() => {})
      ))
      const { error } = await supabase.from('companies').delete().eq('id', id)
      if (error) { alert(error.message); return }
      setCompanies(x => x.filter(z => z.id !== id))
      setMeetings(x => x.filter(m => m.company_id !== id))
      setSelected(null); setView('companies')
    } finally {
      setDeletingId(null)
    }
  }

  async function addActivity(company: any, a: { type: string; title: string; body?: string }) {
    const { data: auth } = await supabase.auth.getUser()
    const { error } = await supabase.from('activities').insert({ company_id: company.id, user_id: auth.user?.id, type: a.type, title: a.title, body: a.body || null })
    if (error) { alert(error.message); return }
    await refetchCompany(company.id, selected?.id === company.id)
    setShowActivity(null)
  }

  async function addTask(t: { title: string; due_at?: string | null; company_id?: string | null }) {
    const { data: auth } = await supabase.auth.getUser()
    const { data, error } = await supabase.from('tasks').insert({
      title: t.title, due_at: t.due_at || null, company_id: t.company_id || null, assigned_to: auth.user?.id,
    }).select('*,companies(name)').single()
    if (error) { alert(error.message); return }
    setTasks(x => [...x, data])
  }
  async function toggleTask(id: string, completed: boolean) {
    const { error } = await supabase.from('tasks').update({ completed }).eq('id', id)
    if (error) { alert(error.message); return }
    setTasks(x => x.map(t => (t.id === id ? { ...t, completed } : t)))
  }

  async function scheduleMeeting(company: any, m: { title: string; starts_at: string; ends_at: string; location?: string }) {
    // The Google Calendar round trip (creating the event + provisioning a Meet link) is the one
    // genuinely slow step here and can't be shortened from our side — but everything that used
    // to run strictly AFTER it in sequence didn't need to: auth.getUser() doesn't depend on the
    // calendar call, so it runs alongside it instead of after. And logging the activity +
    // refetching the company's full activity feed doesn't need to finish before the modal
    // closes, since the meeting itself is already visible on the Calendar view once inserted —
    // so that part now runs in the background instead of blocking the close.
    const [res, authRes] = await Promise.all([
      fetch('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: m.title, description: `VESPER meeting with ${company.name}`, location: m.location || '', starts_at: m.starts_at, ends_at: m.ends_at }),
      }),
      supabase.auth.getUser(),
    ])
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { alert(json.error || 'Could not create the calendar event. Connect Google Calendar in Settings first.'); return }
    const auth = authRes.data
    const ev = json.event
    const { data: row, error } = await supabase.from('meetings').insert({
      company_id: company.id, created_by: auth.user?.id, title: m.title, starts_at: m.starts_at, ends_at: m.ends_at,
      location: m.location || null, google_event_id: ev?.id || null, google_calendar_id: 'primary',
      google_meet_url: ev?.hangoutLink || null, status: 'scheduled',
    }).select('*,companies(name)').single()
    if (error) { alert(error.message); return }
    setMeetings(x => [...x, row].sort((a, b) => a.starts_at.localeCompare(b.starts_at)))
    setShowMeeting(null)
    supabase.from('activities').insert({ company_id: company.id, user_id: auth.user?.id, type: 'meeting', title: m.title, occurred_at: m.starts_at })
      .then(() => refetchCompany(company.id, selected?.id === company.id))
  }

  function runAI() {
    const s = ai.toLowerCase(); let r = companies
    if (s.includes('state') || s.includes('city') || s.includes('in ')) { const words = s.split(/\s+/); const candidate = words[words.length - 1].replace(/[?.]/g, ''); r = companies.filter(c => (c.address || '').toLowerCase().includes(candidate)) }
    if (s.includes('qualified')) r = companies.filter(c => c.lead_status === 'Qualified Lead')
    if (s.includes('website') && s.includes('no')) r = companies.filter(c => c.site_condition === 'No Site')
    if (s.includes('meeting')) r = companies.filter(c => c.activities?.some((a: any) => a.type === 'meeting'))
    setAiResult(r)
  }

  if (loading) return <div className="splash">VESPER</div>
  if (!user) return (
    <div className="login">
      <div className="login-card">
        <div className="brand">V</div>
        <h1>Welcome to VESPER</h1>
        <p>Outreach, without the clutter.</p>
        <form onSubmit={login}>
          <input name="username" placeholder="Username" />
          <input name="password" type="password" placeholder="Password" />
          <button>Sign in</button>
        </form>
        <small>Use the Supabase user credentials created for your two VESPER accounts.</small>
      </div>
    </div>
  )

  return (
    <div className={dark ? 'app dark' : 'app'}>
      <aside>
        <div className="side-brand"><div className="mini-logo">V</div><b>VESPER</b></div>
        <nav>
          <Nav active={view === 'home'} icon={<Home />} label="Today" onClick={() => setView('home')} />
          <Nav active={view === 'pipeline'} icon={<Kanban />} label="Pipeline" onClick={() => setView('pipeline')} />
          <Nav active={view === 'companies'} icon={<Users />} label="Companies" onClick={() => setView('companies')} />
          <Nav active={view === 'calendar'} icon={<Calendar />} label="Calendar" onClick={() => setView('calendar')} />
          <Nav active={view === 'tasks'} icon={<CheckCircle2 />} label="Tasks" onClick={() => setView('tasks')} />
        </nav>
        <div className="side-bottom">
          <Nav active={false} icon={<Settings />} label="Settings" onClick={() => setView('settings')} />
          <button className="logout" onClick={logout}><LogOut /> Sign out</button>
        </div>
      </aside>
      <main>
        <header>
          <div className="mobile-brand">VESPER</div>
          <div className="search"><Search /><input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search companies, people, notes..." /><kbd>⌘ K</kbd></div>
          <div className="header-actions">
            <button onClick={() => setDark(!dark)} className="icon-btn">{dark ? <Sun /> : <Moon />}</button>
            <button className="primary" onClick={() => setShowNew(true)}><Plus /> New company</button>
            <div className="avatar">{initials(user.user_metadata?.display_name || user.email || 'V')}</div>
          </div>
        </header>
        <div className="content">
          {view === 'home' && <HomeView companies={companies} meetings={meetings} onOpen={(c: any) => { setSelected(c); setView('detail') }} onNew={() => setShowNew(true)} onGoCalendar={() => setView('calendar')} />}
          {view === 'pipeline' && <Pipeline companies={filtered} onOpen={(c: any) => { setSelected(c); setView('detail') }} onUpdate={handleStageChange} />}
          {view === 'companies' && <Companies companies={filtered} onOpen={(c: any) => { setSelected(c); setView('detail') }} onNew={() => setShowNew(true)} />}
          {view === 'calendar' && <CalendarView meetings={meetings} googleConn={googleConn} onSync={syncGoogleCalendar} />}
          {view === 'tasks' && <Tasks tasks={tasks} companies={companies} onToggle={toggleTask} onAdd={addTask} />}
          {view === 'settings' && <SettingsView googleConn={googleConn} />}
          {view === 'detail' && selected && (
            <Detail
              c={selected}
              onBack={() => setView('companies')}
              onUpdate={handleStageChange}
              onEdit={(c: any) => setEditCompany(c)}
              onDelete={deleteCompany}
              onAddActivity={(c: any) => setShowActivity(c)}
              onScheduleMeeting={(c: any) => setShowMeeting(c)}
              onSaveNotes={handleSaveNotes}
              deleting={deletingId === selected.id}
            />
          )}
        </div>
      </main>
      <button className="ai-fab" onClick={() => { const v = prompt('Ask VESPER anything about your CRM'); if (v) { setAi(v); setTimeout(runAI, 0); setView('companies') } }}><Command /></button>
      {showNew && <CompanyForm onClose={() => setShowNew(false)} onSave={addCompany} />}
      {editCompany && <CompanyForm initial={editCompany} onClose={() => setEditCompany(null)} onSave={(f: any) => saveEditedCompany(editCompany.id, f)} />}
      {showActivity && <AddActivity company={showActivity} onClose={() => setShowActivity(null)} onSave={(a: any) => addActivity(showActivity, a)} />}
      {showMeeting && <NewMeetingForm company={showMeeting} onClose={() => setShowMeeting(null)} onSave={(m: any) => scheduleMeeting(showMeeting, m)} />}
      {aiResult.length > 0 && <div className="toast"><b>VESPER found {aiResult.length}</b><button onClick={() => setAiResult([])}><X /></button></div>}
    </div>
  )
}

function Nav({ active, icon, label, onClick }: { active: boolean; icon: any; label: string; onClick: () => void }) {
  return <button className={active ? 'nav active' : 'nav'} onClick={onClick}>{icon}<span>{label}</span></button>
}

function HomeView({ companies, meetings, onOpen, onNew, onGoCalendar }: { companies: any[]; meetings: any[]; onOpen: any; onNew: any; onGoCalendar: any }) {
  const upcoming = meetings.filter(m => new Date(m.starts_at) >= new Date(Date.now() - 3600000)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const qualified = companies.filter(c => c.lead_status === 'Qualified Lead').length

  // Real stalled-opportunity detection, replacing the placeholder card that used to claim this
  // existed. "Stalled" = an open (not closed/lost/future) company with no logged activity, and
  // no update to the record itself, in the last 14 days.
  const closedStages = ['Closed & Onboarding', 'Lost Opportunity', 'Future Opportunity']
  const stalled = companies
    .filter(c => !closedStages.includes(c.lead_status))
    .map(c => {
      const lastActivity = (c.activities || []).reduce((max: string | null, a: any) => (!max || a.occurred_at > max) ? a.occurred_at : max, null)
      const lastTouch = lastActivity || c.updated_at
      const days = lastTouch ? Math.floor((Date.now() - new Date(lastTouch).getTime()) / 86400000) : null
      return { ...c, daysSinceTouch: days }
    })
    .filter(c => c.daysSinceTouch == null || c.daysSinceTouch >= 14)
    .sort((a, b) => (b.daysSinceTouch ?? 9999) - (a.daysSinceTouch ?? 9999))
    .slice(0, 4)

  return (
    <>
      <div className="page-title"><div><div className="eyebrow">OUTREACH CRM</div><h1>Good morning.</h1><p>Here’s what needs your attention.</p></div><button className="ghost" onClick={onNew}><Plus /> Add prospect</button></div>
      <div className="metrics">
        <Metric label="Prospects" value={companies.length} />
        <Metric label="Qualified leads" value={qualified} />
        <Metric label="Meetings" value={meetings.length} />
        <Metric label="Pipeline value" value={money(companies.reduce((s, c) => s + (c.deal_value || 0), 0))} />
      </div>
      <div className="grid2">
        <section className="panel">
          <div className="panel-head"><h2>Up next</h2><button onClick={onGoCalendar} className="text-btn">View calendar <ArrowUpRight /></button></div>
          {upcoming.length ? upcoming.slice(0, 4).map((m: any) => (
            <div className="meeting" key={m.id}>
              <div className="time"><b>{new Date(m.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b><span>{new Date(m.starts_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></div>
              <div><b>{m.companies?.name || '—'}</b><p>{m.meeting_type || 'Meeting'}{m.google_meet_url ? ' · Google Meet' : ''}</p></div>
              <ChevronRight />
            </div>
          )) : <Empty title="No meetings yet" text="Meetings you schedule from a company page will appear here." />}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Needs attention</h2></div>
          {stalled.length ? stalled.map((c: any) => (
            <Attention
              key={c.id}
              icon={<Clock3 />}
              title={c.name}
              text={c.daysSinceTouch == null ? `No activity logged · ${c.lead_status}` : `No activity in ${c.daysSinceTouch} days · ${c.lead_status}`}
              onClick={() => onOpen(c)}
            />
          )) : <Attention icon={<CheckCircle2 />} title="Nothing stalled" text="Every open opportunity has had activity in the last 2 weeks." />}
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><h2>Recent prospects</h2><button className="text-btn" onClick={() => onNew()}>Add new <Plus /></button></div>
        {companies.length ? (
          <div className="table">
            {companies.slice(0, 5).map(c => (
              <div className="row" key={c.id} onClick={() => onOpen(c)}>
                <div className="company"><div className="logo-dot">{initials(c.name)}</div><div><b>{c.name}</b><span>{c.website}</span></div></div>
                <Status s={c.lead_status} /><span>{c.site_condition}</span><span>{money(c.deal_value)}</span><ChevronRight />
              </div>
            ))}
          </div>
        ) : <Empty title="No prospects yet" text="Add your first company to get started." />}
      </section>
    </>
  )
}
function Metric({ label, value }: { label: string; value: any }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
function Attention({ icon, title, text, onClick }: { icon: any; title: string; text: string; onClick?: () => void }) {
  return <div className="attention" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>{icon}<div><b>{title}</b><p>{text}</p></div></div>
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><b>{title}</b><p>{text}</p></div> }
function Status({ s }: { s: string }) { return <span className={'status ' + s.toLowerCase().replaceAll(' ', '-')}>{s}</span> }

function Pipeline({ companies, onOpen, onUpdate }: { companies: any[]; onOpen: any; onUpdate: any }) {
  const [dragId, setDragId] = useState<string | null>(null)
  return (
    <>
      <div className="page-title"><div><div className="eyebrow">PIPELINE</div><h1>Opportunity flow.</h1><p>Business progress stays here. Outreach actions live in the timeline.</p></div></div>
      <div className="kanban">
        {stages.map(stage => (
          <div className="column" key={stage} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragId) onUpdate(dragId, { lead_status: stage }); setDragId(null) }}>
            <div className="col-head"><b>{stage}</b><span>{companies.filter(c => c.lead_status === stage).length}</span></div>
            {companies.filter(c => c.lead_status === stage).map(c => (
              <div className="deal-card" key={c.id} draggable onDragStart={() => setDragId(c.id)} onDragEnd={() => setDragId(null)} onClick={() => onOpen(c)}>
                <div className="card-top"><b>{c.name}</b><span>{c.lead_score}</span></div>
                <p>{c.contact?.name || 'Decision maker'}</p>
                <div className="card-bottom"><span>{money(c.deal_value)}</span><span>{c.site_condition}</span></div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

function Companies({ companies, onOpen, onNew }: { companies: any[]; onOpen: any; onNew: any }) {
  const [filter, setFilter] = useState<'all' | 'qualified' | 'active'>('all')
  const shown = companies.filter(c => (filter === 'all' ? true : filter === 'qualified' ? c.lead_status === 'Qualified Lead' : c.client_type === 'active'))
  return (
    <>
      <div className="page-title"><div><div className="eyebrow">DATABASE</div><h1>Companies.</h1><p>Every prospect, lead and opportunity in one place.</p></div><button className="primary" onClick={onNew}><Plus /> New company</button></div>
      <div className="filterbar">
        <span>{shown.length} companies</span>
        <div>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'qualified' ? 'active' : ''} onClick={() => setFilter('qualified')}>Qualified</button>
          <button className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>Active</button>
        </div>
      </div>
      <div className="company-list">
        {shown.length ? shown.map(c => (
          <div className="company-card" key={c.id} onClick={() => onOpen(c)}>
            <div className="logo-dot big">{initials(c.name)}</div>
            <div className="cc-main">
              <div className="cc-title"><h3>{c.name}</h3><Status s={c.lead_status} /></div>
              <p>{c.contact?.name || 'No decision maker'} · {c.website || 'No website'}</p>
              <div className="chips"><span>Score {c.lead_score}</span><span>{c.site_condition}</span><span>{c.gbp ? 'GBP' : 'No GBP'}</span></div>
            </div>
            <div className="cc-value"><span>Deal value</span><b>{money(c.deal_value)}</b></div>
            <ChevronRight />
          </div>
        )) : <Empty title="No companies yet" text="Add your first prospect to get started." />}
      </div>
    </>
  )
}

function Detail({ c, onBack, onUpdate, onEdit, onDelete, onAddActivity, onScheduleMeeting, onSaveNotes, deleting }: { c: any; onBack: any; onUpdate: any; onEdit: any; onDelete: any; onAddActivity: any; onScheduleMeeting: any; onSaveNotes: any; deleting?: boolean }) {
  const [tab, setTab] = useState('overview')
  const [notes, setNotes] = useState(c.remarks || '')
  useEffect(() => { setNotes(c.remarks || '') }, [c.id])
  const idx = stages.indexOf(c.lead_status)
  return (
    <>
      <button className="back" onClick={onBack}>← Companies</button>
      <div className="detail-head">
        <div className="logo-dot xl">{initials(c.name)}</div>
        <div><div className="eyebrow">COMPANY</div><h1>{c.name}</h1><p>{c.website || 'No website'} · {c.address || 'No address'}</p></div>
        <div className="detail-actions">
          <button className="ghost" onClick={() => onScheduleMeeting(c)}><Calendar /> New meeting</button>
          <button className="primary" onClick={() => onAddActivity(c)}><Plus /> Activity</button>
          <button className="icon-btn" onClick={() => onEdit(c)} title="Edit"><Pencil /></button>
          <button className="icon-btn" onClick={() => onDelete(c.id)} disabled={deleting} title={deleting ? 'Deleting\u2026' : 'Delete'} style={deleting ? { opacity: 0.5, cursor: 'wait' } : undefined}><Trash2 /></button>
        </div>
      </div>
      <div className="detail-stage">
        <div className="stage-line">
          {stages.map((s, i) => (
            <div className={c.lead_status === s ? 'stage active' : i < idx ? 'stage done' : 'stage'} key={s} onClick={() => onUpdate(c.id, { lead_status: s })} style={{ cursor: 'pointer' }}>
              <span>{i + 1}</span><small>{s}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>Notes</button>
      </div>
      {tab === 'overview' ? (
        <div className="detail-grid">
          <section className="panel">
            <div className="panel-head"><h2>Company</h2></div>
            <Info label="Lead status" value={c.lead_status} /><Info label="Lead score" value={`${c.lead_score}/100`} /><Info label="Website condition" value={c.site_condition} /><Info label="GBP" value={c.gbp ? 'Yes' : 'No'} /><Info label="Deal value" value={money(c.deal_value)} /><Info label="Client type" value={c.client_type} /><Info label="Email" value={c.company_email} /><Info label="Phone" value={c.company_phone} /><Info label="Address" value={c.address} /><Info label="Remarks" value={c.remarks} />
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Founder / decision maker</h2></div>
            <Info label="Name" value={c.contact?.name} /><Info label="Title" value={c.contact?.title} /><Info label="Email" value={c.contact?.email} /><Info label="Phone" value={c.contact?.phone} /><Info label="Instagram" value={c.contact?.instagram} /><Info label="LinkedIn" value={c.contact?.linkedin} />
            <div className="quick-links"><a href={c.website?.startsWith('http') ? c.website : `https://${c.website || ''}`}><Globe /> Website</a><a href={`mailto:${c.company_email}`}><Mail /> Email</a><a href={`tel:${c.company_phone}`}><Phone /> Call</a></div>
          </section>
        </div>
      ) : tab === 'activity' ? (
        <section className="panel timeline">
          {(c.activities || []).length ? [...(c.activities || [])].sort((a: any, b: any) => (b.occurred_at || '').localeCompare(a.occurred_at || '')).map((a: any, i: number) => (
            <div className="timeline-item" key={a.id || i}>
              <div className="timeline-icon">{a.type === 'email' ? <Mail /> : a.type === 'linkedin' ? <Globe /> : a.type === 'instagram' ? <MessageCircle /> : a.type === 'call' ? <Phone /> : a.type === 'meeting' ? <Calendar /> : <Clock3 />}</div>
              <div><b>{a.title}</b>{a.body ? <p style={{ color: 'var(--text)' }}>{a.body}</p> : null}<p>{new Date(a.occurred_at).toLocaleString()}</p></div>
            </div>
          )) : <Empty title="No activity yet" text="Log a call, email or DM with the Activity button above." />}
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head"><h2>Notes</h2><button className="text-btn" onClick={() => onSaveNotes(c.id, notes)}><Save /> Save</button></div>
          <textarea className="notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Write notes..." />
        </section>
      )}
    </>
  )
}
function Info({ label, value }: { label: string; value: any }) { return <div className="info"><span>{label}</span><b>{value || '—'}</b></div> }

function CalendarView({ meetings, googleConn, onSync }: { meetings: any[]; googleConn: any; onSync: (manual?: boolean) => void | Promise<void> }) {
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [syncing, setSyncing] = useState(false)
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(weekStart, i))

  // While this view is open and Google is connected, pull in any events created or changed
  // directly on Google Calendar every 60s. This is poll-based, not instant push — a real-time
  // webhook needs a public HTTPS callback URL, which localhost doesn't have.
  useEffect(() => {
    if (!googleConn) return
    onSync()
    const id = setInterval(() => onSync(), 60000)
    return () => clearInterval(id)
  }, [googleConn])

  async function handleSyncClick() {
    setSyncing(true)
    await onSync(true)
    setSyncing(false)
  }

  return (
    <>
      <div className="page-title">
        <div><div className="eyebrow">CALENDAR</div><h1>Your week.</h1><p>Meetings scheduled in VESPER sync to Google Calendar automatically.</p></div>
        {googleConn ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="status active">Connected · {googleConn.connected_email || 'Google'}</span>
            <button className="primary" onClick={handleSyncClick} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync now'}</button>
          </div>
        ) : (
          <a className="primary link" href="/api/calendar/auth">Connect Google Calendar</a>
        )}
      </div>
      <div className="calendar-panel panel">
        <div className="calendar-top">
          <b>{format(weekStart, 'MMMM yyyy')}</b>
          <div>
            <button onClick={() => setWeekStart(w => addWeeks(w, -1))}>‹</button>
            <button onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}>Today</button>
            <button onClick={() => setWeekStart(w => addWeeks(w, 1))}>›</button>
          </div>
        </div>
        <div className="week-head">{days.map(d => <span key={d.toISOString()}>{format(d, 'EEE')}</span>)}</div>
        <div className="week-grid">
          {days.map(d => {
            const dayMeetings = meetings.filter(m => isSameDay(new Date(m.starts_at), d))
            return (
              <div className="day" key={d.toISOString()}>
                <b>{format(d, 'd')}</b>
                {dayMeetings.map((m: any) => (
                  <div className="cal-event" key={m.id}><strong>{m.companies?.name || m.title}</strong><small>{m.title}{m.google_meet_url ? ' · Meet' : ''}</small></div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function Tasks({ tasks, companies, onToggle, onAdd }: { tasks: any[]; companies: any[]; onToggle: any; onAdd: any }) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [companyId, setCompanyId] = useState('')
  const open = tasks.filter(t => !t.completed)
  const done = tasks.filter(t => t.completed)
  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    onAdd({ title: title.trim(), due_at: due ? new Date(due).toISOString() : null, company_id: companyId || null })
    setTitle(''); setDue(''); setCompanyId('')
  }
  return (
    <>
      <div className="page-title"><div><div className="eyebrow">FOLLOW-UPS</div><h1>Keep moving.</h1><p>Your next action should never disappear.</p></div></div>
      <section className="panel">
        <form onSubmit={submit} className="form-grid">
          <label>Task<input value={title} onChange={e => setTitle(e.target.value)} placeholder="Follow up with..." /></label>
          <label>Due<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label>
          <label>Company<select value={companyId} onChange={e => setCompanyId(e.target.value)}><option value="">— none —</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </form>
        <div className="modal-foot" style={{ borderTop: 'none' }}><button className="primary" onClick={submit}><Plus /> Add task</button></div>
      </section>
      <div className="task-list panel">
        {!open.length && !done.length && <Empty title="No tasks yet" text="Add a follow-up above and it'll show here." />}
        {open.map((t: any) => (
          <div className="task" key={t.id}>
            <button className="check" onClick={() => onToggle(t.id, true)}><span /></button>
            <div><b>{t.title}</b><p>{t.due_at ? fmtDate(t.due_at) : 'No due date'}{t.companies?.name ? ' · ' + t.companies.name : ''}</p></div>
          </div>
        ))}
        {done.map((t: any) => (
          <div className="task" key={t.id} style={{ opacity: 0.5 }}>
            <button className="check" onClick={() => onToggle(t.id, false)}><CheckCircle2 /></button>
            <div><b style={{ textDecoration: 'line-through' }}>{t.title}</b><p>{t.companies?.name || ''}</p></div>
          </div>
        ))}
      </div>
    </>
  )
}

function SettingsView({ googleConn }: { googleConn: any }) {
  return (
    <>
      <div className="page-title"><div><div className="eyebrow">SETTINGS</div><h1>VESPER.</h1><p>Workspace settings and integrations.</p></div></div>
      <div className="settings-grid">
        <div className="panel">
          <h2>Google Calendar</h2>
          <p>Connect each user's Google account. VESPER will create, update and audit linked events.</p>
          {googleConn
            ? <span className="status active">Connected · {googleConn.connected_email || 'Google'}</span>
            : <a className="primary link" href="/api/calendar/auth">Connect Google Calendar</a>}
        </div>
        <div className="panel"><h2>Workspace</h2><p>Two-user outreach workspace. Roles are stored in your VESPER profiles.</p><span className="status active">Active</span></div>
      </div>
    </>
  )
}

function CompanyForm({ initial, onClose, onSave }: { initial?: any; onClose: () => void; onSave: (c: any) => void }) {
  const [f, setF] = useState<any>(initial ? {
    name: initial.name || '', lead_status: initial.lead_status || 'Prospect', lead_score: initial.lead_score ?? 50,
    website: initial.website || '', site_condition: initial.site_condition || 'Outdated', gbp: !!initial.gbp,
    deal_value: initial.deal_value ?? null, deal_value_type: initial.deal_value_type || 'none',
    client_type: initial.client_type || 'not active', company_email: initial.company_email || '',
    company_phone: initial.company_phone || '', instagram: initial.instagram || '', linkedin: initial.linkedin || '',
    address: initial.address || '', remarks: initial.remarks || '',
    contact: { id: initial.contact?.id, name: initial.contact?.name || '', title: initial.contact?.title || 'Founder', email: initial.contact?.email || '', phone: initial.contact?.phone || '', instagram: initial.contact?.instagram || '', linkedin: initial.contact?.linkedin || '' },
  } : {
    name: '', lead_status: 'Prospect', lead_score: 50, site_condition: 'Outdated', gbp: false, deal_value_type: 'none',
    client_type: 'not active', contact: { name: '', title: 'Founder', email: '', phone: '', instagram: '', linkedin: '' },
  })
  const upd = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }))
  return (
    <div className="modal-back">
      <div className="modal">
        <div className="modal-head"><div><div className="eyebrow">{initial ? 'EDIT COMPANY' : 'NEW COMPANY'}</div><h2>{initial ? 'Edit prospect' : 'Add prospect'}</h2></div><button onClick={onClose}><X /></button></div>
        <div className="form-grid">
          <label>Company name<input value={f.name} onChange={e => upd('name', e.target.value)} /></label>
          <label>Lead status<select value={f.lead_status} onChange={e => upd('lead_status', e.target.value)}>{stages.map(x => <option key={x}>{x}</option>)}</select></label>
          <label>Lead score<input type="number" min="0" max="100" value={f.lead_score} onChange={e => upd('lead_score', +e.target.value)} /></label>
          <label>Website<input value={f.website || ''} onChange={e => upd('website', e.target.value)} /></label>
          <label>Site condition<select value={f.site_condition} onChange={e => upd('site_condition', e.target.value)}>{siteOptions.map(x => <option key={x}>{x}</option>)}</select></label>
          <label>GBP<select value={f.gbp ? 'yes' : 'no'} onChange={e => upd('gbp', e.target.value === 'yes')}><option value="no">No</option><option value="yes">Yes</option></select></label>
          <label>Deal value<input placeholder="₹" value={f.deal_value || ''} onChange={e => upd('deal_value', e.target.value ? +e.target.value : null)} /></label>
          <label>Client type<select value={f.client_type} onChange={e => upd('client_type', e.target.value)}>{clientTypes.map(x => <option key={x}>{x}</option>)}</select></label>
          <label>Company email<input value={f.company_email || ''} onChange={e => upd('company_email', e.target.value)} /></label>
          <label>Company phone<input value={f.company_phone || ''} onChange={e => upd('company_phone', e.target.value)} /></label>
          <label>Instagram<input value={f.instagram || ''} onChange={e => upd('instagram', e.target.value)} /></label>
          <label>LinkedIn<input value={f.linkedin || ''} onChange={e => upd('linkedin', e.target.value)} /></label>
          <label>Address<input value={f.address || ''} onChange={e => upd('address', e.target.value)} /></label>
          <label>Founder name<input value={f.contact.name} onChange={e => upd('contact', { ...f.contact, name: e.target.value })} /></label>
          <label>Founder email<input value={f.contact.email} onChange={e => upd('contact', { ...f.contact, email: e.target.value })} /></label>
          <label>Founder phone<input value={f.contact.phone} onChange={e => upd('contact', { ...f.contact, phone: e.target.value })} /></label>
        </div>
        <div className="modal-foot"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={!f.name} onClick={() => onSave(f)}>{initial ? 'Save changes' : 'Create company'}</button></div>
      </div>
    </div>
  )
}

function AddActivity({ company, onClose, onSave }: { company: any; onClose: () => void; onSave: (a: any) => void }) {
  const [type, setType] = useState('call')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  return (
    <div className="modal-back">
      <div className="modal" style={{ width: 'min(500px,96vw)' }}>
        <div className="modal-head"><div><div className="eyebrow">LOG ACTIVITY</div><h2>{company.name}</h2></div><button onClick={onClose}><X /></button></div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <label>Type<select value={type} onChange={e => setType(e.target.value)}>{activityTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
          <label>Title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Called, left voicemail" /></label>
          <label>Details<textarea value={body} onChange={e => setBody(e.target.value)} rows={4} style={{ width: '100%', padding: 10, border: '1px solid var(--line)', background: 'var(--soft)', borderRadius: 9, marginTop: 6, resize: 'vertical', color: 'var(--text)' }} /></label>
        </div>
        <div className="modal-foot"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={!title.trim()} onClick={() => onSave({ type, title: title.trim(), body: body.trim() || undefined })}>Log activity</button></div>
      </div>
    </div>
  )
}

function NewMeetingForm({ company, onClose, onSave }: { company: any; onClose: () => void; onSave: (m: any) => void }) {
  const [title, setTitle] = useState(`Discovery Call — ${company.name}`)
  const [date, setDate] = useState('')
  const [start, setStart] = useState('11:30')
  const [duration, setDuration] = useState(30)
  const [location, setLocation] = useState('Google Meet')
  const [saving, setSaving] = useState(false)
  async function submit() {
    if (!date) { alert('Pick a date'); return }
    const starts_at = new Date(`${date}T${start}:00`)
    const ends_at = new Date(starts_at.getTime() + duration * 60000)
    setSaving(true)
    await onSave({ title, starts_at: starts_at.toISOString(), ends_at: ends_at.toISOString(), location })
    setSaving(false)
  }
  return (
    <div className="modal-back">
      <div className="modal" style={{ width: 'min(500px,96vw)' }}>
        <div className="modal-head"><div><div className="eyebrow">NEW MEETING</div><h2>{company.name}</h2></div><button onClick={onClose} disabled={saving}><X /></button></div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label style={{ gridColumn: '1 / -1' }}>Title<input value={title} onChange={e => setTitle(e.target.value)} disabled={saving} /></label>
          <label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} disabled={saving} /></label>
          <label>Start time<input type="time" value={start} onChange={e => setStart(e.target.value)} disabled={saving} /></label>
          <label>Duration (min)<input type="number" value={duration} onChange={e => setDuration(+e.target.value)} disabled={saving} /></label>
          <label>Location<input value={location} onChange={e => setLocation(e.target.value)} disabled={saving} /></label>
        </div>
        <div className="modal-foot"><button className="ghost" onClick={onClose} disabled={saving}>Cancel</button><button className="primary" onClick={submit} disabled={saving}>{saving ? 'Creating\u2026' : 'Schedule & create Google event'}</button></div>
      </div>
    </div>
  )
}
