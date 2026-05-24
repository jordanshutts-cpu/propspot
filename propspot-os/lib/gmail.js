// Gmail API client per connected mailbox.
// Uses the stored encrypted refresh_token to mint short-lived access tokens.

const { google } = require('googleapis');
const { query } = require('../db');
const { encrypt, decrypt } = require('./inbox-crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
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

async function exchangeCodeForTokens(code) {
  const oauth = makeOAuthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh_token. Revoke the existing grant for this account at https://myaccount.google.com/permissions and try again.');
  }
  oauth.setCredentials(tokens);
  const userInfo = await google.oauth2('v2').userinfo.get({ auth: oauth });
  return {
    refreshToken: tokens.refresh_token,
    accessToken:  tokens.access_token,
    email:        userInfo.data.email,
    displayName:  userInfo.data.name || null,
    scopes:       (tokens.scope || SCOPES.join(' '))
  };
}

// Build an authenticated Gmail client for a given mailbox row.
async function clientForMailbox(mailbox) {
  const oauth = makeOAuthClient();
  oauth.setCredentials({ refresh_token: decrypt(mailbox.refresh_token_encrypted) });
  return google.gmail({ version: 'v1', auth: oauth });
}

// ── Sync primitives ─────────────────────────────────────────────────

// Fetch the user's profile (used to record initial historyId).
async function getProfile(mailbox) {
  const gmail = await clientForMailbox(mailbox);
  const { data } = await gmail.users.getProfile({ userId: 'me' });
  return data; // { emailAddress, messagesTotal, threadsTotal, historyId }
}

// Pull a full message including headers, body parts, and attachment metadata.
async function getMessage(mailbox, messageId) {
  const gmail = await clientForMailbox(mailbox);
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });
  return data;
}

// Pull recent message IDs for initial backfill (limited). Kept for any
// callers wanting a quick recent-only fetch; the sync worker now uses
// listAllMessageIds for full-history backfill instead.
async function listRecentMessageIds(mailbox, maxResults = 50) {
  const gmail = await clientForMailbox(mailbox);
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: 'newer_than:30d'
  });
  return (data.messages || []).map(m => m.id);
}

// Pull a page of ALL message IDs in the mailbox, no time filter.
// Used by the sync worker during the `backfill` phase. Gmail returns
// messages newest-first by default; we paginate via pageToken.
//
// Returns: { messageIds: string[], nextPageToken: string|null,
//            resultSizeEstimate: number }
async function listAllMessageIds(mailbox, pageToken) {
  const gmail = await clientForMailbox(mailbox);
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 500, // Gmail's maximum per page
    pageToken: pageToken || undefined
  });
  return {
    messageIds: (data.messages || []).map(m => m.id),
    nextPageToken: data.nextPageToken || null,
    resultSizeEstimate: data.resultSizeEstimate || 0
  };
}

// Incremental sync via History API.
async function listHistorySince(mailbox, startHistoryId) {
  const gmail = await clientForMailbox(mailbox);
  const messageIds = new Set();
  let pageToken;
  do {
    const { data } = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      pageToken
    });
    for (const h of (data.history || [])) {
      for (const m of (h.messagesAdded || [])) {
        if (m.message && m.message.id) messageIds.add(m.message.id);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  const { data: profile } = await gmail.users.getProfile({ userId: 'me' });
  return { messageIds: Array.from(messageIds), latestHistoryId: profile.historyId };
}

// Fetch a single attachment's bytes.
async function getAttachmentData(mailbox, messageId, attachmentId) {
  const gmail = await clientForMailbox(mailbox);
  const { data } = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId
  });
  // data.data is base64url (Gmail's flavor) — convert to a Buffer.
  return Buffer.from(data.data, 'base64');
}

// Send a message. `raw` is an RFC2822 message as a base64url string.
async function sendRaw(mailbox, raw, threadId) {
  const gmail = await clientForMailbox(mailbox);
  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: threadId || undefined }
  });
  return data; // { id, threadId, labelIds }
}

module.exports = {
  SCOPES,
  buildConsentUrl,
  exchangeCodeForTokens,
  encryptRefreshToken: encrypt,
  getProfile,
  getMessage,
  listRecentMessageIds,
  listAllMessageIds,
  listHistorySince,
  getAttachmentData,
  sendRaw
};
