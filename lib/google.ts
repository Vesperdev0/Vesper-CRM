import { google } from 'googleapis'
export function googleOAuth(){return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI)}
export function googleAuthUrl(state:string){const o=googleOAuth();return o.generateAuthUrl({access_type:'offline',prompt:'consent',scope:['https://www.googleapis.com/auth/calendar'],state})}

// Loads the user's stored Google connection and returns an authenticated Calendar client.
// Two things the old calendarClient() never did: it passes expiry_date so googleapis knows
// WHEN to refresh (before, expiry was never checked at all), and it writes refreshed tokens
// back to calendar_connections (before, a refreshed access token lived only in memory for
// that one request, so every later request started from the stale one).
export async function connectedCalendar(sup: any, userId: string) {
  const { data: conn } = await sup.from('calendar_connections').select('*').eq('user_id', userId).single()
  if (!conn) return null
  const o = googleOAuth()
  o.setCredentials({
    access_token: conn.access_token,
    refresh_token: conn.refresh_token || undefined,
    expiry_date: conn.expires_at ? new Date(conn.expires_at).getTime() : undefined,
  })
  o.on('tokens', async (t) => {
    const patch: Record<string, string> = { updated_at: new Date().toISOString() }
    if (t.access_token) patch.access_token = t.access_token
    if (t.refresh_token) patch.refresh_token = t.refresh_token
    if (t.expiry_date) patch.expires_at = new Date(t.expiry_date).toISOString()
    await sup.from('calendar_connections').update(patch).eq('user_id', userId)
  })
  return { conn, calendar: google.calendar({ version: 'v3', auth: o }) }
}
