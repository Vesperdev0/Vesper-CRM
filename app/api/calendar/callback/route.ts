import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/server'
import { googleOAuth } from '../../../../lib/google'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  if (!code || !state) return NextResponse.json({ error: 'Missing OAuth response' }, { status: 400 })

  const o = googleOAuth()
  const { tokens } = await o.getToken(code)
  o.setCredentials(tokens)

  const sup = await getServerSupabase()
  const { data: { user } } = await sup.auth.getUser()
  if (!user || user.id !== state) return NextResponse.json({ error: 'OAuth state mismatch' }, { status: 401 })

  const { google } = await import('googleapis')
  const cal = google.calendar({ version: 'v3', auth: o })
  const me = await cal.calendarList.list()
  const primary = me.data.items?.find(x => x.primary) || me.data.items?.[0]

  const { error } = await sup.from('calendar_connections').upsert({
    user_id: user.id,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    calendar_id: primary?.id || 'primary',
    connected_email: primary?.summary || null,
    updated_at: new Date().toISOString(),
  })

  // This is the exact spot that silently swallowed a failure last time (the table didn't exist
  // yet, and the redirect below fired anyway as if it had worked). Never do that again here —
  // if the write failed, say so in the redirect instead of pretending it succeeded.
  if (error) {
    return NextResponse.redirect(new URL(`/?calendar=error&reason=${encodeURIComponent(error.message)}`, req.url))
  }

  return NextResponse.redirect(new URL('/?calendar=connected', req.url))
}
