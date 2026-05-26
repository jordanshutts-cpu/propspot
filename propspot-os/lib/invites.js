const crypto = require('crypto');
const { sendInviteEmail } = require('./email');

/**
 * Regenerate an invite token for an existing pending user and send the email.
 * Caller must already have verified the user is pending (no password_hash,
 * no google_sub) and is not an owner.
 *
 * @param {object} args
 * @param {object} args.client     pg client (transaction-bound) or pool
 * @param {string} args.userId     id of the user being (re)invited
 * @param {string} args.inviterUserId  id of the owner triggering the resend
 * @returns {Promise<{ emailSent: boolean, inviteLink: string, email: string }>}
 */
async function sendInviteToUser({ client, userId, inviterUserId }) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const { rows: userRows } = await client.query(
    `UPDATE users
        SET invite_token   = $1,
            invite_expires = $2
      WHERE id = $3
      RETURNING id, email, full_name`,
    [token, expires, userId]
  );
  if (!userRows[0]) throw new Error('User not found');
  const user = userRows[0];

  const { rows: inviterRows } = await client.query(
    'SELECT full_name FROM users WHERE id = $1',
    [inviterUserId]
  );
  const inviterName = inviterRows[0]?.full_name || 'Your teammate';

  const { rows: appRows } = await client.query(
    `SELECT a.name
       FROM app_grants ag
       JOIN apps a ON a.id = ag.app_id
      WHERE ag.user_id = $1
      ORDER BY a.name`,
    [userId]
  );
  const appsList = appRows.map(r => r.name);

  const appUrl     = process.env.APP_URL || 'http://localhost:3000';
  const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;

  const emailSent = await sendInviteEmail({
    to: user.email,
    inviteLink,
    inviterName,
    appsList
  });

  return { emailSent, inviteLink, email: user.email };
}

module.exports = { sendInviteToUser };
