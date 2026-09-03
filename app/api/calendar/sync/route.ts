import { NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/server'
import { calendarClient } from '../../../../lib/google'

// Pulls events from the connected Google Calendar and mirrors them into the local `meetings`
// table. Meetings VESPER itself created already carry their google_event_id (set at creation
// time in app/api/calendar/events), so this upsert updates those rows in place instead of
// duplicating them. Anything on the calendar that VESPER didn't create lands as a new,
// company-less meeting row — link it to a company by hand from the Companies view.
//
// Known limitation: this only adds/updates events, it doesn't remove local meetings when the
// matching Google event is deleted or cancelled (events.list doesn't return cancellations
// unless you ask for them, and handling that safely needs more care than "functional ASAP"
// calls for right now). Revisit if stale cancelled meetings become a real problem.
export async function POST() {
  const sup = await getServerSupabase()
  const { data: { user } } = await sup.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: conn } = await sup.from('calendar_connections').select('*').eq('user_id', user.id).single()
  if (!conn) return NextResponse.json({ error: 'Connect Google Calendar first' }, { status: 400 })

  const { calendar } = await calendarClient(conn.access_token, conn.refresh_token)

  let events: any[]
  try {
    const res = await calendar.events.list({
      calendarId: conn.calendar_id || 'primary',
      timeMin: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // include the past week so recently-passed meetings still show
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    })
    events = res.data.items || []
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not reach Google Calendar. Try reconnecting it.' }, { status: 502 })
  }

  const rows = events
    .filter(ev => ev.id && ev.status !== 'cancelled' && (ev.start?.dateTime || ev.start?.date))
    .map(ev => ({
      google_event_id: ev.id as string,
      google_calendar_id: conn.calendar_id || 'primary',
      title: ev.summary || '(no title)',
      starts_at: ev.start?.dateTime || ev.start?.date,
      ends_at: ev.end?.dateTime || ev.end?.date || ev.start?.dateTime || ev.start?.date,
      location: ev.location || null,
      google_meet_url: ev.hangoutLink || null,
      status: 'scheduled',
    }))

  if (rows.length) {
    // Only the columns above get written on conflict — company_id/created_by/opportunity_id are
    // never included here, so a meeting someone already linked to a company keeps that link on
    // every re-sync instead of being wiped back to null.
    const { error } = await sup.from('meetings').upsert(rows, { onConflict: 'google_event_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ synced: rows.length })
}
