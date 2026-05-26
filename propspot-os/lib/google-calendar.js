// Google Calendar OAuth + read/write helpers for the per-user Personal
// calendar feature. Uses the SAME Google OAuth client + redirect URI as
// the inbox Gmail flow (one fewer Cloud Console entry to maintain) and
// dispatches via the `kind` field on the signed state JWT.

const { google } = require('googleapis');
const { query }  = require('../db');
const { encrypt, decrypt } = require('./inbox-crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
  'profile'
];

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT
  );
}

function buildConsentUrl(state) {
  const oauth = makeOAuthClient();
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true
  });
}

// Exchange a one-time `code` for refresh + access tokens. Throws if Google
// doesn't return a refresh_token (it sometimes silently drops it on repeat
// grants — the user needs to revoke at myaccount.google.com).
async function exchangeCodeForTokens(code) {
  const oauth = makeOAuthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Revoke the existing grant ' +
      'for this account at https://myaccount.google.com/permissions and try again.'
    );
  }
  oauth.setCredentials(tokens);
  const userInfo = await google.oauth2('v2').userinfo.get({ auth: oauth });
  return {
    refreshToken: tokens.refresh_token,
    email:        userInfo.data.email,
    displayName:  userInfo.data.name || null
  };
}

// Persist the (encrypted) refresh token onto the user row.
async function saveUserCalendarGrant(userId, refreshToken) {
  await query(
    `UPDATE users
        SET google_calendar_refresh_encrypted = $1,
            google_calendar_connected_at      = NOW()
      WHERE id = $2`,
    [encrypt(refreshToken), userId]
  );
}

async function getUserGrant(userId) {
  const { rows } = await query(
    `SELECT google_calendar_refresh_encrypted, google_email, email
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0] || !rows[0].google_calendar_refresh_encrypted) return null;
  return {
    refresh_token: decrypt(rows[0].google_calendar_refresh_encrypted),
    email:         rows[0].google_email || rows[0].email
  };
}

// Build an authenticated Calendar API client for a given user. Returns
// null when the user hasn't connected their calendar.
async function clientForUser(userId) {
  const grant = await getUserGrant(userId);
  if (!grant) return null;
  const oauth = makeOAuthClient();
  oauth.setCredentials({ refresh_token: grant.refresh_token });
  return {
    cal:    google.calendar({ version: 'v3', auth: oauth }),
    email:  grant.email
  };
}

// Pull events from the user's primary calendar inside [from, to).
// Returns the events array unchanged from Google (mapped to our shape
// by the caller).
async function listEvents(userId, fromISO, toISO) {
  const c = await clientForUser(userId);
  if (!c) return [];
  const { data } = await c.cal.events.list({
    calendarId:   'primary',
    timeMin:      fromISO,
    timeMax:      toISO,
    singleEvents: true,
    orderBy:      'startTime',
    maxResults:   250
  });
  return (data.items || []).filter(e => e.status !== 'cancelled');
}

// Create an event in the user's primary calendar, optionally with a
// Google Meet conferenceData entry. Returns the inserted event including
// google id + meet url.
//   evt: { summary, description, start, end, allDay }
//   opts: { createMeet }
async function createEvent(userId, evt, opts = {}) {
  const c = await clientForUser(userId);
  if (!c) throw new Error('No Google Calendar grant for this user');

  const start = evt.allDay
    ? { date: evt.start.slice(0, 10) }
    : { dateTime: new Date(evt.start).toISOString() };
  const end = evt.allDay
    ? { date: (evt.end || evt.start).slice(0, 10) }
    : { dateTime: new Date(evt.end || evt.start).toISOString() };

  const requestBody = {
    summary:     evt.summary,
    description: evt.description || undefined,
    start, end
  };
  let conferenceDataVersion = 0;
  if (opts.createMeet) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: 'propspot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    };
    conferenceDataVersion = 1;
  }
  const { data } = await c.cal.events.insert({
    calendarId: 'primary',
    requestBody,
    conferenceDataVersion
  });
  return {
    googleEventId: data.id,
    meetUrl:       data.hangoutLink || data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null,
    htmlLink:      data.htmlLink || null
  };
}

module.exports = {
  buildConsentUrl,
  exchangeCodeForTokens,
  saveUserCalendarGrant,
  clientForUser,
  listEvents,
  createEvent,
  getUserGrant
};
