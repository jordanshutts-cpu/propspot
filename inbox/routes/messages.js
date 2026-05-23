const express = require('express');
const { query } = require('../db');
const { requireAuth, requireInboxGrant } = require('../middleware/auth');
const { scopedInboxIds } = require('../lib/scope');
const gmail = require('../lib/gmail');
const { buildRawMessage, headerLookup } = require('../lib/threading');
const { persistMessage } = require('../lib/persist');

const router = express.Router();
router.use(requireAuth);
router.use(requireInboxGrant);

async function loadThreadForReply(req, threadId) {
  const allowed = await scopedInboxIds(req.inboxGrant.scope);
  const { rows } = await query(`
    SELECT t.*, m.email AS mailbox_email, m.id AS mailbox_id,
           (SELECT raw_headers FROM inbox_messages
             WHERE thread_id = t.id ORDER BY received_at DESC LIMIT 1) AS last_headers,
           (SELECT delivered_to_alias FROM inbox_messages
             WHERE thread_id = t.id AND delivered_to_alias IS NOT NULL
             ORDER BY received_at DESC LIMIT 1) AS reply_from_alias,
           (SELECT provider_message_id FROM inbox_messages
             WHERE thread_id = t.id ORDER BY received_at DESC LIMIT 1) AS last_provider_msg
      FROM inbox_threads t
      JOIN inbox_mailboxes m ON m.id = t.mailbox_id
     WHERE t.id = $1
  `, [threadId]);
  if (!rows[0]) return { error: 'Thread not found', status: 404 };
  if (allowed !== null && !allowed.includes(rows[0].shared_inbox_id)) {
    return { error: 'No access to this thread', status: 403 };
  }
  return { thread: rows[0] };
}

