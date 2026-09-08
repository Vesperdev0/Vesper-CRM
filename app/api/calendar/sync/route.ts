import { NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/server'
import { connectedCalendar } from '../../../../lib/google'

// Pulls events from the connected Google Calendar and mirrors them into the local `meetings`
// table. Meetings VESPER itself created already carry their google_event_id (set at creation
// time in app/api/calendar/events), so this upsert updates those rows in place instead of
// duplicating them. Anything on the calendar that VESPER didn't create lands as a new,
// company-less meeting row — link it to a company by hand from the Companies view.
//
// Deletions propagate too: showDeleted makes events.list include cancelled events, and their
// local mirror rows are removed. Only within the listing window (past week onward, 250 events)
// — an event cancelled while older than that window keeps its local row, which is the same
// window in which we'd have stopped showing it anyway.
export async function POST() {
  const sup = await getServerSupabase()
  const { data: { user } } = await sup.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cc = await connectedCalendar(sup, user.id)
  if (!cc) return NextResponse.json({ error: 'Connect Google Calendar first' }, { status: 400 })
  const { conn, calendar } = cc

  let events: any[]
  try {
    const res = await calendar.events.list({
      calendarId: conn.calendar_id || 'primary',
      timeMin: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // include the past week so recently-passed meetings still show
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      showDeleted: true,
    })
    events = res.data.items || []
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not reach Google Calendar. Try reconnecting it.' }, { status: 502 })
  }

  const cancelledIds = events.filter(ev => ev.id && ev.status === 'cancelled').map(ev => ev.id as string)
  if (cancelledIds.length) {
    const { error } = await sup.from('meetings').delete().in('google_event_id', cancelledIds)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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
      // `status` deliberately absent: new rows get the DB default ('scheduled'), and a status
      // someone set locally (e.g. completed) survives the re-sync instead of reverting.
    }))

  if (rows.length) {
    // Only the columns above get written on conflict — company_id/created_by/opportunity_id are
    // never included here, so a meeting someone already linked to a company keeps that link on
    // every re-sync instead of being wiped back to null.
    const { error } = await sup.from('meetings').upsert(rows, { onConflict: 'google_event_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ synced: rows.length, removed: cancelledIds.length })
}
