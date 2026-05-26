const nodemailer = require('nodemailer');

const FROM = process.env.FROM_EMAIL || 'Prop Spot <noreply@propspot.io>';
const APP_URL = process.env.APP_URL || 'https://os.propspot.io';

function signerUrl(token) {
  return `${APP_URL}/inkd-sign.html?token=${token}`;
}

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER);
}

function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function brandedHtml({ headline, bodyHtml, buttonLabel, buttonHref, footer }) {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111827;">
      <h2 style="color:#61B746;margin-bottom:12px;">${escapeHtml(headline)}</h2>
      ${bodyHtml}
      ${buttonLabel ? `<p>
        <a href="${buttonHref}" style="display:inline-block;background:#61B746;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          ${escapeHtml(buttonLabel)}
        </a>
      </p>` : ''}
      ${footer ? `<p style="color:#6b7280;font-size:12px;">${footer}</p>` : ''}
    </div>`;
}

async function sendInvite({ to, recipientName, envelopeName, senderName, token }) {
  const url = signerUrl(token);
  if (!smtpConfigured()) {
    console.log(`[Ink'd] No SMTP configured — invite link for ${to}: ${url}`);
    return false;
  }
  await buildTransport().sendMail({
    from: FROM, to,
    subject: `${senderName} sent you "${envelopeName}" to sign`,
    text: `Hi ${recipientName},\n\n${senderName} has sent you a document to review and sign:\n\n${envelopeName}\n\nSign it here: ${url}\n\nThis link will expire in 30 days.`,
    html: brandedHtml({
      headline: `${senderName} sent you a document to sign`,
      bodyHtml: `<p>Hi ${escapeHtml(recipientName)},</p><p>${escapeHtml(senderName)} has sent you a document to review and sign: <strong>${escapeHtml(envelopeName)}</strong>.</p>`,
      buttonLabel: 'Review & sign',
      buttonHref: url,
      footer: 'This link will expire in 30 days.',
    }),
  });
  return true;
}

async function sendReminder({ to, recipientName, envelopeName, senderName, token, dayNumber }) {
  const url = signerUrl(token);
  if (!smtpConfigured()) {
    console.log(`[Ink'd] No SMTP configured — reminder link for ${to}: ${url}`);
    return false;
  }
  await buildTransport().sendMail({
    from: FROM, to,
    subject: `Reminder: please sign "${envelopeName}"`,
    text: `Hi ${recipientName},\n\nFriendly reminder that ${senderName} is waiting on your signature for:\n\n${envelopeName}\n\nSign here: ${url}`,
    html: brandedHtml({
      headline: `Reminder: please sign "${envelopeName}"`,
      bodyHtml: `<p>Hi ${escapeHtml(recipientName)},</p><p>This is a friendly reminder that ${escapeHtml(senderName)} is waiting on your signature for <strong>${escapeHtml(envelopeName)}</strong>.</p>`,
      buttonLabel: 'Review & sign',
      buttonHref: url,
      footer: dayNumber ? `Day ${dayNumber} reminder.` : '',
    }),
  });
  return true;
}

async function sendYourTurn({ to, recipientName, envelopeName, senderName, token }) {
  return sendInvite({ to, recipientName, envelopeName, senderName, token });
}

async function sendCompletedToSender({ to, senderName, envelopeName }) {
  if (!smtpConfigured()) {
    console.log(`[Ink'd] No SMTP configured — completion notice for ${to}: ${envelopeName}`);
    return false;
  }
  await buildTransport().sendMail({
    from: FROM, to,
    subject: `"${envelopeName}" has been signed by all parties`,
    text: `Hi ${senderName},\n\nAll parties have signed "${envelopeName}". Open Ink'd to review and save the signed copy to Files.`,
    html: brandedHtml({
      headline: `"${envelopeName}" has been signed`,
      bodyHtml: `<p>Hi ${escapeHtml(senderName)},</p><p>All parties have signed <strong>${escapeHtml(envelopeName)}</strong>.</p><p>Open Ink'd to review and save the signed copy to the property's Files.</p>`,
      buttonLabel: 'Open Ink’d',
      buttonHref: `${APP_URL}/inkd.html`,
    }),
  });
  return true;
}

module.exports = { sendInvite, sendReminder, sendYourTurn, sendCompletedToSender };
