'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  Calendar, ChevronRight, Command, Home, Kanban, LayoutGrid, LogOut, Menu, Plus, Search,
  Settings, Users, CheckCircle2, Clock3, Phone, Mail, MessageCircle, Globe, MapPin, Sun, Moon,
  X, ArrowUpRight, Trash2, Pencil, Save, Repeat
} from 'lucide-react'
import { startOfWeek, addDays, addWeeks, format, isSameDay } from 'date-fns'

// Sales stages live in the pipeline_stages table so they can be renamed/added from the Sales
// board. This list seeds that table on first run and is the fallback if it can't be read.
// `kind` marks the terminal columns — 'won' is what triggers the automatic handover into the
// Projects delivery pipeline.
const defaultStageRows: any[] = [
  { name: 'Prospect', kind: 'open' }, { name: 'Qualified Lead', kind: 'open' }, { name: 'Discovery Call', kind: 'open' },
  { name: 'Proposal Agreement Sent', kind: 'open' }, { name: 'Close Call', kind: 'open' }, { name: 'Verbal Approval', kind: 'open' },
  { name: 'Agreement Signed', kind: 'open' }, { name: 'Initial Payment Received', kind: 'open' },
  { name: 'Closed & Onboarding', kind: 'won' }, { name: 'Future Opportunity', kind: 'future' }, { name: 'Lost Opportunity', kind: 'lost' },
].map((s, i) => ({ ...s, position: i + 1 }))
// Outreach touches (DM/call) are a per-company field (see outreachStatuses below), not pipeline
// columns — moved out of the stage list per the Outreach SOP and Atomeo's 2026-09-07 correction.
const outreachStatuses = ['Not Contacted', 'DM Reply', 'DM No Reply', 'Call Successful', 'Call Failed']
const siteOptions = ['No Site','Not Working','Outdated','Not Good','Coming Soon / Under Construction','Decent','Good']
const clientTypes = ['old','not active','active','very active']
// meetings.meeting_type had a DB default of 'Discovery Call' and no UI, so every meeting ever
// created reported itself as a discovery call on the Today view regardless of what it was.
const meetingTypes = ['Discovery Call', 'Close Call', 'Onboarding Call', 'Project Review', 'Retainer Review', 'Check-in', 'Other']

const activityTypes = [
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'instagram', label: 'Instagram DM' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'note', label: 'Note' },
]

// The real Vesper delivery pipeline, as given by Atomeo (2026-09-08). A company enters at
// 'Onboarding' automatically when Sales marks it closed-won, and from then on lives on the
// Projects board instead of the Sales board.
//
// These stages now live in the project_stages table so they can be renamed/added/reordered from
// the Projects board, exactly as the sales stages live in pipeline_stages. This list seeds that
// table on first run and is the fallback if it can't be read.
//
// `kind` marks the semantically special columns, same as it does on the sales side. 'gate' is the
// one that reveals "Convert to Retainer" — read by marker, never by name, so renaming the column
// cannot silently switch conversion off. See supabase/migrate-project-stages.sql section 4.
const defaultProjectStageRows: any[] = [
  { name: 'Onboarding', kind: 'open' },
  { name: 'Sitemap & Wireframe', kind: 'open' },
  { name: 'Structural Anchors', kind: 'open' },
  { name: 'Portfolio + Quiz (Premium only)', kind: 'open' },
  { name: 'Build in Progress', kind: 'open' },
  { name: 'Full Site Review', kind: 'open' },
  { name: 'Live Revision Walkthrough', kind: 'open' },
  { name: 'Final QA', kind: 'open' },
  { name: 'Launch Prep', kind: 'open' },
  { name: 'Live / Handover', kind: 'gate' },
  { name: 'Retainer Active / Project Closed', kind: 'closed' },
].map((s, i) => ({ ...s, position: i + 1 }))
// NOTE: there is deliberately no module-level `projectStages` name list any more. Every consumer
// now receives the LIVE list (projectStageNames) as a prop. A module const would be a second
// source of truth that a component forgetting the prop could silently fall back to, showing the
// original eleven columns on a board that had been edited — the exact drift the milestoneStatuses
// comment below exists to prevent.
// The three project board columns, in board order. Both boards and the card status dropdown
// read this, so a column and its dropdown option can never drift apart.
const milestoneStatuses: { key: string; label: string }[] = [
  { key: 'pending', label: 'Not started' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
]
// 'missed' is a real status the table view can set, but it isn't a column — it buckets into
// "Not started" and shows as a red chip. Keeping the dropdown on the bucket means the control
// always agrees with the column the card is actually sitting in.
const bucketOfMilestone = (m: any) => (m.status === 'in_progress' ? 'in_progress' : m.status === 'done' ? 'done' : 'pending')

const retainerTiers = ['maintenance', 'growth', 'full-service']

// Retainer engagement tiers. Title case, matching the retainers.tier check constraint and the
// SOP's own client-facing wording. NOT the same list as retainerTiers above, which is the legacy
// lowercase companies.retainer_tier column being retired under the drop-unused workstream.
//
// These amounts only PREFILL the form. retainers.monthly_amount stores what was actually agreed
// for that engagement, so repricing a tier later never rewrites an existing retainer.
const retainerTierDefaults: Record<string, number> = {
  'Maintenance': 2500,
  'Growth': 6500,
  'Full-Service': 12500,
}
const retainerTierNames = Object.keys(retainerTierDefaults)
const retainerStatusLabels: Record<string, string> = {
  pending: 'Pending first invoice',
  active: 'Active',
  paused: 'Paused',
  churned: 'Churned',
}
// Conversion is gated on delivery actually being finished. Reaching this stage only REVEALS the
// action — it creates nothing on its own. A retainer row exists once an agreement date is
// captured, and goes Active only once a first invoice date is.
const RETAINER_GATE_STAGE = 'Live / Handover'
// The recurring retainer cycle, in board order. Unlike Sales and Projects this is a LOOP, not a
// funnel: '06' hands back to '02' for the next month rather than terminating. The stored value is
// the whole string including its '01 — ' prefix, so the numbering is part of the data and cannot
// drift from the order of this array.
//
// Feature 1 only READS this, off retainers.cycle_stage. That column does not exist until the
// retainer-pipeline migration adds it, so until then every live retainer reads as stage 01 — see
// cycleStageOf(). The board and the advance-to-next-cycle action arrive with that migration.
const retainerCycleStages = [
  '01 — Retainer Activated',
  '02 — Week 1: GBP / Site Health',
  '03 — Week 2: Website Work',
  '04 — Week 3: SEO / Performance',
  '05 — Week 4: Report / Billing',
  '06 — Month Complete → Next Cycle',
]
// Standard recurring goals per tier, taken directly from the Retainer SOP's tier tables —
// Maintenance has no SOP-mandated recurring deliverable beyond the update allowance itself.
const retainerGoalTemplates: Record<string, { title: string; cadence: string }[]> = {
  maintenance: [],
  growth: [
    { title: 'Monthly report (GA4 + GBP)', cadence: 'monthly' },
    { title: 'GBP weekly post', cadence: 'weekly' },
    { title: 'Keyword tracking (5 keywords)', cadence: 'monthly' },
  ],
  'full-service': [
    { title: 'Monthly report (rank + performance)', cadence: 'monthly' },
    { title: 'GBP weekly post', cadence: 'weekly' },
    { title: 'Keyword tracking (15 keywords) + citation building', cadence: 'monthly' },
    { title: 'Quarterly page refresh', cadence: 'quarterly' },
    { title: 'Monthly blog / case-study post', cadence: 'monthly' },
  ],
}

// retainerGoalTemplates is keyed lowercase ('growth'); retainers.tier is Title Case ('Growth').
// Normalise at the lookup instead of changing either side — the stored enum is client-facing text
// that matches the SOP, and the lowercase keys are the outlier. A direct index would miss
// silently and just render no goals, which is exactly the kind of failure nobody reports.
function goalTemplateFor(tier: string | null | undefined) {
  if (!tier) return []
  const key = Object.keys(retainerGoalTemplates).find(k => k.toLowerCase() === tier.toLowerCase())
  return key ? retainerGoalTemplates[key] : []
}

// Where a retainer currently sits in its monthly cycle. Falls back to stage 01 rather than to
// "nothing", because a live retainer is always somewhere in the cycle by definition — and before
// the cycle_stage column exists the field reads undefined on every row, which would otherwise
// render a stepper with no position at all.
function cycleStageOf(retainer: any) {
  const s = retainer?.cycle_stage
  return retainerCycleStages.includes(s) ? s : retainerCycleStages[0]
}
// The stored cycle value carries its own '01 — ' prefix. The stepper already numbers each step
// from its position, so strip the prefix for display only — the value written back is always the
// full string.
function cycleStageLabel(stage: string) {
  return stage.replace(/^\d+\s*—\s*/, '')
}

// Which of the three pipelines the company detail page should step through.
//
// PRECEDENCE: retainer > project > sales. Not invented here — it is the order RetainerBlock
// already uses (a live retainer short-circuits the project_stage gate entirely) and the order the
// boards already imply (Sales hides anything with a project_stage; Home's openCompanies does the
// same). Reusing it keeps one answer to "what is this company right now" across the whole file.
//
// cameFrom is a tiebreaker, never an override of real state:
//   - 'retainer' with no LIVE retainer means a churned engagement was opened from the Retainer
//     view's Churned tab. There is no cycle left to step through, so it falls through to the
//     company's delivery stage rather than rendering an empty retainer stepper.
//   - 'projects' with no project_stage is reachable from the Tasks/Table modes, which list
//     milestones for every company including ones still in Sales. Showing the delivery stepper
//     unset is the useful answer there — it is how delivery gets started.
function pipelineForCompany(c: any, retainer: any, cameFrom: string) {
  if (retainer) return 'retainer'
  if (c.project_stage || cameFrom === 'projects') return 'project'
  return 'sales'
}

function money(n: number | null) {
  return n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}
function initials(n: string) {
  // Split on runs of whitespace and drop empties — "  Acme" or "Acme  Co" used to produce an
  // undefined x[0] and crash on .toUpperCase().
  return n.trim().split(/\s+/).filter(Boolean).map(x => x[0]).slice(0, 2).join('').toUpperCase() || '?'
}
// Today as a local YYYY-MM-DD calendar date. Deliberately NOT toISOString().slice(0,10), which
// converts to UTC first — before 05:30 IST that hands back yesterday, and churn would be dated a
// day early. Same reason the retainer date fields are passed around as raw strings.
function todayISO() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}
// The "ask VESPER" matcher — plain keyword rules, no external AI service. Pure function so the
// result can be derived fresh whenever companies change (the old version ran once via a stale
// setTimeout closure and answered the PREVIOUS question). Rules narrow cumulatively.
//
// Returns null when nothing matched, which is the point of this rewrite: the old version always
// returned an array, so an unparsed question produced a confident "VESPER found 0" that was
// indistinguishable from a real empty result. Two rules were also actively wrong — the place
// filter took the LAST word of the sentence regardless of where "in" was ("deals in progress"
// searched addresses for "progress"), and the `state` test also fired on the word "status".
function runAIQuery(query: string, companies: any[]): any[] | null {
  const s = query.toLowerCase().trim()
  let r = companies
  let matched = false

  // Words that commonly follow "in" without naming a place — without these, "deals in progress"
  // searches addresses for "progress" and reports a confident zero.
  const notPlaces = new Set(['progress', 'play', 'person', 'total', 'general', 'detail', 'review', 'order', 'touch', 'future', 'the pipeline', 'pipeline'])

  // Take what follows "in", not the end of the sentence.
  const place = s.match(/\bin\s+([a-z][a-z\s]*?)\s*[?.!]*$/)
  if (place) {
    const p = place[1].trim()
    if (p.length > 2 && !notPlaces.has(p)) { r = r.filter(c => (c.address || '').toLowerCase().includes(p)); matched = true }
  }
  if (/\bqualified\b/.test(s)) { r = r.filter(c => c.lead_status === 'Qualified Lead'); matched = true }
  if (/\bno\s+(website|site)\b/.test(s)) { r = r.filter(c => c.site_condition === 'No Site'); matched = true }
  if (/\bmeetings?\b/.test(s)) { r = r.filter(c => c.activities?.some((a: any) => a.type === 'meeting')); matched = true }
  if (/\b(gbp|google business)\b/.test(s)) { r = r.filter(c => c.gbp); matched = true }
  if (/\bstalled?\b/.test(s)) {
    r = r.filter(c => {
      const last = (c.activities || []).reduce((max: string | null, a: any) => (!max || a.occurred_at > max) ? a.occurred_at : max, null) || c.updated_at
      return !last || Date.now() - new Date(last).getTime() >= 14 * 86400000
    })
    matched = true
  }
  return matched ? r : null
}
// A milestone counts as overdue when it isn't done and its target date has passed (or the DB
// says 'missed' — a status the schema always had but the boards used to silently bucket into
// "Not started" with no visual difference).
function isOverdue(m: any) {
  if (m.status === 'done') return false
  if (m.status === 'missed') return true
  return !!m.target_date && new Date(m.target_date).getTime() < Date.now()
}

