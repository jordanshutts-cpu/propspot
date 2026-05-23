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
//
// Hard rule: only trust the `Delivered-To` / `X-Original-To` SMTP headers.
// Those are set by Gmail's MTA to the actual address mail was accepted for
// — covers same-domain aliases (e.g. insurance@restorationhomes.com on the
// operations@ mailbox) AND cross-domain forwarded aliases (e.g.
// hoa@sellrh.com → operations@restorationhomes.com).
//
// Do NOT fall back to scanning To: / Cc: — that path produces false
// positives in two cases:
//   (a) Outbound messages: Jordan's recipients get treated as aliases
//   (b) Reply-All inbound: external addresses in To: / Cc: get picked up
//
// Outbound messages have no delivered-to-alias by definition; their
// from_email is the sending alias.
function detectDeliveredAlias(headers, isOutbound) {
  if (isOutbound) return null;
  const deliveredTo = headerLookup(headers, 'Delivered-To');
  if (deliveredTo) return deliveredTo.toLowerCase().trim();
  const xOrig = headerLookup(headers, 'X-Original-To');
  if (xOrig) return xOrig.toLowerCase().trim();
  return null;
}

// Crude HTML → plain text. Strips tags, decodes a handful of entities,
// collapses whitespace. Good enough for the plain-text branch of a multipart
// email when all we have is the HTML signature. Don't reuse for arbitrary
// untrusted HTML — this isn't a sanitizer.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r?\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    delivered_to_alias: detectDeliveredAlias(headers, sentByMe),
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
function buildRawMessage({ from, to, cc, subject, bodyText, bodyHtml, inReplyTo, references, signatureHtml }) {
  const toList = Array.isArray(to) ? to.join(', ') : (to || '');
  const ccList = Array.isArray(cc) ? cc.join(', ') : (cc || '');
  const boundary = 'inbox-' + Math.random().toString(36).slice(2);

  const sig = (signatureHtml || '').trim();
  const escapedText = (bodyText || '').replace(/[<>&]/g, ch => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[ch]));
  const finalHtml = bodyHtml
    ? (sig ? `${bodyHtml}<br><br>--<br>${sig}` : bodyHtml)
    : (sig
        ? `<pre>${escapedText}</pre><br><br>--<br>${sig}`
        : `<pre>${escapedText}</pre>`);
  const finalText = sig
    ? `${bodyText || ''}\n\n-- \n${htmlToText(sig)}`
    : (bodyText || '');

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
    finalText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    finalHtml,
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
