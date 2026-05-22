// Parse a Gmail "full" message payload into the shape we store in inbox_messages.
// Also extracts attachment metadata and figures out which alias on the mailbox
// the message was delivered to.

function headerLookup(headers, name) {
  const lc = name.toLowerCase();
  const h = (headers || []).find(x => x.name && x.name.toLowerCase() === lc);
  return h ? h.value : null;
}

function parseAddressList(value) {
  if (!value) return [];
  // RFC822 address list. We use a loose splitter — Gmail returns reasonable
  // values and a perfect parser is overkill for storage.
  return value.split(',').map(s => {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).trim().toLowerCase();
  }).filter(Boolean);
}

function parseFrom(value) {
  if (!value) return { email: '', name: null };
  const m = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { email: m[2].toLowerCase(), name: m[1].replace(/^"|"$/g, '').trim() || null };
  return { email: value.trim().toLowerCase(), name: null };
}

function decodeBase64Url(s) {
  if (!s) return '';
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

// Walk the payload tree and collect: bodyText, bodyHtml, attachments.
function walkParts(payload, out) {
  if (!payload) return;
  const mime = (payload.mimeType || '').toLowerCase();
  const filename = payload.filename;
  const body = payload.body || {};

  if (filename && body.attachmentId) {
    out.attachments.push({
      filename,
      mimeType: payload.mimeType,
      sizeBytes: body.size || null,
      providerAttachmentId: body.attachmentId
    });
  } else if (mime === 'text/plain' && body.data) {
    out.bodyText = (out.bodyText || '') + decodeBase64Url(body.data);
  } else if (mime === 'text/html' && body.data) {
    out.bodyHtml = (out.bodyHtml || '') + decodeBase64Url(body.data);
  }

  for (const p of (payload.parts || [])) walkParts(p, out);
}

// Detect which alias on the mailbox received this message.
// Gmail puts the actual delivery address in "Delivered-To" (sometimes
// "X-Original-To"). Falls back to the first To: that matches the mailbox
// owner's domain.
function detectDeliveredAlias(headers, mailboxEmail) {
  const deliveredTo = headerLookup(headers, 'Delivered-To');
  if (deliveredTo) return deliveredTo.toLowerCase();
  const xOrig = headerLookup(headers, 'X-Original-To');
  if (xOrig) return xOrig.toLowerCase();

  const to = parseAddressList(headerLookup(headers, 'To'));
  const cc = parseAddressList(headerLookup(headers, 'Cc'));
  const all = [...to, ...cc];
  // If we know the mailbox's main email, return the first non-matching one
  // (likely the alias). Otherwise return the first To: address.
  if (mailboxEmail) {
    const owner = mailboxEmail.toLowerCase();
    const aliasGuess = all.find(a => a !== owner);
    if (aliasGuess) return aliasGuess;
  }
  return all[0] || null;
}

function parseGmailMessage(message, mailboxEmail) {
  const headers = message.payload?.headers || [];
  const from = parseFrom(headerLookup(headers, 'From'));
  const out = { attachments: [], bodyText: null, bodyHtml: null };
  walkParts(message.payload, out);

  const receivedMs = message.internalDate ? parseInt(message.internalDate, 10) : Date.now();
  const sentByMe = (message.labelIds || []).includes('SENT');

  return {
    providerMessageId: message.id,
    providerThreadId:  message.threadId,
    from_email:        from.email,
    from_name:         from.name,
    to_emails:         parseAddressList(headerLookup(headers, 'To')),
    cc_emails:         parseAddressList(headerLookup(headers, 'Cc')),
    delivered_to_alias: detectDeliveredAlias(headers, mailboxEmail),
    subject:           headerLookup(headers, 'Subject'),
    snippet:           message.snippet || null,
    body_html:         out.bodyHtml,
    body_text:         out.bodyText,
    received_at:       new Date(receivedMs).toISOString(),
    is_outbound:       sentByMe,
    raw_headers:       headers.reduce((acc, h) => { acc[h.name] = h.value; return acc; }, {}),
    attachments:       out.attachments
  };
}

// Build an RFC2822 message for sending. Returns a base64url string Gmail will accept.
function buildRawMessage({ from, to, cc, subject, bodyText, bodyHtml, inReplyTo, references }) {
  const toList = Array.isArray(to) ? to.join(', ') : (to || '');
  const ccList = Array.isArray(cc) ? cc.join(', ') : (cc || '');
  const boundary = 'inbox-' + Math.random().toString(36).slice(2);
  const lines = [
    `From: ${from}`,
    `To: ${toList}`,
    ccList ? `Cc: ${ccList}` : null,
    `Subject: ${subject || ''}`,
    inReplyTo  ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    bodyText || '',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    bodyHtml || `<pre>${(bodyText || '').replace(/[<>&]/g, ch => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[ch]))}</pre>`,
    '',
    `--${boundary}--`,
    ''
  ].filter(Boolean);
  const raw = lines.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

module.exports = {
  parseGmailMessage,
  buildRawMessage,
  parseFrom,
  parseAddressList,
  headerLookup
};
