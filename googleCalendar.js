// One-time OAuth connection to a Google account (done once, by a super_admin,
// via the Settings screen), used afterward to create real Calendar events
// with an auto-generated Google Meet link for interviews. The refresh token
// lives in its own `oauth_tokens` table — deliberately outside the generic
// CRUD system in server.js, so it's never exposed through any list/detail
// API route the way a normal table's data is.
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function getRedirectUri() {
  const base = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${base}/api/google/oauth/callback`;
}

function getOAuthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google Calendar isn\'t configured yet — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing from .env.');
  }
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, getRedirectUri());
}

function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token back even on repeat connects
    scope: SCOPES
  });
}

async function handleOAuthCallback({ code, userId, dbRun }) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google didn\'t return a refresh token — try disconnecting access at myaccount.google.com/permissions and reconnecting.');
  }
  await dbRun(
    `INSERT INTO oauth_tokens (provider, refresh_token, access_token, expiry_date, connected_by, updated_at)
     VALUES ('google', ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET refresh_token=excluded.refresh_token, access_token=excluded.access_token, expiry_date=excluded.expiry_date, connected_by=excluded.connected_by, updated_at=datetime('now')`,
    [tokens.refresh_token, tokens.access_token || null, tokens.expiry_date || null, userId]
  );
}

async function isConnected({ dbGet }) {
  const row = await dbGet("SELECT provider FROM oauth_tokens WHERE provider = 'google'");
  return !!row;
}

async function disconnect({ dbRun }) {
  await dbRun("DELETE FROM oauth_tokens WHERE provider = 'google'");
}

async function getAuthorizedClient({ dbGet, dbRun }) {
  const row = await dbGet("SELECT * FROM oauth_tokens WHERE provider = 'google'");
  if (!row) throw new Error('Google Calendar isn\'t connected yet — connect it from Settings first.');
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: row.refresh_token, access_token: row.access_token, expiry_date: row.expiry_date });
  client.on('tokens', async (tokens) => {
    // googleapis refreshes the access token automatically when it's expired;
    // persist the new one so we don't re-request it on every single call.
    await dbRun(
      `UPDATE oauth_tokens SET access_token = ?, expiry_date = ?, updated_at = datetime('now') WHERE provider = 'google'`,
      [tokens.access_token || row.access_token, tokens.expiry_date || row.expiry_date]
    );
  });
  return client;
}

// Creates a Calendar event with an auto-generated Meet link. sendUpdates is
// 'none' because this app sends its own confirmation/reminder emails —
// otherwise attendees would get a Google Calendar invite AND our email.
async function createMeetEvent({ dbGet, dbRun }, { summary, description, startDateTime, endDateTime, attendeeEmails }) {
  const auth = await getAuthorizedClient({ dbGet, dbRun });
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.insert({
    calendarId: 'primary',
    sendUpdates: 'none',
    conferenceDataVersion: 1,
    requestBody: {
      summary,
      description,
      start: { dateTime: startDateTime, timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' },
      end: { dateTime: endDateTime, timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' },
      attendees: (attendeeEmails || []).filter(Boolean).map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: `${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    }
  });
  const meetLink = res.data.hangoutLink || res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  if (!meetLink) throw new Error('Google created the event but didn\'t return a Meet link — check the event on Google Calendar directly.');
  return { meetLink, eventId: res.data.id };
}

// Moves an existing event when an interview is rescheduled (the Meet link stays the same).
async function updateEventTimes({ dbGet, dbRun }, eventId, startDateTime, endDateTime) {
  const auth = await getAuthorizedClient({ dbGet, dbRun });
  const calendar = google.calendar({ version: 'v3', auth });
  const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  await calendar.events.patch({ calendarId: 'primary', eventId, sendUpdates: 'none', requestBody: { start: { dateTime: startDateTime, timeZone: tz }, end: { dateTime: endDateTime, timeZone: tz } } });
}

module.exports = { updateEventTimes, getAuthUrl, handleOAuthCallback, isConnected, disconnect, createMeetEvent };
