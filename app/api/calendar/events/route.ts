import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/server'
import { connectedCalendar } from '../../../../lib/google'

export async function POST(req: NextRequest) {
  const sup = await getServerSupabase()
  const { data: { user } } = await sup.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const cc = await connectedCalendar(sup, user.id)
  if (!cc) return NextResponse.json({ error: 'Connect Google Calendar first' }, { status: 400 })
  const { conn, calendar } = cc

  const event = await calendar.events.insert({
    calendarId: conn.calendar_id || 'primary',
    conferenceDataVersion: 1,
    requestBody: {
      summary: body.title,
      description: body.description || '',
      location: body.location || '',
      start: { dateTime: body.starts_at },
      end: { dateTime: body.ends_at },
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    },
  })
  return NextResponse.json({ event: event.data })
}

export async function DELETE(req: NextRequest) {
  const sup = await getServerSupabase()
  const { data: { user } } = await sup.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const eventId = req.nextUrl.searchParams.get('eventId')
  if (!eventId) return NextResponse.json({ error: 'Missing eventId' }, { status: 400 })

  const cc = await connectedCalendar(sup, user.id)
  if (!cc) return NextResponse.json({ error: 'Connect Google Calendar first' }, { status: 400 })
  const { conn, calendar } = cc

  try {
    await calendar.events.delete({ calendarId: conn.calendar_id || 'primary', eventId })
  } catch (e: any) {
    // Google returns 410 Gone if the event was already removed/cancelled on their side —
    // that's the end state we wanted anyway, so treat it as success, not a failure.
    const status = e?.code || e?.response?.status
    if (status !== 410) {
      return NextResponse.json({ error: e?.message || 'Could not delete the calendar event' }, { status: 502 })
    }
  }
  return NextResponse.json({ ok: true })
}
