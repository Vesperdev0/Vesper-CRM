import { google } from 'googleapis'
export function googleOAuth(){return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI)}
export function googleAuthUrl(state:string){const o=googleOAuth();return o.generateAuthUrl({access_type:'offline',prompt:'consent',scope:['https://www.googleapis.com/auth/calendar'],state})}
export async function calendarClient(accessToken:string,refreshToken?:string){const o=googleOAuth();o.setCredentials({access_token:accessToken,refresh_token:refreshToken});return {o,calendar:google.calendar({version:'v3',auth:o})}}
