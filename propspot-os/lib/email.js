const nodemailer = require('nodemailer');

async function sendInviteEmail({ to, inviteLink, inviterName, appsList }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log('No SMTP configured — invite link:', inviteLink);
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const apps = (appsList || []).map(a => `<li>${a}</li>`).join('') || '<li>Prop Spot</li>';

  await transporter.sendMail({
    from: process.env.FROM_EMAIL || 'Prop Spot <noreply@propspot.io>',
    to,
    subject: `${inviterName} invited you to Prop Spot`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111827;">
        <h2 style="color:#61B746;">You're invited to Prop Spot</h2>
        <p>${inviterName} has invited you to collaborate.</p>
        <p>You'll have access to:</p>
        <ul>${apps}</ul>
        <p>
          <a href="${inviteLink}"
             style="display:inline-block;background:#61B746;color:#fff;padding:12px 28px;
                    border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
            Accept Invite
          </a>
        </p>
        <p style="color:#6b7280;font-size:12px;">Link expires in 48 hours.</p>
      </div>`
  });
  return true;
}

async function sendPasswordResetEmail({ to, resetLink }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log('No SMTP configured — password reset link:', resetLink);
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: process.env.FROM_EMAIL || 'Prop Spot <noreply@propspot.io>',
    to,
    subject: 'Reset your Prop Spot password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111827;">
        <h2 style="color:#61B746;">Reset your password</h2>
        <p>Click the button below to choose a new password. This link expires in 1 hour.</p>
        <p>
          <a href="${resetLink}"
             style="display:inline-block;background:#61B746;color:#fff;padding:12px 28px;
                    border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
            Reset Password
          </a>
        </p>
        <p style="color:#6b7280;font-size:12px;">
          If you didn't request this, you can safely ignore this email — your password won't change.
        </p>
      </div>`
  });
  return true;
}

module.exports = { sendInviteEmail, sendPasswordResetEmail };