// POST /api/messages/threads/:id/reply
//   body: { to?, cc?, body_text, body_html?, from_alias? }
router.post('/threads/:id/reply', async (req, res) => {
  const access = await loadThreadForReply(req, req.params.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const thread = access.thread;

  const lastHeaders = thread.last_headers || {};
  const replyTo = req.body.to ||
    headerLookup(Object.entries(lastHeaders).map(([k,v]) => ({ name:k, value:v })), 'Reply-To') ||
    headerLookup(Object.entries(lastHeaders).map(([k,v]) => ({ name:k, value:v })), 'From');
  if (!replyTo) return res.status(400).json({ error: 'No recipient (to) provided and no Reply-To/From on the original' });
  if (!req.body.body_text && !req.body.body_html) {
    return res.status(400).json({ error: 'body_text or body_html required' });
  }

  const fromAlias = req.body.from_alias || thread.reply_from_alias || thread.mailbox_email;
  const subject = thread.subject?.startsWith('Re:') ? thread.subject : `Re: ${thread.subject || ''}`;
  const messageIdHeader = lastHeaders['Message-Id'] || lastHeaders['Message-ID'] || null;
  const referencesHeader = lastHeaders['References']
    ? `${lastHeaders['References']} ${messageIdHeader || ''}`.trim()
    : messageIdHeader || null;

  // Load signature when caller didn't opt out.
  const includeSig = req.body.include_signature !== false;

  try {
    let signatureHtml = null;
    if (includeSig && thread.shared_inbox_id) {
      const { rows: sigRows } = await query(
        `SELECT signature_html FROM inbox_shared WHERE id = $1`,
        [thread.shared_inbox_id]
      );
      signatureHtml = sigRows[0]?.signature_html || null;
    }

    const raw = buildRawMessage({
      from: fromAlias,
      to: replyTo,
      cc: req.body.cc,
      subject,
      bodyText: req.body.body_text,
      bodyHtml: req.body.body_html,
      inReplyTo: messageIdHeader,
      references: referencesHeader,
      signatureHtml,
      attachments: req.body.attachments
    });

    const mailbox = await query(`SELECT * FROM inbox_mailboxes WHERE id = $1`, [thread.mailbox_id]);
    const sent = await gmail.sendRaw(mailbox.rows[0], raw, thread.provider_thread_id);
    // Pull the sent message back so it lands in the thread with proper threading.
    const full = await gmail.getMessage(mailbox.rows[0], sent.id);
    const { parseGmailMessage } = require('../lib/threading');
    const parsed = parseGmailMessage(full, mailbox.rows[0].email);
    parsed.is_outbound = true;
    const persisted = await persistMessage(mailbox.rows[0], parsed);
    if (persisted.messageId) {
      await query(
        `UPDATE inbox_messages SET sent_by_user_id = $1 WHERE id = $2`,
        [req.userId, persisted.messageId]
      );
    }
    res.json({ success: true, sent_id: sent.id });
  } catch (err) {
    console.error('Reply failed:', err);
    res.status(500).json({ error: 'Failed to send reply: ' + err.message });
  }
});

// POST /api/messages/compose
//   body: { mailbox_id, from_alias, to, cc?, subject, body_text, body_html? }
//   Creates a brand-new thread.
router.post('/compose', async (req, res) => {
  const { mailbox_id, from_alias, to, cc, subject, body_text, body_html } = req.body;
  if (!mailbox_id || !from_alias || !to || !subject) {
    return res.status(400).json({ error: 'mailbox_id, from_alias, to, subject required' });
  }
  // Owner-or-mailbox-routed-to-an-allowed-shared-inbox check.
  // Simplest model: require alias to be already routed to one of the caller's allowed inboxes.
  const allowed = await scopedInboxIds(req.inboxGrant.scope);
  const { rows: routeRows } = await query(
    `SELECT shared_inbox_id FROM inbox_alias_routes
      WHERE mailbox_id = $1 AND LOWER(alias_email) = LOWER($2)`,
    [mailbox_id, from_alias]
  );
  const sharedInboxId = routeRows[0]?.shared_inbox_id;
  if (!sharedInboxId) return res.status(400).json({ error: 'from_alias is not routed to a shared inbox' });
  if (allowed !== null && !allowed.includes(sharedInboxId)) {
    return res.status(403).json({ error: 'No access to that shared inbox' });
  }

  const includeSig = req.body.include_signature !== false;

  try {
    let signatureHtml = null;
    if (includeSig) {
      const { rows: sigRows } = await query(
        `SELECT signature_html FROM inbox_shared WHERE id = $1`,
        [sharedInboxId]
      );
      signatureHtml = sigRows[0]?.signature_html || null;
    }

    const raw = buildRawMessage({
      from: from_alias,
      to,
      cc,
      subject,
      bodyText: body_text,
      bodyHtml: body_html,
      signatureHtml,
      attachments: req.body.attachments
    });

    const { rows: mboxRows } = await query(`SELECT * FROM inbox_mailboxes WHERE id = $1`, [mailbox_id]);
    const mailbox = mboxRows[0];
    if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });
    const sent = await gmail.sendRaw(mailbox, raw, null);
    const full = await gmail.getMessage(mailbox, sent.id);
    const { parseGmailMessage } = require('../lib/threading');
    const parsed = parseGmailMessage(full, mailbox.email);
    parsed.is_outbound = true;
    parsed.delivered_to_alias = from_alias; // outbound — use the From as the alias signal
    const persisted = await persistMessage(mailbox, parsed);
    if (persisted.threadId) {
      await query(
        `UPDATE inbox_threads SET shared_inbox_id = $1 WHERE id = $2`,
        [sharedInboxId, persisted.threadId]
      );
    }
    if (persisted.messageId) {
      await query(
        `UPDATE inbox_messages SET sent_by_user_id = $1 WHERE id = $2`,
        [req.userId, persisted.messageId]
      );
    }
    res.status(201).json({ success: true, sent_id: sent.id, thread_id: persisted.threadId });
  } catch (err) {
    console.error('Compose failed:', err);
    res.status(500).json({ error: 'Failed to send message: ' + err.message });
  }
});

module.exports = router;
