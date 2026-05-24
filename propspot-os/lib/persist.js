// Persist a parsed Gmail message into our inbox_threads / inbox_messages /
// inbox_attachments tables. Idempotent — re-running for the same message id
// is a no-op (ON CONFLICT DO NOTHING on the message + attachment unique keys).

const { query: db } = require('../db');

async function persistMessage(mailbox, parsed) {
  // 1) Upsert the thread row, keyed on (mailbox_id, provider_thread_id).
  const { rows: threadRows } = await db(
    `INSERT INTO inbox_threads (mailbox_id, provider_thread_id, subject,
                                participants, last_message_at, message_count,
                                has_attachments, unread)
     VALUES ($1,$2,$3,$4,$5,1,$6,$7)
     ON CONFLICT (mailbox_id, provider_thread_id) DO UPDATE
       SET subject         = COALESCE(inbox_threads.subject, EXCLUDED.subject),
           participants    = (
             SELECT ARRAY(SELECT DISTINCT UNNEST(inbox_threads.participants || EXCLUDED.participants))
           ),
           last_message_at = GREATEST(inbox_threads.last_message_at, EXCLUDED.last_message_at),
           message_count   = inbox_threads.message_count + 1,
           has_attachments = inbox_threads.has_attachments OR EXCLUDED.has_attachments,
           unread          = inbox_threads.unread OR NOT $8
     RETURNING id, shared_inbox_id`,
    [
      mailbox.id,
      parsed.providerThreadId,
      parsed.subject || null,
      Array.from(new Set([
        parsed.from_email,
        ...(parsed.to_emails || []),
        ...(parsed.cc_emails || [])
      ].filter(Boolean))),
      parsed.received_at,
      parsed.attachments.length > 0,
      true, // start unread
      parsed.is_outbound // outbound messages don't mark unread
    ]
  );
  const thread = threadRows[0];

  // 2) Route into a shared inbox if we have an alias mapping (and the thread
  // isn't already routed).
  if (!thread.shared_inbox_id && parsed.delivered_to_alias) {
    const { rows: routeRows } = await db(
      `SELECT shared_inbox_id FROM inbox_alias_routes
        WHERE mailbox_id = $1 AND LOWER(alias_email) = LOWER($2)
        LIMIT 1`,
      [mailbox.id, parsed.delivered_to_alias]
    );
    if (routeRows[0]) {
      await db(
        `UPDATE inbox_threads SET shared_inbox_id = $1 WHERE id = $2`,
        [routeRows[0].shared_inbox_id, thread.id]
      );
    }
  }

  // 3) Insert the message row (idempotent on (thread_id, provider_message_id)).
  const { rows: msgRows } = await db(
    `INSERT INTO inbox_messages (thread_id, provider_message_id, from_email, from_name,
                                 to_emails, cc_emails, delivered_to_alias,
                                 subject, snippet, body_html, body_text,
                                 received_at, is_outbound, raw_headers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (thread_id, provider_message_id) DO NOTHING
     RETURNING id`,
    [
      thread.id, parsed.providerMessageId, parsed.from_email, parsed.from_name,
      parsed.to_emails, parsed.cc_emails, parsed.delivered_to_alias,
      parsed.subject, parsed.snippet, parsed.body_html, parsed.body_text,
      parsed.received_at, parsed.is_outbound, parsed.raw_headers
    ]
  );
  const messageId = msgRows[0]?.id;
  if (!messageId) {
    // Duplicate — message was already stored. Don't increment message_count.
    await db(
      `UPDATE inbox_threads SET message_count = message_count - 1 WHERE id = $1`,
      [thread.id]
    );
    return { threadId: thread.id, messageId: null, duplicated: true };
  }

  // 4) Attachments.
  for (const a of parsed.attachments) {
    await db(
      `INSERT INTO inbox_attachments (message_id, filename, mime_type, size_bytes, provider_attachment_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (message_id, provider_attachment_id) DO NOTHING`,
      [messageId, a.filename, a.mimeType, a.sizeBytes, a.providerAttachmentId]
    );
  }

  return { threadId: thread.id, messageId, duplicated: false };
}

module.exports = { persistMessage };