export default function Page() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [meetings, setMeetings] = useState<any[]>([])
  const [googleConn, setGoogleConn] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [liveRetainers, setLiveRetainers] = useState<any[]>([])
  const [convertTarget, setConvertTarget] = useState<any>(null)
  const [churnedRetainers, setChurnedRetainers] = useState<any[]>([])
  const [view, setView] = useState('home')
  const [selected, setSelected] = useState<any>(null)
  // Where opening this company came from, so the detail page's back button returns there
  // instead of always dumping you on Companies regardless of where you started.
  const [cameFrom, setCameFrom] = useState('companies')
  const [dark, setDark] = useState(false)
  const [q, setQ] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [editCompany, setEditCompany] = useState<any>(null)
  const [showActivity, setShowActivity] = useState<any>(null)
  const [showMeeting, setShowMeeting] = useState<any>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [aiQuery, setAiQuery] = useState<string | null>(null)
  const [stageRows, setStageRows] = useState<any[]>(defaultStageRows)
  const [projectStageRows, setProjectStageRows] = useState<any[]>(defaultProjectStageRows)
  const searchRef = useRef<HTMLInputElement>(null)

  const stageNames = useMemo(() => stageRows.map(s => s.name), [stageRows])
  const wonStageNames = useMemo(() => stageRows.filter(s => s.kind === 'won').map(s => s.name), [stageRows])
  const closedStageNames = useMemo(() => stageRows.filter(s => s.kind !== 'open').map(s => s.name), [stageRows])
  const projectStageNames = useMemo(() => projectStageRows.map(s => s.name), [projectStageRows])
  // The stage that unlocks "Convert to Retainer", resolved by marker rather than by literal so it
  // survives a rename. Falls back to the original constant when the table hasn't been migrated
  // yet, or when someone has deleted the gate column outright.
  const retainerGateStage = useMemo(
    () => projectStageRows.find(s => s.kind === 'gate')?.name || RETAINER_GATE_STAGE,
    [projectStageRows]
  )

  function openCompany(c: any, from: string) {
    setSelected(c); setCameFrom(from); setView('detail')
  }

  async function loadStages() {
    const { data, error } = await supabase.from('pipeline_stages').select('*').order('position')
    // Table missing (migration not run yet) → keep the built-in defaults; editing will say so.
    if (error) { setStageRows(defaultStageRows); return }
    if (!data?.length) {
      // Table exists but is empty — seed it once so every stage row has a real id.
      const { data: seeded } = await supabase.from('pipeline_stages')
        .insert(defaultStageRows.map(s => ({ name: s.name, kind: s.kind, position: s.position }))).select()
      setStageRows(seeded?.length ? [...seeded].sort((a, b) => a.position - b.position) : defaultStageRows)
      return
    }
    setStageRows(data)
  }

  // Exactly loadStages(), against project_stages. Same three cases: table missing → built-in
  // defaults and editing says so; table empty → seed it once so every row has a real id; else
  // use what's there.
  async function loadProjectStages() {
    const { data, error } = await supabase.from('project_stages').select('*').order('position')
    if (error) { setProjectStageRows(defaultProjectStageRows); return }
    if (!data?.length) {
      const { data: seeded } = await supabase.from('project_stages')
        .insert(defaultProjectStageRows.map(s => ({ name: s.name, kind: s.kind, position: s.position }))).select()
      setProjectStageRows(seeded?.length ? [...seeded].sort((a, b) => a.position - b.position) : defaultProjectStageRows)
      return
    }
    setProjectStageRows(data)
  }

  async function loadMeetings() {
    const { data: mt } = await supabase.from('meetings').select('*,companies(name)').order('starts_at', { ascending: true })
    setMeetings(mt || [])
  }

  // Settings used to state flatly that "Roles are stored in your VESPER profiles" while
  // nothing in the app had ever read profiles. Read the real row so the claim is true, and so
  // an account that hasn't been approved yet can be told that instead of seeing empty boards.
  // Always current_retainers, never the retainers table directly. Reading the raw table without
  // a status filter silently sums churned engagements into live revenue — see the view's comment
  // in supabase/migrate-retainers.sql. The view is the only sanctioned read path.
  async function loadRetainers() {
    const { data, error } = await supabase.from('current_retainers').select('*')
    // Table/view missing (migration not applied) → no retainers, and the UI just won't offer it.
    if (error) { setLiveRetainers([]) } else { setLiveRetainers(data || []) }

    // Churned engagements are terminal history and are read SEPARATELY, from the table with an
    // explicit status filter. current_retainers cannot supply them — excluding them is the whole
    // point of the view. Keeping them in their own piece of state is what makes it structurally
    // impossible for a churned row to reach a live count or the MRR total: the summary reads
    // liveRetainers and never sees this array at all.
    const { data: churned, error: cErr } = await supabase
      .from('retainers').select('*').eq('status', 'churned').order('churned_at', { ascending: false })
    if (cErr) { setChurnedRetainers([]); return }
    setChurnedRetainers(churned || [])
  }
  const retainerFor = (companyId: string) => liveRetainers.find(r => r.company_id === companyId) || null

  async function loadProfile() {
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) { setProfile(null); return }
    const { data } = await supabase.from('profiles')
      .select('id,username,display_name,role,approved').eq('id', auth.user.id).maybeSingle()
    setProfile(data || null)
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
      supabase.from('companies').select('*,contacts(*),activities(*),milestones(*)').order('updated_at', { ascending: false }),
      supabase.from('tasks').select('*,companies(name)').order('due_at', { ascending: true, nullsFirst: false }),
    ])
    setCompanies((comp || []).map((x: any) => ({ ...x, contact: x.contacts?.[0] || null })))
    setTasks(tk || [])
    await Promise.all([loadMeetings(), loadGoogleConn(), loadStages(), loadProjectStages(), loadProfile(), loadRetainers()])
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

  // Calendar sync imports Google events with company_id null, and until now there was no way
  // to ever set it — the sync route's own comment said to "link it to a company by hand from
  // the Companies view", but no such control existed anywhere, so every event created in
  // Google rather than in VESPER was stuck rendering as "—".
  async function linkMeetingToCompany(meetingId: string, companyId: string) {
    const { data, error } = await supabase.from('meetings')
      .update({ company_id: companyId || null }).eq('id', meetingId).select('*,companies(name)').single()
    if (error) { alert(error.message); return }
    setMeetings(x => x.map(m => (m.id === meetingId ? data : m)))
  }

  async function deleteMeeting(m: any) {
    if (!confirm(`Delete "${m.title}"? This cannot be undone.`)) return
    // Cancel the Google Calendar event first (same reasoning as deleteCompany: if we only
    // delete the local row, the next calendar sync poll finds the still-live Google event and
    // re-imports it as a new, unlinked meeting — the deletion doesn't stick).
    if (m.google_event_id) {
      try {
        await fetch(`/api/calendar/events?eventId=${encodeURIComponent(m.google_event_id)}`, { method: 'DELETE' })
      } catch {}
    }
    const { error } = await supabase.from('meetings').delete().eq('id', m.id)
    if (error) { alert(error.message); return }
    setMeetings(x => x.filter(mm => mm.id !== m.id))
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setUser(data.session?.user || null)
      if (data.session?.user) await loadAll()
      setLoading(false)
    })
    const { data: l } = supabase.auth.onAuthStateChange(async (event, s) => {
      setUser(s?.user || null)
      // Only refetch when the identity actually changed. This fired on TOKEN_REFRESHED too,
      // so the whole workspace — companies, contacts, activities, milestones, tasks, meetings,
      // stages — was re-downloaded every time Supabase silently rotated the hourly token,
      // wiping any in-progress optimistic state along with it.
      if (s?.user && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) await loadAll()
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

  // Non-null while an "ask VESPER" query is active; recomputed from live data so the filtered
  // list stays correct after edits instead of showing a snapshot. `.matches` is null when no
  // rule understood the question — distinct from a rule matching zero companies.
  const aiResult = useMemo(
    () => (aiQuery == null ? null : { q: aiQuery, matches: runAIQuery(aiQuery, companies) }),
    [aiQuery, companies]
  )

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
    setUser(null); setCompanies([]); setTasks([]); setMeetings([]); setProfile(null); setLiveRetainers([]); setChurnedRetainers([]); setSelected(null); setAiQuery(null); setView('home')
  }

  async function addCompany(c: any) {
    const { data: auth } = await supabase.auth.getUser()
    const { data: row, error } = await supabase.from('companies').insert({
      name: c.name, lead_status: c.lead_status, lead_score: c.lead_score, website: c.website,
      site_condition: c.site_condition, gbp: c.gbp, deal_value: c.deal_value,
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
    setCompanies(x => [{ ...row, contact, activities: [{ title: 'Prospect added', type: 'system', occurred_at: new Date().toISOString() }], milestones: [] }, ...x])
    setShowNew(false); setView('companies')
  }

  async function updateCompany(id: string, patch: any) {
    const { data, error } = await supabase.from('companies').update(patch).eq('id', id).select('*,contacts(*),activities(*),milestones(*)').single()
    if (error) { alert(error.message); return null }
    const updated = { ...data, contact: data.contacts?.[0] || null }
    setCompanies(x => x.map(z => (z.id === id ? updated : z)))
    return updated
  }
  async function handleStageChange(id: string, patch: any) {
    // The Sales → Projects handover: landing on a closed-won stage starts the delivery
    // pipeline at its FIRST column, which also removes the company from the Sales board (the
    // Sales view only shows companies without a project_stage). Never overwrites a delivery
    // stage that's already set.
    //
    // Reads the live stage list, not the hardcoded one: if the first delivery column has been
    // renamed or reordered from the board, handover has to land on whatever is actually first
    // now, or it would drop companies onto a column that no longer exists.
    const company = companies.find(c => c.id === id)
    if (patch.lead_status && wonStageNames.includes(patch.lead_status) && company && !company.project_stage) {
      patch = { ...patch, project_stage: projectStageNames[0] }
    }
    const updated = await updateCompany(id, patch)
    if (updated && selected?.id === id) setSelected(updated)
  }

  async function renameStage(stage: any) {
    const name = prompt('Rename stage', stage.name)?.trim()
    if (!name || name === stage.name) return
    if (stageRows.some(s => s.name === name)) { alert('A stage with that name already exists.'); return }
    if (!stage.id) { alert('Run supabase/migrate-pipeline.sql first — stages are still the built-in defaults.'); return }
    const { error } = await supabase.from('pipeline_stages').update({ name }).eq('id', stage.id)
    if (error) { alert(error.message); return }
    // Companies carry the stage by name, so move them along with the rename.
    const { error: cErr } = await supabase.from('companies').update({ lead_status: name }).eq('lead_status', stage.name)
    if (cErr) { alert(cErr.message); return }
    setStageRows(x => x.map(s => (s.id === stage.id ? { ...s, name } : s)))
    setCompanies(x => x.map(c => (c.lead_status === stage.name ? { ...c, lead_status: name } : c)))
    setSelected((s: any) => (s && s.lead_status === stage.name ? { ...s, lead_status: name } : s))
  }

  async function addStage() {
    const name = prompt('New stage name')?.trim()
    if (!name) return
    if (stageRows.some(s => s.name === name)) { alert('That stage already exists.'); return }
    if (!stageRows.some(s => s.id)) { alert('Run supabase/migrate-pipeline.sql first — stages are still the built-in defaults.'); return }
    // New stages slot in before the terminal columns (won/lost/future stay at the end).
    const firstClosed = [...stageRows].filter(s => s.kind !== 'open').sort((a, b) => a.position - b.position)[0]
    const position = firstClosed ? firstClosed.position : Math.max(0, ...stageRows.map(s => s.position || 0)) + 1
    if (firstClosed) {
      await Promise.all(stageRows.filter(s => s.position >= position && s.id).map(s =>
        supabase.from('pipeline_stages').update({ position: s.position + 1 }).eq('id', s.id)
      ))
    }
    const { error } = await supabase.from('pipeline_stages').insert({ name, kind: 'open', position })
    if (error) { alert(error.message); return }
    await loadStages()
  }
  // Stages could be added and renamed but never removed, so a typo'd or obsolete column was
  // permanent. Refuses while companies still sit on it rather than orphaning them on a
  // lead_status no column renders — companies carry the stage by name, so a silent delete
  // would make those rows vanish from the board entirely.
  async function deleteStage(stage: any) {
    if (!stage.id) { alert('Run supabase/migrate-pipeline.sql first — stages are still the built-in defaults.'); return }
    const occupants = companies.filter(c => c.lead_status === stage.name && !c.project_stage).length
    if (occupants) { alert(`"${stage.name}" still has ${occupants} ${occupants === 1 ? 'company' : 'companies'}. Move them to another stage first.`); return }
    if (stageRows.filter(x => x.kind === 'open').length <= 1 && stage.kind === 'open') { alert('Keep at least one open stage.'); return }
    if (!confirm(`Delete the "${stage.name}" stage? This cannot be undone.`)) return
    const { error } = await supabase.from('pipeline_stages').delete().eq('id', stage.id)
    if (error) { alert(error.message); return }
    await loadStages()
  }

  // Swaps this stage's position with its neighbour in the given direction.
  async function moveStage(stage: any, dir: -1 | 1) {
    if (!stage.id) { alert('Run supabase/migrate-pipeline.sql first — stages are still the built-in defaults.'); return }
    const ordered = [...stageRows].sort((a, b) => a.position - b.position)
    const i = ordered.findIndex(x => x.id === stage.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ordered.length) return
    const other = ordered[j]
    const [a, b] = [stage.position, other.position]
    const [r1, r2] = await Promise.all([
      supabase.from('pipeline_stages').update({ position: b }).eq('id', stage.id),
      supabase.from('pipeline_stages').update({ position: a }).eq('id', other.id),
    ])
    const err = r1.error || r2.error
    if (err) { alert(err.message); await loadStages(); return }
    await loadStages()
  }

  // ---------------------------------------------------------------- project stage CRUD
  // Deliberately line-for-line with the four sales functions above, against project_stages and
  // companies.project_stage. The only substantive differences are noted where they occur.

  async function renameProjectStage(stage: any) {
    const name = prompt('Rename delivery stage', stage.name)?.trim()
    if (!name || name === stage.name) return
    if (projectStageRows.some(s => s.name === name)) { alert('A delivery stage with that name already exists.'); return }
    if (!stage.id) { alert('Run supabase/migrate-project-stages.sql first — delivery stages are still the built-in defaults.'); return }
    const { error } = await supabase.from('project_stages').update({ name }).eq('id', stage.id)
    if (error) { alert(error.message); return }
    // Companies carry the stage by name, so move them along with the rename. This is the write
    // that companies_project_stage_check used to reject outright — see the migration's section 2.
    const { error: cErr } = await supabase.from('companies').update({ project_stage: name }).eq('project_stage', stage.name)
    if (cErr) { alert(cErr.message); return }
    setProjectStageRows(x => x.map(s => (s.id === stage.id ? { ...s, name } : s)))
    setCompanies(x => x.map(c => (c.project_stage === stage.name ? { ...c, project_stage: name } : c)))
    setSelected((s: any) => (s && s.project_stage === stage.name ? { ...s, project_stage: name } : s))
  }

  async function addProjectStage() {
    const name = prompt('New delivery stage name')?.trim()
    if (!name) return
    if (projectStageRows.some(s => s.name === name)) { alert('That delivery stage already exists.'); return }
    if (!projectStageRows.some(s => s.id)) { alert('Run supabase/migrate-project-stages.sql first — delivery stages are still the built-in defaults.'); return }
    // New stages slot in before the terminal columns (the gate and the closed column stay at the end).
    const firstClosed = [...projectStageRows].filter(s => s.kind !== 'open').sort((a, b) => a.position - b.position)[0]
    const position = firstClosed ? firstClosed.position : Math.max(0, ...projectStageRows.map(s => s.position || 0)) + 1
    if (firstClosed) {
      await Promise.all(projectStageRows.filter(s => s.position >= position && s.id).map(s =>
        supabase.from('project_stages').update({ position: s.position + 1 }).eq('id', s.id)
      ))
    }
    const { error } = await supabase.from('project_stages').insert({ name, kind: 'open', position })
    if (error) { alert(error.message); return }
    await loadProjectStages()
  }

  // Same protection as deleteStage: refuses while companies still sit on the column rather than
  // orphaning them on a project_stage no column renders, which would make those rows vanish from
  // the Projects board entirely.
  async function deleteProjectStage(stage: any) {
    if (!stage.id) { alert('Run supabase/migrate-project-stages.sql first — delivery stages are still the built-in defaults.'); return }
    const occupants = companies.filter(c => c.project_stage === stage.name).length
    if (occupants) { alert(`"${stage.name}" still has ${occupants} ${occupants === 1 ? 'client' : 'clients'}. Move them to another stage first.`); return }
    // Not in the sales original, and needed here: deleting the gate would leave nothing marked
    // 'gate', so retainerGateStage would fall back to a stage name that no longer exists and
    // "Convert to Retainer" would never appear again — with no error to explain why. Rename it
    // instead; the marker travels with the row.
    if (stage.kind === 'gate') { alert(`"${stage.name}" is the stage that unlocks Convert to Retainer. Rename it if you need different wording, but it cannot be deleted.`); return }
    if (projectStageRows.filter(x => x.kind === 'open').length <= 1 && stage.kind === 'open') { alert('Keep at least one open delivery stage.'); return }
    if (!confirm(`Delete the "${stage.name}" delivery stage? This cannot be undone.`)) return
    const { error } = await supabase.from('project_stages').delete().eq('id', stage.id)
    if (error) { alert(error.message); return }
    await loadProjectStages()
  }

  // Swaps this stage's position with its neighbour in the given direction.
  async function moveProjectStage(stage: any, dir: -1 | 1) {
    if (!stage.id) { alert('Run supabase/migrate-project-stages.sql first — delivery stages are still the built-in defaults.'); return }
    const ordered = [...projectStageRows].sort((a, b) => a.position - b.position)
    const i = ordered.findIndex(x => x.id === stage.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ordered.length) return
    const other = ordered[j]
    const [a, b] = [stage.position, other.position]
    const [r1, r2] = await Promise.all([
      supabase.from('project_stages').update({ position: b }).eq('id', stage.id),
      supabase.from('project_stages').update({ position: a }).eq('id', other.id),
    ])
    const err = r1.error || r2.error
    if (err) { alert(err.message); await loadProjectStages(); return }
    await loadProjectStages()
  }

  async function handleSaveNotes(id: string, remarks: string) {
    const updated = await updateCompany(id, { remarks })
    if (updated && selected?.id === id) setSelected(updated)
  }

  async function updateOutreachStatus(id: string, outreach_status: string) {
    const current = companies.find(c => c.id === id)
    const patch: any = { outreach_status }
    // A successful cold call is what the Outreach SOP treats as the prospect becoming a real
    // Qualified Lead, ready for the Sales SOP's Call 1 (Discovery) — NOT "Onboarding", which
    // only happens 7 stages later, after the proposal is signed and paid. Only auto-advances
    // out of Prospect, so it never overrides a stage someone already moved forward manually.
    if (outreach_status === 'Call Successful' && current?.lead_status === 'Prospect') {
      patch.lead_status = 'Qualified Lead'
    }
    const updated = await updateCompany(id, patch)
    if (updated && selected?.id === id) setSelected(updated)
  }

  async function updateProjectStage(id: string, project_stage: string) {
    const updated = await updateCompany(id, { project_stage: project_stage || null })
    if (updated && selected?.id === id) setSelected(updated)
  }
  async function updateRetainerTier(id: string, retainer_tier: string) {
    const updated = await updateCompany(id, { retainer_tier: retainer_tier || null })
    if (updated && selected?.id === id) setSelected(updated)
  }
  // Creates the engagement. Status is NOT passed — the database decides it: the row defaults to
  // 'pending', and the activation trigger flips it to 'active' and stamps started_at,
  // billing_anchor and next_invoice_due only if a first-invoice date came with it. Sending a
  // status from here would be the client asserting a billing state it cannot actually know.
  //
  // Dates go through as the raw 'YYYY-MM-DD' strings the date inputs produce. Deliberately no
  // Date parsing or toISOString() — these are calendar dates, and round-tripping them through a
  // timestamp is how an agreement signed on the 1st becomes the 30th of the previous month.
  async function convertToRetainer(company: any, f: { tier: string; monthly_amount: number; agreement_signed_on: string; first_invoice_issued_on?: string | null }) {
    const { data, error } = await supabase.from('retainers').insert({
      company_id: company.id,
      tier: f.tier,
      monthly_amount: f.monthly_amount,
      agreement_signed_on: f.agreement_signed_on,
      first_invoice_issued_on: f.first_invoice_issued_on || null,
    }).select().single()
    if (error) { alert(error.message); return }
    await loadRetainers()
    setConvertTarget(null)
    const { data: auth } = await supabase.auth.getUser()
    await supabase.from('activities').insert({
      company_id: company.id, user_id: auth.user?.id, type: 'system',
      title: data.status === 'active'
        ? `Retainer started — ${f.tier} at ${money(f.monthly_amount)}/mo`
        : `Retainer agreement signed — ${f.tier} at ${money(f.monthly_amount)}/mo (awaiting first invoice)`,
    })
    await refetchCompany(company.id, selected?.id === company.id)
  }

  // The deferred half of conversion. Filling in the first invoice date is what the trigger reacts
  // to, so this sends only that one field and reads the resulting dates back rather than
  // computing them client-side.
  async function recordFirstInvoice(retainer: any, issuedOn: string) {
    const { data, error } = await supabase.from('retainers')
      .update({ first_invoice_issued_on: issuedOn }).eq('id', retainer.id).select().single()
    if (error) { alert(error.message); return }
    await loadRetainers()
    const { data: auth } = await supabase.auth.getUser()
    await supabase.from('activities').insert({
      company_id: retainer.company_id, user_id: auth.user?.id, type: 'system',
      title: `First retainer invoice issued — billing anchored to ${fmtDate(data.billing_anchor)}, next due ${fmtDate(data.next_invoice_due)}`,
    })
    await refetchCompany(retainer.company_id, selected?.id === retainer.company_id)
  }

  // One write path for every retainer status/tier change, so each of them reloads the view and
  // leaves a timeline entry on the company rather than mutating quietly.
  async function updateRetainer(retainer: any, patch: any, activityTitle: string) {
    const { data, error } = await supabase.from('retainers').update(patch).eq('id', retainer.id).select().single()
    if (error) { alert(error.message); return null }
    await loadRetainers()
    const { data: auth } = await supabase.auth.getUser()
    await supabase.from('activities').insert({
      company_id: retainer.company_id, user_id: auth.user?.id, type: 'system', title: activityTitle,
    })
    await refetchCompany(retainer.company_id, selected?.id === retainer.company_id)
    return data
  }

  async function changeRetainerTier(retainer: any, tier: string) {
    if (!tier || tier === retainer.tier) return
    const patch: any = { tier }
    // monthly_amount is the number actually agreed for this engagement, never derived from tier,
    // so moving tier does not silently reprice it. Offer the new default, don't assume it.
    const def = retainerTierDefaults[tier]
    if (def != null && Number(retainer.monthly_amount) !== def &&
        confirm(`Change tier to ${tier}.\n\nAlso set the monthly amount to the ${tier} default of ${money(def)}?\nCancel keeps the agreed ${money(retainer.monthly_amount)}.`)) {
      patch.monthly_amount = def
    }
    await updateRetainer(retainer, patch, `Retainer tier changed to ${tier}`)
  }

  async function pauseRetainer(r: any) {
    if (!confirm(`Pause the ${r.tier} retainer?\n\nIt stops counting toward live totals and can be resumed at any time.`)) return
    await updateRetainer(r, { status: 'paused' }, 'Retainer paused')
  }

  async function resumeRetainer(r: any) {
    // Back to whichever state it genuinely was in. A retainer paused before its first invoice
    // returns to pending, not active — 'active' requires the billing dates the DB constraint
    // enforces, and it has none yet.
    const next = r.first_invoice_issued_on ? 'active' : 'pending'
    await updateRetainer(r, { status: next },
      next === 'active' ? 'Retainer resumed' : 'Retainer resumed — still awaiting first invoice')
  }

  async function churnRetainer(r: any) {
    if (!confirm(`Churn the ${r.tier} retainer?\n\nThe record is kept, never deleted — it moves to Churned and drops out of live totals. If they re-sign later that starts a new retainer, leaving this one intact as history.`)) return
    await updateRetainer(r, { status: 'churned', churned_at: todayISO() }, 'Retainer churned')
  }

  function patchMilestonesLocally(companyId: string, fn: (ms: any[]) => any[]) {
    setCompanies(x => x.map(c => (c.id === companyId ? { ...c, milestones: fn(c.milestones || []) } : c)))
    setSelected((s: any) => (s && s.id === companyId ? { ...s, milestones: fn(s.milestones || []) } : s))
  }
  async function addMilestone(company: any, m: { title: string; cadence?: string; priority?: string; target_date?: string; category?: string }) {
    const { data, error } = await supabase.from('milestones').insert({
      company_id: company.id, title: m.title, cadence: m.cadence || 'once', category: m.category || 'goal',
      priority: m.priority || 'Medium', target_date: m.target_date || null,
    }).select().single()
    if (error) { alert(error.message); return }
    patchMilestonesLocally(company.id, ms => [...ms, data])
  }
  // Optimistic single-field (or multi-field) milestone edit — the table view edits everything
  // (title, status, priority, dates, cadence, category) through this one path.
  // Rolls back on failure: this used to paint the new value, alert, and then leave the value
  // that never saved sitting on screen until a reload, so a rejected edit looked like it worked.
  async function updateMilestoneFields(companyId: string, milestoneId: string, patch: any) {
    const before = (companies.find(c => c.id === companyId)?.milestones || []).find((m: any) => m.id === milestoneId)
    patchMilestonesLocally(companyId, ms => ms.map(m => (m.id === milestoneId ? { ...m, ...patch } : m)))
    const { error } = await supabase.from('milestones').update(patch).eq('id', milestoneId)
    if (error) {
      // Restore only the fields this call touched, so a concurrent edit to another field survives.
      if (before) {
        const revert = Object.fromEntries(Object.keys(patch).map(k => [k, before[k]]))
        patchMilestonesLocally(companyId, ms => ms.map(m => (m.id === milestoneId ? { ...m, ...revert } : m)))
      }
      alert(error.message)
    }
  }
  async function updateMilestoneProgress(companyId: string, milestoneId: string, progress: number) {
    await updateMilestoneFields(companyId, milestoneId, { progress })
  }
  async function deleteMilestone(companyId: string, milestoneId: string) {
    const { error } = await supabase.from('milestones').delete().eq('id', milestoneId)
    if (error) { alert(error.message); return }
    patchMilestonesLocally(companyId, ms => ms.filter(m => m.id !== milestoneId))
  }
  // Drag-and-drop between board columns. Goes through updateMilestoneFields so the card moves
  // immediately and rolls back if the write fails — it used to await the round trip before
  // moving, so a dragged card visibly hung in its old column until the network answered, while
  // every other milestone edit on the same board was already optimistic.
  async function toggleMilestone(companyId: string, milestoneId: string, status: string) {
    await updateMilestoneFields(companyId, milestoneId, { status })
  }
  // Skips goals this company already has. The button is permanently visible on the Project tab
  // and inserted blindly before, so a second click silently produced a duplicate of every
  // standard goal — and nothing in the UI hinted that it already ran once.
  async function applyRetainerTemplate(company: any, tier: string) {
    const template = goalTemplateFor(tier)
    if (!template.length) return
    const existing = new Set((company.milestones || []).map((m: any) => m.title))
    const missing = template.filter(t => !existing.has(t.title))
    if (!missing.length) { alert(`Every standard ${tier} goal is already on this company.`); return }
    const { data, error } = await supabase.from('milestones').insert(
      missing.map(t => ({ company_id: company.id, title: t.title, cadence: t.cadence, category: 'goal' }))
    ).select()
    if (error) { alert(error.message); return }
    patchMilestonesLocally(company.id, ms => [...ms, ...(data || [])])
  }

  async function refetchCompany(id: string, alsoSelect = false) {
    const { data, error } = await supabase.from('companies').select('*,contacts(*),activities(*),milestones(*)').eq('id', id).single()
    if (error) { alert(error.message); return null }
    const updated = { ...data, contact: data.contacts?.[0] || null }
    setCompanies(x => x.map(z => (z.id === id ? updated : z)))
    if (alsoSelect) setSelected(updated)
    return updated
  }

  async function saveEditedCompany(id: string, c: any) {
    // Same handover rule as handleStageChange, for closes made through the edit form.
    const existing = companies.find(z => z.id === id)
    const handover = wonStageNames.includes(c.lead_status) && existing && !existing.project_stage
      ? { project_stage: projectStageNames[0] } : {}
    const { error } = await supabase.from('companies').update({
      ...handover,
      name: c.name, lead_status: c.lead_status, lead_score: c.lead_score, website: c.website,
      site_condition: c.site_condition, gbp: c.gbp, deal_value: c.deal_value,
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
      setSelected(null); setView(cameFrom)
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
  async function deleteTask(id: string) {
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setTasks(x => x.filter(t => t.id !== id))
  }

  async function scheduleMeeting(company: any, m: { title: string; meeting_type: string; starts_at: string; ends_at: string; location?: string }) {
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
      company_id: company.id, created_by: auth.user?.id, title: m.title, meeting_type: m.meeting_type, starts_at: m.starts_at, ends_at: m.ends_at,
      location: m.location || null, google_event_id: ev?.id || null, google_calendar_id: json.calendarId || 'primary',
      google_meet_url: ev?.hangoutLink || null, status: 'scheduled',
    }).select('*,companies(name)').single()
    if (error) { alert(error.message); return }
    setMeetings(x => [...x, row].sort((a, b) => a.starts_at.localeCompare(b.starts_at)))
    setShowMeeting(null)
    supabase.from('activities').insert({ company_id: company.id, user_id: auth.user?.id, type: 'meeting', title: m.title, occurred_at: m.starts_at })
      .then(() => refetchCompany(company.id, selected?.id === company.id))
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
        <div className="side-brand" onClick={() => setView('home')} style={{ cursor: 'pointer' }}><div className="mini-logo">V</div><b>VESPER</b></div>
        <nav>
          <Nav active={view === 'home'} icon={<Home />} label="Today" onClick={() => setView('home')} />
          <Nav active={view === 'pipeline'} icon={<Kanban />} label="Sales" onClick={() => setView('pipeline')} />
          <Nav active={view === 'companies'} icon={<Users />} label="Companies" onClick={() => setView('companies')} />
          <Nav active={view === 'projects'} icon={<LayoutGrid />} label="Projects" onClick={() => setView('projects')} />
          <Nav active={view === 'retainer'} icon={<Repeat />} label="Retainer" onClick={() => setView('retainer')} />
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
          <div className="mobile-brand" onClick={() => setView('home')} style={{ cursor: 'pointer' }}>VESPER</div>
          <div className="search" style={view === 'home' ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}><Search /><input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search companies, people, notes..." disabled={view === 'home'} /><kbd>⌘ K</kbd></div>
          <div className="header-actions">
            <button onClick={() => setDark(!dark)} className="icon-btn">{dark ? <Sun /> : <Moon />}</button>
            <button className="primary" onClick={() => setShowNew(true)}><Plus /> New company</button>
            <button className="icon-btn mobile-logout" onClick={logout} title="Sign out"><LogOut /></button>
            <div className="avatar" onClick={() => setView('settings')} style={{ cursor: 'pointer' }} title="Settings">{initials(user.user_metadata?.display_name || user.email || 'V')}</div>
          </div>
        </header>
        <div className="content">
          {view === 'home' && <HomeView companies={companies} meetings={meetings} closedStages={closedStageNames} onOpen={(c: any) => { openCompany(c, 'home') }} onNew={() => setShowNew(true)} onGoCalendar={() => setView('calendar')} onDeleteMeeting={deleteMeeting} onLinkMeeting={linkMeetingToCompany} />}
          {view === 'pipeline' && <Pipeline companies={filtered.filter((c: any) => !c.project_stage)} stages={stageRows} onOpen={(c: any) => { openCompany(c, 'pipeline') }} onUpdate={handleStageChange} onOutreachChange={updateOutreachStatus} onRenameStage={renameStage} onAddStage={addStage} onDeleteStage={deleteStage} onMoveStage={moveStage} />}
          {view === 'companies' && <Companies companies={aiResult?.matches ?? filtered} onOpen={(c: any) => { openCompany(c, 'companies') }} onNew={() => setShowNew(true)} onOutreachChange={updateOutreachStatus} />}
          {view === 'projects' && <ProjectsView companies={filtered} stages={projectStageRows} onToggleMilestone={toggleMilestone} onUpdateProgress={updateMilestoneProgress} onUpdateFields={updateMilestoneFields} onDeleteMilestone={deleteMilestone} onProjectStageChange={updateProjectStage} onOpenCompany={(c: any) => { openCompany(c, 'projects') }} onRenameStage={renameProjectStage} onAddStage={addProjectStage} onDeleteStage={deleteProjectStage} onMoveStage={moveProjectStage} />}
          {view === 'retainer' && (
            <RetainerView
              live={liveRetainers}
              churned={churnedRetainers}
              companies={filtered}
              allCompanies={companies}
              onChangeTier={changeRetainerTier}
              onPause={pauseRetainer}
              onResume={resumeRetainer}
              onChurn={churnRetainer}
              onRecordFirstInvoice={recordFirstInvoice}
              onOpenCompany={(id: string) => { const c = companies.find(z => z.id === id); if (c) openCompany(c, 'retainer') }}
            />
          )}
          {view === 'calendar' && <CalendarView meetings={meetings} companies={companies} googleConn={googleConn} onSync={syncGoogleCalendar} onDeleteMeeting={deleteMeeting} onLinkMeeting={linkMeetingToCompany} />}
          {view === 'tasks' && <Tasks tasks={tasks} companies={companies} onToggle={toggleTask} onAdd={addTask} onDelete={deleteTask} />}
          {view === 'settings' && <SettingsView googleConn={googleConn} profile={profile} user={user} />}
          {view === 'detail' && selected && (
            <Detail
              c={selected}
              stages={stageNames}
              projectStages={projectStageNames}
              gateStage={retainerGateStage}
              cameFrom={cameFrom}
              onBack={() => setView(cameFrom)}
              backLabel={cameFrom === 'home' ? 'Today' : cameFrom === 'pipeline' ? 'Sales' : cameFrom === 'projects' ? 'Projects' : cameFrom === 'retainer' ? 'Retainer' : 'Companies'}
              onUpdate={handleStageChange}
              onEdit={(c: any) => setEditCompany(c)}
              onDelete={deleteCompany}
              onAddActivity={(c: any) => setShowActivity(c)}
              onScheduleMeeting={(c: any) => setShowMeeting(c)}
              onSaveNotes={handleSaveNotes}
              deleting={deletingId === selected.id}
              onOutreachChange={updateOutreachStatus}
              onProjectStageChange={updateProjectStage}
              onRetainerTierChange={updateRetainerTier}
              retainer={retainerFor(selected.id)}
              onConvertRetainer={(c: any) => setConvertTarget(c)}
              onRecordFirstInvoice={recordFirstInvoice}
              onAddMilestone={addMilestone}
              onToggleMilestone={toggleMilestone}
              onApplyTemplate={applyRetainerTemplate}
              onUpdateMilestoneProgress={updateMilestoneProgress}
              onDeleteMilestone={deleteMilestone}
            />
          )}
        </div>
      </main>
      <nav className="bottom-nav">
        <Nav active={view === 'home'} icon={<Home />} label="Today" onClick={() => setView('home')} />
        <Nav active={view === 'pipeline'} icon={<Kanban />} label="Sales" onClick={() => setView('pipeline')} />
        <Nav active={view === 'companies'} icon={<Users />} label="Companies" onClick={() => setView('companies')} />
        <Nav active={view === 'projects'} icon={<LayoutGrid />} label="Projects" onClick={() => setView('projects')} />
        <Nav active={view === 'retainer'} icon={<Repeat />} label="Retainer" onClick={() => setView('retainer')} />
        <Nav active={view === 'calendar'} icon={<Calendar />} label="Calendar" onClick={() => setView('calendar')} />
        <Nav active={view === 'tasks'} icon={<CheckCircle2 />} label="Tasks" onClick={() => setView('tasks')} />
      </nav>
      <button className="ai-fab" onClick={() => { const v = prompt('Filter companies — try "qualified leads in mumbai", "companies with no website", "stalled", "has GBP"'); if (v) { setAiQuery(v); setView('companies') } }}><Command /></button>
      {showNew && <CompanyForm stages={stageNames} onClose={() => setShowNew(false)} onSave={addCompany} />}
      {editCompany && <CompanyForm stages={stageNames} initial={editCompany} onClose={() => setEditCompany(null)} onSave={(f: any) => saveEditedCompany(editCompany.id, f)} />}
      {showActivity && <AddActivity company={showActivity} onClose={() => setShowActivity(null)} onSave={(a: any) => addActivity(showActivity, a)} />}
      {showMeeting && <NewMeetingForm company={showMeeting} onClose={() => setShowMeeting(null)} onSave={(m: any) => scheduleMeeting(showMeeting, m)} />}
      {convertTarget && <ConvertToRetainerForm company={convertTarget} onClose={() => setConvertTarget(null)} onSave={(f: any) => convertToRetainer(convertTarget, f)} />}
      {aiResult && (
        <div className="toast">
          {aiResult.matches
            ? <b>VESPER found {aiResult.matches.length}</b>
            : <b>Couldn’t read “{aiResult.q}” — showing everything</b>}
          <button onClick={() => setAiQuery(null)}><X /></button>
        </div>
      )}
    </div>
  )
}

function Nav({ active, icon, label, onClick }: { active: boolean; icon: any; label: string; onClick: () => void }) {
  return <button className={active ? 'nav active' : 'nav'} onClick={onClick}>{icon}<span>{label}</span></button>
}

function HomeView({ companies, meetings, closedStages, onOpen, onNew, onGoCalendar, onDeleteMeeting, onLinkMeeting }: { companies: any[]; meetings: any[]; closedStages: string[]; onOpen: any; onNew: any; onGoCalendar: any; onDeleteMeeting: any; onLinkMeeting: any }) {
  const upcoming = meetings.filter(m => new Date(m.starts_at) >= new Date(Date.now() - 3600000)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const qualified = companies.filter(c => c.lead_status === 'Qualified Lead').length
  // Both top-line numbers used to run over `companies` unfiltered, so a lost deal and a client
  // already delivered still counted as a prospect and still inflated pipeline value forever.
  // "Open" = not on a terminal sales stage and not handed over to delivery — the same test the
  // stalled-leads panel below already uses.
  const openCompanies = companies.filter(c => !closedStages.includes(c.lead_status) && !c.project_stage)
  const openValue = openCompanies.reduce((sum, c) => sum + (c.deal_value || 0), 0)

  // Real stalled-opportunity detection, replacing the placeholder card that used to claim this
  // existed. "Stalled" = an open (not closed/lost/future, not handed to delivery) company with
  // no logged activity, and no update to the record itself, in the last 14 days.
  const stalled = openCompanies
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
        <Metric label="Open prospects" value={openCompanies.length} />
        <Metric label="Qualified leads" value={qualified} />
        <Metric label="Meetings" value={upcoming.length} />
        <Metric label="Open pipeline value" value={money(openValue)} />
      </div>
      <div className="grid2">
        <section className="panel">
          <div className="panel-head"><h2>Up next</h2><button onClick={onGoCalendar} className="text-btn">View calendar <ArrowUpRight /></button></div>
          {upcoming.length ? upcoming.slice(0, 4).map((m: any) => (
            <div className="meeting" key={m.id}>
              <div className="time"><b>{new Date(m.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b><span>{new Date(m.starts_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></div>
              <div>
                <b>{m.companies?.name || m.title}</b>
                <p>{m.meeting_type || 'Meeting'}{m.google_meet_url ? ' · Google Meet' : ''}</p>
                {!m.company_id && <MeetingCompanyPicker meeting={m} companies={companies} onLink={onLinkMeeting} />}
              </div>
              <button className="icon-btn" onClick={() => onDeleteMeeting(m)} title="Delete meeting"><Trash2 /></button>
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
// Shown on any meeting that isn't attached to a company yet — i.e. everything Google sync
// pulled in. Stops click-through so using it inside a clickable card doesn't navigate away.
// Commits on blur or Enter rather than on every keystroke. As a number input, holding an arrow
// key or typing "100" fired one DB write per character — the task title input in the table view
// was already built this way for exactly this reason; this brings the percentage field in line.
function ProgressInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  // Re-sync when the value changes underneath us (another edit, or a failed write rolling back).
  useEffect(() => { setDraft(String(value)) }, [value])
  function commit() {
    const n = Math.max(0, Math.min(100, Math.round(+draft || 0)))
    setDraft(String(n))
    if (n !== value) onCommit(n)
  }
  return (
    <input
      type="number" min={0} max={100} value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}

// Direct-edit status on a project card, mirroring the outreach_status select on Pipeline cards.
// Additive: dragging the card between columns still works and goes through the same handler, so
// both paths share the optimistic update and the rollback-on-failure.
function MilestoneStatusSelect({ milestone, onChange }: { milestone: any; onChange: (status: string) => void }) {
  return (
    <select
      className="outreach-select"
      value={bucketOfMilestone(milestone)}
      draggable={false}
      onClick={e => e.stopPropagation()}
      // Stops a click-and-drag on the select from picking up the card instead.
      onDragStart={e => { e.preventDefault(); e.stopPropagation() }}
      onChange={e => onChange(e.target.value)}
    >
      {milestoneStatuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
    </select>
  )
}

function MeetingCompanyPicker({ meeting, companies, onLink, compact }: { meeting: any; companies: any[]; onLink: any; compact?: boolean }) {
  return (
    <select
      className="outreach-select"
      style={compact ? { margin: '6px 0 0', fontSize: 9 } : { margin: '6px 0 0', width: 'auto' }}
      value={meeting.company_id || ''}
      onClick={e => e.stopPropagation()}
      onChange={e => { e.stopPropagation(); onLink(meeting.id, e.target.value) }}
    >
      <option value="">— link to company —</option>
      {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  )
}

function Metric({ label, value }: { label: string; value: any }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
function Attention({ icon, title, text, onClick }: { icon: any; title: string; text: string; onClick?: () => void }) {
  return <div className="attention" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>{icon}<div><b>{title}</b><p>{text}</p></div></div>
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><b>{title}</b><p>{text}</p></div> }
function Status({ s }: { s: string }) { return <span className={'status ' + s.toLowerCase().replaceAll(' ', '-')}>{s}</span> }

function Pipeline({ companies, stages, onOpen, onUpdate, onOutreachChange, onRenameStage, onAddStage, onDeleteStage, onMoveStage }: { companies: any[]; stages: any[]; onOpen: any; onUpdate: any; onOutreachChange: any; onRenameStage: any; onAddStage: any; onDeleteStage: any; onMoveStage: any }) {
  const [dragId, setDragId] = useState<string | null>(null)
  return (
    <>
      <div className="page-title"><div><div className="eyebrow">SALES</div><h1>Opportunity flow.</h1><p>Close a deal and the company hands over to Projects automatically.</p></div></div>
      <div className="kanban">
        {stages.map((s: any) => { const stage = s.name; return (
          <div className="column" key={stage} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragId) onUpdate(dragId, { lead_status: stage }); setDragId(null) }}>
            <div className="col-head">
              <b>{stage}</b>
              <span className="col-tools">
                <button className="col-edit" title="Move left" onClick={() => onMoveStage(s, -1)}>‹</button>
                <button className="col-edit" title="Move right" onClick={() => onMoveStage(s, 1)}>›</button>
                <button className="col-edit" title="Rename stage" onClick={() => onRenameStage(s)}><Pencil /></button>
                <button className="col-edit" title="Delete stage" onClick={() => onDeleteStage(s)}><Trash2 /></button>
                {companies.filter(c => c.lead_status === stage).length}
              </span>
            </div>
            {companies.filter(c => c.lead_status === stage).map(c => (
              <div className="deal-card" key={c.id} draggable onDragStart={() => setDragId(c.id)} onDragEnd={() => setDragId(null)} onClick={() => onOpen(c)}>
                <div className="card-top"><b>{c.name}</b><span>{c.lead_score}</span></div>
                <p>{c.contact?.name || 'Decision maker'}</p>
                <select
                  className="outreach-select"
                  value={c.outreach_status || 'Not Contacted'}
                  onClick={e => e.stopPropagation()}
                  onChange={e => onOutreachChange(c.id, e.target.value)}
                >
                  {outreachStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div className="card-bottom"><span>{money(c.deal_value)}</span><span>{c.site_condition}</span></div>
              </div>
            ))}
          </div>
        )})}
        <div className="column">
          <button className="ghost add-stage" onClick={onAddStage}><Plus /> Add stage</button>
        </div>
      </div>
    </>
  )
}

function Companies({ companies, onOpen, onNew, onOutreachChange }: { companies: any[]; onOpen: any; onNew: any; onOutreachChange: any }) {
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
              <select
                className="outreach-select"
                style={{ marginTop: 8, width: 'auto' }}
                value={c.outreach_status || 'Not Contacted'}
                onClick={e => e.stopPropagation()}
                onChange={e => onOutreachChange(c.id, e.target.value)}
              >
                {outreachStatuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="cc-value"><span>Deal value</span><b>{money(c.deal_value)}</b></div>
            <ChevronRight />
          </div>
        )) : <Empty title="No companies yet" text="Add your first prospect to get started." />}
      </div>
    </>
  )
}

// The stage stepper at the top of a company page. Markup and class names are lifted verbatim from
// what Detail rendered inline, so all three pipelines look identical — the only thing that varies
// is which list of stages is passed in and what a click writes back.
//
// `current` may be null (a company with no delivery stage yet): nothing is marked active or done,
// and every step stays clickable, which is how delivery gets started. Omitting `onSelect` renders
// the stepper read-only.
function StageStepper({ stages, current, onSelect, label }: { stages: string[]; current: string | null | undefined; onSelect?: (stage: string) => void; label?: (stage: string) => string }) {
  const idx = current ? stages.indexOf(current) : -1
  return (
    <div className="detail-stage">
      <div className="stage-line">
        {stages.map((s, i) => (
          <div
            className={current === s ? 'stage active' : idx >= 0 && i < idx ? 'stage done' : 'stage'}
            key={s}
            onClick={onSelect ? () => onSelect(s) : undefined}
            style={onSelect ? { cursor: 'pointer' } : undefined}
          >
            <span>{i + 1}</span><small>{label ? label(s) : s}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

function Detail({ c, stages, projectStages, gateStage, cameFrom, onBack, backLabel, onUpdate, onEdit, onDelete, onAddActivity, onScheduleMeeting, onSaveNotes, deleting, onOutreachChange, onProjectStageChange, onRetainerTierChange, retainer, onConvertRetainer, onRecordFirstInvoice, onAddMilestone, onToggleMilestone, onApplyTemplate, onUpdateMilestoneProgress, onDeleteMilestone }: { c: any; stages: string[]; projectStages: string[]; gateStage: string; cameFrom: string; onBack: any; backLabel: string; onUpdate: any; onEdit: any; onDelete: any; onAddActivity: any; onScheduleMeeting: any; onSaveNotes: any; deleting?: boolean; onOutreachChange: any; onProjectStageChange: any; onRetainerTierChange: any; retainer: any; onConvertRetainer: any; onRecordFirstInvoice: any; onAddMilestone: any; onToggleMilestone: any; onApplyTemplate: any; onUpdateMilestoneProgress: any; onDeleteMilestone: any }) {
  const [tab, setTab] = useState('overview')
  const [notes, setNotes] = useState(c.remarks || '')
  useEffect(() => { setNotes(c.remarks || '') }, [c.id])
  // Which pipeline this company is actually on. The stepper used to be hardcoded to the sales
  // stages and c.lead_status no matter where you opened from, so a delivery client or a retainer
  // client still showed the Sales flow at the top of its own page.
  const pipeline = pipelineForCompany(c, retainer, cameFrom)
  return (
    <>
      <button className="back" onClick={onBack}>← {backLabel}</button>
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
      {pipeline === 'retainer' ? (
        // Read-only until the retainer-pipeline migration adds cycle_stage and the board that
        // writes it. Clicking a step here would be asserting a cycle position against a column
        // that may not exist yet, which is the one thing worse than not offering the control.
        <StageStepper stages={retainerCycleStages} current={cycleStageOf(retainer)} label={cycleStageLabel} />
      ) : pipeline === 'project' ? (
        <StageStepper stages={projectStages} current={c.project_stage} onSelect={s => onProjectStageChange(c.id, s)} />
      ) : (
        <StageStepper stages={stages} current={c.lead_status} onSelect={s => onUpdate(c.id, { lead_status: s })} />
      )}
      <div className="tabs">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
        <button className={tab === 'project' ? 'active' : ''} onClick={() => setTab('project')}>Project</button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>Notes</button>
      </div>
      {tab === 'overview' ? (
        <div className="detail-grid">
          <section className="panel">
            <div className="panel-head"><h2>Company</h2></div>
            <div className="form-grid" style={{ gridTemplateColumns: '1fr', padding: 0, marginBottom: 14 }}>
              <label>Outreach status
                <select value={c.outreach_status || 'Not Contacted'} onChange={e => onOutreachChange(c.id, e.target.value)}>
                  {outreachStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <Info label="Lead status" value={c.lead_status} /><Info label="Lead score" value={`${c.lead_score}/100`} /><Info label="Website condition" value={c.site_condition} /><Info label="GBP" value={c.gbp ? 'Yes' : 'No'} /><Info label="Deal value" value={money(c.deal_value)} /><Info label="Client type" value={c.client_type} /><Info label="Email" value={c.company_email} /><Info label="Phone" value={c.company_phone} /><Info label="Address" value={c.address} /><Info label="Notes" value={c.remarks} />
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
      ) : tab === 'project' ? (
        <ProjectPanel
          c={c}
          retainer={retainer}
          projectStages={projectStages}
          gateStage={gateStage}
          onConvertRetainer={onConvertRetainer}
          onRecordFirstInvoice={onRecordFirstInvoice}
          onStageChange={onProjectStageChange}
          onTierChange={onRetainerTierChange}
          onAddMilestone={onAddMilestone}
          onToggleMilestone={onToggleMilestone}
          onApplyTemplate={onApplyTemplate}
          onUpdateProgress={onUpdateMilestoneProgress}
          onDeleteMilestone={onDeleteMilestone}
        />
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

// The pending -> active step, shared by the company Project tab and the Retainer sidebar view so
// the two cannot drift apart. The mutation it calls is the same one PR 2 introduced; only the
// markup lives here.
function RecordFirstInvoiceControl({ retainer, onRecord }: { retainer: any; onRecord: (r: any, d: string) => void | Promise<void> }) {
  const [date, setDate] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit() {
    if (!date) { alert('Pick the date the first invoice was issued.'); return }
    if (date < retainer.agreement_signed_on) { alert('The first invoice cannot predate the agreement.'); return }
    setSaving(true)
    await onRecord(retainer, date)
    setSaving(false)
    setDate('')
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        type="date"
        value={date}
        min={retainer.agreement_signed_on || undefined}
        disabled={saving}
        onChange={e => setDate(e.target.value)}
        style={{ padding: 8, border: '1px solid var(--line)', background: 'var(--soft)', borderRadius: 9, color: 'var(--text)', fontSize: 12 }}
      />
      <button className="primary" onClick={submit} disabled={saving}>
        {saving ? 'Recording…' : 'Record first invoice'}
      </button>
    </div>
  )
}

// The conversion gate and the retainer summary, on the company's Project tab.
//
// Three states, and the distinction between the first two is the whole point of the design:
//   - no retainer, not at the gate stage  → explain what unlocks it, offer nothing
//   - no retainer, at 'Live / Handover'   → offer the action. Arriving here creates NOTHING.
//   - retainer exists                     → summarise it; if pending, offer the first invoice
function RetainerBlock({ c, retainer, gateStage, onConvert, onRecordFirstInvoice }: { c: any; retainer: any; gateStage: string; onConvert: (c: any) => void; onRecordFirstInvoice: (r: any, d: string) => void }) {
  if (!retainer) {
    const atGate = c.project_stage === gateStage
    return atGate ? (
      <>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 10px' }}>
          Delivery is complete. Converting records the signed agreement — it does not assume the
          client is being billed yet.
        </p>
        <button className="primary" onClick={() => onConvert(c)}><Plus /> Convert to Retainer</button>
      </>
    ) : (
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
        Available once this company reaches <b>{gateStage}</b>. Never straight from Sales
        — the project has to be delivered first.
      </p>
    )
  }

  return (
    <>
      <Info label="Tier" value={retainer.tier} />
      <Info label="Monthly" value={money(retainer.monthly_amount)} />
      <Info label="Status" value={retainerStatusLabels[retainer.status] || retainer.status} />
      <Info label="Agreement signed" value={fmtDate(retainer.agreement_signed_on)} />
      {retainer.status === 'pending' ? (
        <>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '12px 0 8px' }}>
            Signed but not yet invoiced. By SOP this is month 1 — recording the first invoice is
            what starts billing and makes the retainer active.
          </p>
          <RecordFirstInvoiceControl retainer={retainer} onRecord={onRecordFirstInvoice} />
        </>
      ) : (
        <>
          <Info label="First invoice" value={fmtDate(retainer.first_invoice_issued_on)} />
          <Info label="Billing anchor" value={fmtDate(retainer.billing_anchor)} />
          <Info label="Next invoice due" value={fmtDate(retainer.next_invoice_due)} />
        </>
      )}
    </>
  )
}

function ProjectPanel({ c, retainer, projectStages, gateStage, onConvertRetainer, onRecordFirstInvoice, onStageChange, onTierChange, onAddMilestone, onToggleMilestone, onApplyTemplate, onUpdateProgress, onDeleteMilestone }: { c: any; retainer: any; projectStages: string[]; gateStage: string; onConvertRetainer: (c: any) => void; onRecordFirstInvoice: (r: any, d: string) => void; onStageChange: (id: string, stage: string) => void; onTierChange: (id: string, tier: string) => void; onAddMilestone: (c: any, m: any) => void; onToggleMilestone: (companyId: string, milestoneId: string, status: string) => void; onApplyTemplate: (c: any, tier: string) => void; onUpdateProgress: (companyId: string, milestoneId: string, progress: number) => void; onDeleteMilestone: (companyId: string, milestoneId: string) => void }) {
  const [title, setTitle] = useState('')
  const [cadence, setCadence] = useState('once')
  const [category, setCategory] = useState('goal')
  const [priority, setPriority] = useState('Medium')
  const [targetDate, setTargetDate] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const milestones = c.milestones || []
  // A live retainer's tier wins over the legacy column. goalTemplateFor() normalises the case,
  // so 'Growth' from retainers.tier and 'growth' from companies.retainer_tier both resolve.
  const effectiveTier = retainer?.tier || c.retainer_tier || null
  const templateGoals = goalTemplateFor(effectiveTier)
  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    onAddMilestone(c, { title: title.trim(), cadence, category, priority, target_date: targetDate ? new Date(targetDate).toISOString() : undefined })
    setTitle(''); setTargetDate('')
  }
  const columns = milestoneStatuses
  const bucketOf = bucketOfMilestone
  return (
    <>
      <div className="detail-grid">
        <section className="panel">
          <div className="panel-head"><h2>Delivery stage</h2></div>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr', padding: 0 }}>
            <label>Stage (post-close)
              <select value={c.project_stage || ''} onChange={e => onStageChange(c.id, e.target.value)}>
                <option value="">— not started —</option>
                {projectStages.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <div className="panel-head" style={{ marginTop: 22 }}><h2>Retainer</h2></div>
          <RetainerBlock
            c={c}
            retainer={retainer}
            gateStage={gateStage}
            onConvert={onConvertRetainer}
            onRecordFirstInvoice={onRecordFirstInvoice}
          />

          {/* Exactly one tier control is ever on screen. Once a live retainer exists it IS the
              tier, so the legacy companies.retainer_tier select is hidden and the standard goals
              derive from retainers.tier — leaving both visible would be two sources of truth for
              the same fact, free to drift, with nothing to reconcile them. Before conversion
              there is no retainer to conflict with, so the legacy select stays and keeps driving
              the template on its own. The column itself is untouched either way; it is retired
              under the drop-unused workstream, not here. */}
          <div className="panel-head" style={{ marginTop: 22 }}><h2>Retainer goal template</h2></div>
          {retainer ? (
            <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 10px' }}>
              Following the <b>{retainer.tier}</b> retainer above.
            </p>
          ) : (
            <div className="form-grid" style={{ gridTemplateColumns: '1fr', padding: 0 }}>
              <label>Tier
                <select value={c.retainer_tier || ''} onChange={e => onTierChange(c.id, e.target.value)}>
                  <option value="">— none —</option>
                  {retainerTiers.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
          )}
          {templateGoals.length > 0 && (
            <button className="text-btn" style={{ marginTop: 12 }} onClick={() => onApplyTemplate(c, effectiveTier)}>
              <Plus /> Add {effectiveTier}'s standard goals
            </button>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Add a task</h2></div>
          <form onSubmit={submit} className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', padding: 0 }}>
            <label style={{ gridColumn: '1 / -1' }}>Title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Website Redesign" /></label>
            <label>Category
              <select value={category} onChange={e => setCategory(e.target.value)}>
                <option value="goal">Goal</option><option value="deliverable">Deliverable</option>
              </select>
            </label>
            <label>Priority
              <select value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="Low">Low</option><option value="Medium">Medium</option><option value="High">High</option>
              </select>
            </label>
            <label>Cadence
              <select value={cadence} onChange={e => setCadence(e.target.value)}>
                <option value="once">Once</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>
              </select>
            </label>
            <label>Target date<input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} /></label>
            <div style={{ gridColumn: '1 / -1' }}><button className="primary" type="submit"><Plus /> Add task</button></div>
          </form>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head"><h2>Project board</h2></div>
        {milestones.length ? (
          <div className="kanban">
            {columns.map(col => {
              const items = milestones.filter((m: any) => bucketOf(m) === col.key)
              return (
                <div className="column" key={col.key} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragId) onToggleMilestone(c.id, dragId, col.key); setDragId(null) }}>
                  <div className="col-head"><b>{col.label}</b><span>{items.length}</span></div>
                  {items.map((m: any) => (
                    <div className="deal-card project-card" key={m.id} draggable onDragStart={() => setDragId(m.id)} onDragEnd={() => setDragId(null)}>
                      <div className="card-top">
                        <b>{m.title}</b>
                        <button className="icon-btn" style={{ padding: 4, background: 'none', border: 0 }} onClick={() => onDeleteMilestone(c.id, m.id)} title="Delete"><Trash2 /></button>
                      </div>
                      <div className="card-tags">
                        <span className="chip">{m.category}</span>
                        <span className={`priority ${(m.priority || 'Medium').toLowerCase()}`}>{m.priority || 'Medium'}</span>
                        {m.cadence && m.cadence !== 'once' && <span className="chip">{m.cadence}</span>}
                        {m.target_date && <span className="chip">{new Date(m.target_date).toLocaleDateString()}</span>}
                        {isOverdue(m) && <span className="chip overdue">{m.status === 'missed' ? 'Missed' : 'Overdue'}</span>}
                      </div>
                      <MilestoneStatusSelect milestone={m} onChange={st => onToggleMilestone(c.id, m.id, st)} />
                      <div className="progress-track"><div className="progress-fill" style={{ width: `${m.progress ?? 0}%` }} /></div>
                      <div className="progress-row">
                        <ProgressInput value={m.progress ?? 0} onCommit={v => onUpdateProgress(c.id, m.id, v)} />
                        <span>% complete</span>
                      </div>
                    </div>
                  ))}
                  {!items.length && <p style={{ fontSize: 11, color: 'var(--muted)', padding: '8px 2px' }}>Drop a task here</p>}
                </div>
              )
            })}
          </div>
        ) : <Empty title="No tasks yet" text="Add one above, or apply the retainer tier's standard goals." />}
      </section>
    </>
  )
}

function CalendarView({ meetings, companies, googleConn, onSync, onDeleteMeeting, onLinkMeeting }: { meetings: any[]; companies: any[]; googleConn: any; onSync: (manual?: boolean) => void | Promise<void>; onDeleteMeeting: any; onLinkMeeting: any }) {
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
                  <div className="cal-event" key={m.id}>
                    <button className="cal-event-delete" onClick={() => onDeleteMeeting(m)} title="Delete meeting"><X /></button>
                    <strong>{m.companies?.name || m.title}</strong><small>{m.title}{m.google_meet_url ? ' · Meet' : ''}</small>
                    {!m.company_id && <MeetingCompanyPicker meeting={m} companies={companies} onLink={onLinkMeeting} compact />}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function Tasks({ tasks, companies, onToggle, onAdd, onDelete }: { tasks: any[]; companies: any[]; onToggle: any; onAdd: any; onDelete: any }) {
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
            <button className="icon-btn" style={{ padding: 4, background: 'none', border: 0 }} onClick={() => onDelete(t.id)} title="Delete task"><Trash2 /></button>
          </div>
        ))}
        {done.map((t: any) => (
          <div className="task" key={t.id} style={{ opacity: 0.5 }}>
            <button className="check" onClick={() => onToggle(t.id, false)}><CheckCircle2 /></button>
            <div><b style={{ textDecoration: 'line-through' }}>{t.title}</b><p>{t.companies?.name || ''}</p></div>
            <button className="icon-btn" style={{ padding: 4, background: 'none', border: 0 }} onClick={() => onDelete(t.id)} title="Delete task"><Trash2 /></button>
          </div>
        ))}
      </div>
    </>
  )
}

function ProjectsView({ companies, stages, onToggleMilestone, onUpdateProgress, onUpdateFields, onDeleteMilestone, onProjectStageChange, onOpenCompany, onRenameStage, onAddStage, onDeleteStage, onMoveStage }: { companies: any[]; stages: any[]; onToggleMilestone: any; onUpdateProgress: any; onUpdateFields: any; onDeleteMilestone: any; onProjectStageChange: any; onOpenCompany: any; onRenameStage: any; onAddStage: any; onDeleteStage: any; onMoveStage: any }) {
  const [mode, setMode] = useState<'clients' | 'board' | 'table'>('clients')
  const [dragC, setDragC] = useState<string | null>(null)
  const clients = companies.filter((c: any) => c.project_stage)
  const [statusFilter, setStatusFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [companyFilter, setCompanyFilter] = useState('all')
  const [drag, setDrag] = useState<{ id: string; companyId: string } | null>(null)
  const bucketOf = bucketOfMilestone
  const all = companies.flatMap((c: any) => (c.milestones || []).map((m: any) => ({ ...m, companyName: c.name, companyId: c.id })))
  const withTasks = companies.filter((c: any) => (c.milestones || []).length)
  const filtered = all.filter((m: any) =>
    (priorityFilter === 'all' || (m.priority || 'Medium') === priorityFilter) &&
    (statusFilter === 'all' || bucketOf(m) === statusFilter) &&
    (companyFilter === 'all' || m.companyId === companyFilter)
  )
  const columns = milestoneStatuses
  function openCompany(companyId: string) {
    const full = companies.find((c: any) => c.id === companyId)
    if (full) onOpenCompany(full)
  }
  return (
    <>
      <div className="page-title"><div><div className="eyebrow">DELIVERY</div><h1>Projects.</h1><p>Closed clients move through the delivery pipeline here — tasks live on the Tasks board.</p></div></div>
      <div className="filterbar">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div className="view-toggle">
            <button className={mode === 'clients' ? 'active' : ''} onClick={() => setMode('clients')}>Clients</button>
            <button className={mode === 'board' ? 'active' : ''} onClick={() => setMode('board')}>Tasks</button>
            <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>Table</button>
          </div>
          <span>{mode === 'clients' ? `${clients.length} client${clients.length === 1 ? '' : 's'}` : `${filtered.length} task${filtered.length === 1 ? '' : 's'}`}</span>
        </div>
        {mode !== 'clients' && <div style={{ display: 'flex', gap: 8 }}>
          <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)}>
            <option value="all">All companies</option>
            {withTasks.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {milestoneStatuses.map(st => <option key={st.key} value={st.key}>{st.label}</option>)}
          </select>
          <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
            <option value="all">All priorities</option>
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
          </select>
        </div>}
      </div>
      {mode === 'clients' ? (
        clients.length ? (
          <div className="kanban">
            {stages.map((s: any) => { const stage = s.name; return (
                <div className="column" key={stage} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragC) onProjectStageChange(dragC, stage); setDragC(null) }}>
                  <div className="col-head">
                    <b>{stage}</b>
                    <span className="col-tools">
                      <button className="col-edit" title="Move left" onClick={() => onMoveStage(s, -1)}>‹</button>
                      <button className="col-edit" title="Move right" onClick={() => onMoveStage(s, 1)}>›</button>
                      <button className="col-edit" title="Rename stage" onClick={() => onRenameStage(s)}><Pencil /></button>
                      <button className="col-edit" title="Delete stage" onClick={() => onDeleteStage(s)}><Trash2 /></button>
                      {clients.filter((c: any) => c.project_stage === stage).length}
                    </span>
                  </div>
                  {clients.filter((c: any) => c.project_stage === stage).map((c: any) => {
                    const ms = c.milestones || []
                    const done = ms.filter((m: any) => m.status === 'done').length
                    const avg = ms.length ? Math.round(ms.reduce((s: number, m: any) => s + (m.progress ?? 0), 0) / ms.length) : 0
                    return (
                      <div className="deal-card" key={c.id} draggable onDragStart={() => setDragC(c.id)} onDragEnd={() => setDragC(null)} onClick={() => onOpenCompany(c)}>
                        <div className="card-top"><b>{c.name}</b>{c.retainer_tier ? <span>{c.retainer_tier}</span> : null}</div>
                        <p>{ms.length ? `${done}/${ms.length} tasks done` : 'No tasks yet'}</p>
                        {ms.length ? <div className="progress-track"><div className="progress-fill" style={{ width: `${avg}%` }} /></div> : null}
                      </div>
                    )
                  })}
                </div>
            )})}
            <div className="column">
              <button className="ghost add-stage" onClick={onAddStage}><Plus /> Add stage</button>
            </div>
          </div>
        ) : <Empty title="No clients in delivery yet" text="Close a deal on the Sales board and the company lands here automatically." />
      ) : !all.length ? (
        <Empty title="No tasks yet" text="Add goals or deliverables from a company's Project tab." />
      ) : mode === 'board' ? (
        <div className="kanban">
          {columns.map(col => {
            const items = filtered.filter((m: any) => bucketOf(m) === col.key)
            return (
              <div
                className="column"
                key={col.key}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); if (drag) onToggleMilestone(drag.companyId, drag.id, col.key); setDrag(null) }}
              >
                <div className="col-head"><b>{col.label}</b><span>{items.length}</span></div>
                {items.map((m: any) => (
                  <div className="deal-card project-card" key={m.id} draggable onDragStart={() => setDrag({ id: m.id, companyId: m.companyId })} onDragEnd={() => setDrag(null)}>
                    <div className="card-top">
                      <b>{m.title}</b>
                      <button className="icon-btn" style={{ padding: 4, background: 'none', border: 0 }} onClick={() => onDeleteMilestone(m.companyId, m.id)} title="Delete"><Trash2 /></button>
                    </div>
                    <button className="text-btn" style={{ padding: '2px 0', marginBottom: 4, fontSize: 11 }} onClick={() => openCompany(m.companyId)}>{m.companyName}</button>
                    <div className="card-tags">
                      <span className="chip">{m.category}</span>
                      <span className={`priority ${(m.priority || 'Medium').toLowerCase()}`}>{m.priority || 'Medium'}</span>
                      {m.cadence && m.cadence !== 'once' && <span className="chip">{m.cadence}</span>}
                      {m.target_date && <span className="chip">{new Date(m.target_date).toLocaleDateString()}</span>}
                      {isOverdue(m) && <span className="chip overdue">{m.status === 'missed' ? 'Missed' : 'Overdue'}</span>}
                    </div>
                    <MilestoneStatusSelect milestone={m} onChange={st => onToggleMilestone(m.companyId, m.id, st)} />
                    <div className="progress-track"><div className="progress-fill" style={{ width: `${m.progress ?? 0}%` }} /></div>
                    <div className="progress-row">
                      <ProgressInput value={m.progress ?? 0} onCommit={v => onUpdateProgress(m.companyId, m.id, v)} />
                      <span>% complete</span>
                    </div>
                  </div>
                ))}
                {!items.length && <p style={{ fontSize: 11, color: 'var(--muted)', padding: '8px 2px' }}>Nothing here</p>}
              </div>
            )
          })}
        </div>
      ) : (
        <section className="panel" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="ptable">
              <thead>
                <tr><th>Task</th><th>Company</th><th>Status</th><th>Priority</th><th>Progress</th><th>Target date</th><th>Cadence</th><th>Category</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {filtered.map((m: any) => (
                  <tr key={m.id}>
                    <td className="title-cell">
                      {/* Uncontrolled on purpose: commits on blur/Enter so we don't fire a DB write
                          per keystroke; keyed on title so an edit from elsewhere refreshes it. */}
                      <input
                        className="title-input"
                        key={m.id + (m.title || '')}
                        defaultValue={m.title}
                        onBlur={e => { const v = e.target.value.trim(); if (v && v !== m.title) onUpdateFields(m.companyId, m.id, { title: v }) }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      />
                    </td>
                    <td><button className="text-btn" onClick={() => openCompany(m.companyId)}>{m.companyName}</button></td>
                    <td>
                      <select value={m.status || 'pending'} onChange={e => onUpdateFields(m.companyId, m.id, { status: e.target.value })}>
                        <option value="pending">Not started</option>
                        <option value="in_progress">In progress</option>
                        <option value="done">Done</option>
                        <option value="missed">Missed</option>
                      </select>
                    </td>
                    <td>
                      <select value={m.priority || 'Medium'} onChange={e => onUpdateFields(m.companyId, m.id, { priority: e.target.value })}>
                        <option value="Low">Low</option><option value="Medium">Medium</option><option value="High">High</option>
                      </select>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <ProgressInput value={m.progress ?? 0} onCommit={v => onUpdateProgress(m.companyId, m.id, v)} />
                        <div className="progress-track" style={{ width: 64 }}><div className="progress-fill" style={{ width: `${m.progress ?? 0}%` }} /></div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="date" value={m.target_date ? new Date(m.target_date).toISOString().slice(0, 10) : ''} onChange={e => onUpdateFields(m.companyId, m.id, { target_date: e.target.value ? new Date(e.target.value).toISOString() : null })} />
                        {isOverdue(m) && <span className="chip overdue">{m.status === 'missed' ? 'Missed' : 'Overdue'}</span>}
                      </div>
                    </td>
                    <td>
                      <select value={m.cadence || 'once'} onChange={e => onUpdateFields(m.companyId, m.id, { cadence: e.target.value })}>
                        <option value="once">Once</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>
                      </select>
                    </td>
                    <td>
                      <select value={m.category || 'goal'} onChange={e => onUpdateFields(m.companyId, m.id, { category: e.target.value })}>
                        <option value="goal">Goal</option><option value="deliverable">Deliverable</option>
                      </select>
                    </td>
                    <td><button className="icon-btn" style={{ padding: 4, background: 'none', border: 0 }} onClick={() => onDeleteMilestone(m.companyId, m.id)} title="Delete"><Trash2 /></button></td>
                  </tr>
                ))}
                {!filtered.length && <tr><td colSpan={9}><Empty title="No matching tasks" text="Adjust the filters above." /></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}

// One retainer row. Its own component so the pending invoice control can hold local state
// without the whole list re-rendering, and so churned rows can render read-only in one place.
function RetainerCard({ r, companyName, onChangeTier, onPause, onResume, onChurn, onRecordFirstInvoice, onOpenCompany }: any) {
  const terminal = r.status === 'churned'
  return (
    <div className="company-card" style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="logo-dot big">{initials(companyName)}</div>
      <div className="cc-main">
        <div className="cc-title">
          <h3>{companyName}</h3>
          <span className="status">{retainerStatusLabels[r.status] || r.status}</span>
        </div>
        <p>{r.tier} · agreement signed {fmtDate(r.agreement_signed_on)}</p>
        <div className="chips">
          {terminal ? (
            <span>Churned {fmtDate(r.churned_at)}</span>
          ) : r.status === 'pending' ? (
            <span>Awaiting first invoice</span>
          ) : (
            <>
              <span>Anchor {fmtDate(r.billing_anchor)}</span>
              <span>Next invoice {fmtDate(r.next_invoice_due)}</span>
            </>
          )}
          {/* Case-insensitive by way of goalTemplateFor — retainers.tier is Title Case while the
              template map is keyed lowercase. A direct index would silently show nothing. */}
          {goalTemplateFor(r.tier).length > 0 && <span>{goalTemplateFor(r.tier).length} standard goals</span>}
        </div>

        {!terminal && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <select
              className="outreach-select"
              style={{ margin: 0, width: 'auto' }}
              value={r.tier}
              onChange={e => onChangeTier(r, e.target.value)}
            >
              {retainerTierNames.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {r.status === 'paused'
              ? <button className="ghost" onClick={() => onResume(r)}>Resume</button>
              : <button className="ghost" onClick={() => onPause(r)}>Pause</button>}
            <button className="ghost" onClick={() => onChurn(r)}>Churn</button>
            <button className="text-btn" onClick={() => onOpenCompany(r.company_id)}>Open company <ArrowUpRight /></button>
          </div>
        )}
        {terminal && (
          <div style={{ marginTop: 10 }}>
            <button className="text-btn" onClick={() => onOpenCompany(r.company_id)}>Open company <ArrowUpRight /></button>
          </div>
        )}

        {r.status === 'pending' && (
          <div style={{ marginTop: 10 }}>
            <RecordFirstInvoiceControl retainer={r} onRecord={onRecordFirstInvoice} />
          </div>
        )}
      </div>
      <div className="cc-value">
        <span>Monthly</span>
        <b>{money(r.monthly_amount)}</b>
      </div>
    </div>
  )
}

// The Retainer sidebar view. Live engagements come from current_retainers; churned ones arrive in
// a separate array read with an explicit status filter. The two are never concatenated before the
// summary is computed, which is what keeps a churned engagement out of the MRR total by
// construction rather than by remembering to filter.
function RetainerView({ live, churned, companies, allCompanies, onChangeTier, onPause, onResume, onChurn, onRecordFirstInvoice, onOpenCompany }: any) {
  const [filter, setFilter] = useState<'live' | 'pending' | 'active' | 'paused' | 'churned'>('live')

  // Names resolve from the full company list so a churned retainer still shows who it belonged to.
  const nameOf = (id: string) => allCompanies.find((c: any) => c.id === id)?.name || 'Unknown company'
  // ...while visibility honours the header search, which filters companies, not retainers.
  const visible = new Set(companies.map((c: any) => c.id))

  // Summary is deliberately computed from `live` only and is NOT narrowed by the search box —
  // these are business totals, not a count of what is currently on screen.
  const counts = {
    active: live.filter((r: any) => r.status === 'active').length,
    pending: live.filter((r: any) => r.status === 'pending').length,
    paused: live.filter((r: any) => r.status === 'paused').length,
  }
  // Active only. A paused retainer is not billing, and churned rows are not in `live` at all.
  const mrr = live.filter((r: any) => r.status === 'active')
    .reduce((sum: number, r: any) => sum + (Number(r.monthly_amount) || 0), 0)

  const source = filter === 'churned' ? churned : live
  const shown = source
    .filter((r: any) => (filter === 'live' || filter === 'churned' ? true : r.status === filter))
    .filter((r: any) => visible.has(r.company_id))

  const tabs: { key: typeof filter; label: string }[] = [
    { key: 'live', label: 'All live' },
    { key: 'pending', label: 'Pending' },
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'churned', label: 'Churned' },
  ]

  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">RECURRING</div>
          <h1>Retainer.</h1>
          <p>Clients on an ongoing agreement. Started from a company’s Project tab once delivery is done.</p>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Active" value={counts.active} />
        <Metric label="Pending first invoice" value={counts.pending} />
        <Metric label="Paused" value={counts.paused} />
        <Metric label="MRR (active only)" value={money(mrr)} />
      </div>

      <div className="filterbar">
        <span>
          {shown.length} {shown.length === 1 ? 'retainer' : 'retainers'}
          {filter === 'churned' ? ' · history, excluded from the totals above' : ''}
        </span>
        <div>
          {tabs.map(t => (
            <button key={t.key} className={filter === t.key ? 'active' : ''} onClick={() => setFilter(t.key)}>
              {t.label}{t.key === 'churned' && churned.length ? ` (${churned.length})` : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="company-list">
        {shown.length ? shown.map((r: any) => (
          <RetainerCard
            key={r.id}
            r={r}
            companyName={nameOf(r.company_id)}
            onChangeTier={onChangeTier}
            onPause={onPause}
            onResume={onResume}
            onChurn={onChurn}
            onRecordFirstInvoice={onRecordFirstInvoice}
            onOpenCompany={onOpenCompany}
          />
        )) : filter === 'churned' ? (
          <Empty title="No churned retainers" text="Nothing has been churned yet — churning keeps the record, it never deletes it." />
        ) : (
          <Empty title="No retainers here" text="Convert a company from its Project tab once it reaches Live / Handover." />
        )}
      </div>
    </>
  )
}

function SettingsView({ googleConn, profile, user }: { googleConn: any; profile: any; user: any }) {
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
        <div className="panel">
          <h2>Workspace</h2>
          <p>Shared two-person outreach workspace. Everyone approved sees every company.</p>
          <Info label="Signed in as" value={profile?.display_name || profile?.username || user?.email} />
          <Info label="Role" value={profile ? profile.role : '—'} />
          <Info label="Access" value={profile ? (profile.approved ? 'Approved' : 'Pending approval') : '—'} />
          <p style={{ marginTop: 12, fontSize: 11 }}>
            Roles are recorded but not yet enforced — admin and member currently have identical
            permissions. Access is what the database actually checks: an unapproved account can
            sign in but reads nothing. Approve one from the Supabase table editor.
          </p>
        </div>
      </div>
    </>
  )
}

function CompanyForm({ stages, initial, onClose, onSave }: { stages: string[]; initial?: any; onClose: () => void; onSave: (c: any) => void }) {
  const [f, setF] = useState<any>(initial ? {
    name: initial.name || '', lead_status: initial.lead_status || 'Prospect', lead_score: initial.lead_score ?? 50,
    website: initial.website || '', site_condition: initial.site_condition || 'Outdated', gbp: !!initial.gbp,
    deal_value: initial.deal_value ?? null,
    client_type: initial.client_type || 'not active', company_email: initial.company_email || '',
    company_phone: initial.company_phone || '', instagram: initial.instagram || '', linkedin: initial.linkedin || '',
    address: initial.address || '', remarks: initial.remarks || '',
    contact: { id: initial.contact?.id, name: initial.contact?.name || '', title: initial.contact?.title || 'Founder', email: initial.contact?.email || '', phone: initial.contact?.phone || '', instagram: initial.contact?.instagram || '', linkedin: initial.contact?.linkedin || '' },
  } : {
    name: '', lead_status: 'Prospect', lead_score: 50, site_condition: 'Outdated', gbp: false,
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

function ConvertToRetainerForm({ company, onClose, onSave }: { company: any; onClose: () => void; onSave: (f: any) => void }) {
  const [tier, setTier] = useState(retainerTierNames[0])
  const [amount, setAmount] = useState(String(retainerTierDefaults[retainerTierNames[0]]))
  // Once the amount has been typed over, changing tier stops overwriting it — the agreed number
  // is the one that matters and it is not always the list price.
  const [amountTouched, setAmountTouched] = useState(false)
  const [signed, setSigned] = useState('')
  const [invoiced, setInvoiced] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!signed) { alert('The agreement date is required — it is what creates the retainer.'); return }
    const n = Number(amount)
    if (!Number.isFinite(n) || n < 0) { alert('Enter a valid monthly amount.'); return }
    if (invoiced && invoiced < signed) { alert('The first invoice cannot predate the agreement.'); return }
    setSaving(true)
    await onSave({ tier, monthly_amount: n, agreement_signed_on: signed, first_invoice_issued_on: invoiced || null })
    setSaving(false)
  }

  return (
    <div className="modal-back">
      <div className="modal" style={{ width: 'min(560px,96vw)' }}>
        <div className="modal-head">
          <div><div className="eyebrow">CONVERT TO RETAINER</div><h2>{company.name}</h2></div>
          <button onClick={onClose} disabled={saving}><X /></button>
        </div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label>Tier
            <select
              value={tier}
              disabled={saving}
              onChange={e => {
                setTier(e.target.value)
                if (!amountTouched) setAmount(String(retainerTierDefaults[e.target.value]))
              }}
            >
              {retainerTierNames.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>Monthly amount (₹)
            <input
              type="number" min={0} value={amount} disabled={saving}
              onChange={e => { setAmount(e.target.value); setAmountTouched(true) }}
            />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>Agreement signed on *
            <input type="date" value={signed} disabled={saving} onChange={e => setSigned(e.target.value)} />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>First invoice issued on
            <input type="date" value={invoiced} min={signed || undefined} disabled={saving} onChange={e => setInvoiced(e.target.value)} />
          </label>
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', padding: '0 22px', margin: '0 0 8px', lineHeight: 1.6 }}>
          Leave the invoice date blank if it has not been raised yet — that is the normal case, and
          the retainer is created <b>pending</b> until you record it. Filling it in now creates the
          retainer already <b>active</b>, with billing anchored to that date.
        </p>
        <div className="modal-foot">
          <button className="ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={submit} disabled={saving || !signed}>
            {saving ? 'Creating…' : 'Create retainer'}
          </button>
        </div>
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
  const [type, setType] = useState('Discovery Call')
  const [title, setTitle] = useState(`Discovery Call — ${company.name}`)
  const [titleTouched, setTitleTouched] = useState(false)
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
    await onSave({ title, meeting_type: type, starts_at: starts_at.toISOString(), ends_at: ends_at.toISOString(), location })
    setSaving(false)
  }
  return (
    <div className="modal-back">
      <div className="modal" style={{ width: 'min(500px,96vw)' }}>
        <div className="modal-head"><div><div className="eyebrow">NEW MEETING</div><h2>{company.name}</h2></div><button onClick={onClose} disabled={saving}><X /></button></div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label style={{ gridColumn: '1 / -1' }}>Type
            <select
              value={type}
              disabled={saving}
              onChange={e => {
                setType(e.target.value)
                // Keep the title in step until the user writes their own, then leave it alone.
                if (!titleTouched) setTitle(`${e.target.value} — ${company.name}`)
              }}
            >
              {meetingTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>Title<input value={title} onChange={e => { setTitle(e.target.value); setTitleTouched(true) }} disabled={saving} /></label>
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
