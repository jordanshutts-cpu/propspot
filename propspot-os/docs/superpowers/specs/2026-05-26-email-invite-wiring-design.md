# Email Invite Wiring + Resend Capability

**Date:** 2026-05-26
**Status:** Approved
**Owner:** Jordan Shutts

## Problem

The PropSpot OS team page shows 8 users in "Invited" status who never received an
invitation email. The invite system is fully built (endpoint, template, accept page,
modal UI) but `lib/email.js` short-circuits to `return false` when SMTP env vars are
absent — and Railway has no SMTP configured. The user record is created (so the row
appears as "Invited"), but no email goes out. The modal does surface a manual
copy-paste fallback link, but it's easy to miss.

## Goals

1. Real invite emails go out when an owner clicks **+ Invite**.
2. The 8 currently-pending users can be re-invited without being deleted and
   re-added one at a time.
3. Zero changes to the existing email template, `lib/email.js`, `routes/auth.js`
   invite logic, accept-invite flow, or database schema.

## Non-goals

- Redesigning the email template.
- Replacing nodemailer with a provider-specific SDK.
- Adding email features beyond invites (digests, notifications, etc.).

## Solution

### 1. Email provider — Resend (via SMTP)

Resend's SMTP relay drops in behind the existing nodemailer transport with no code
changes. Free tier (100/day, 3000/month) is well above invite volume.

**One-time setup (operator, not code):**

1. Sign up at resend.com.
2. Add `propspot.io` as a sending domain → Resend returns 3 DNS records (SPF, DKIM, return-path).
3. Add the records at the propspot.io DNS provider.
4. Create an SMTP API key.
5. Set on Railway service `propspot-os`:
   - `SMTP_HOST=smtp.resend.com`
   - `SMTP_PORT=587`
   - `SMTP_USER=resend`
   - `SMTP_PASS=<api-key>`
   - `FROM_EMAIL=Prop Spot <invites@propspot.io>`
6. Redeploy.

### 2. Backend — two new endpoints

Both live in `routes/users.js`, owner-only, reusing the existing
`sendInviteEmail()` and invite-token machinery from `lib/email.js` and
`routes/auth.js`.

**`POST /api/users/:id/resend-invite`**

- Verify user is still pending (`password_hash IS NULL AND google_sub IS NULL`).
- Generate fresh `invite_token` (32-byte hex) and set `invite_expires` to NOW + 48h.
- Look up the inviter's `full_name` and the user's existing app_grants (to populate
  the `appsList` in the email).
- Call `sendInviteEmail({ to, inviteLink, inviterName, appsList })`.
- Log activity `invite_resent`.
- Return `{ ok: true, email_sent: boolean, invite_link?: string }`
  (link returned only when `email_sent === false`, mirroring the existing invite
  endpoint's fallback shape).

Error cases:
- 400 if the user already accepted (active).
- 404 if the user doesn't exist.

**`POST /api/users/resend-all-pending`**

- Select all users where `password_hash IS NULL AND google_sub IS NULL AND is_owner = FALSE`.
- For each, regenerate the token and call `sendInviteEmail()`.
- Return `{ attempted: N, sent: M, failed: [{ email, reason }] }`.
- Log one `invite_resent` activity entry per recipient.

### 3. Team UI — `public/team.html`

**Per-row Resend button** on Invited rows, adjacent to the existing Uninvite button.
Same `.btn .btn-secondary` style, label `↻ Resend`. Calls the new endpoint, toast on
success ("Invite resent to {email}"), toast on failure with the server's error.

**Bulk Resend button** in the header, next to **+ Invite**, only rendered when
`users.some(u => !u.is_active && !u.is_owner)` returns true. Label
`↻ Resend all pending (N)`. On click:

- Confirm dialog: "Resend invite emails to N pending team members?"
- Call `POST /api/users/resend-all-pending`.
- Toast: "Sent X of Y invites" or "Sent X of Y — failed: a@x.com, b@y.com".
- Reload the user list.

### 4. What stays untouched

- `lib/email.js` (SMTP code is already correct).
- `routes/auth.js` `POST /api/auth/invite` (already works once SMTP is set).
- `accept-invite.html` and `POST /api/auth/accept-invite`.
- Database schema — `invite_token` and `invite_expires` already exist on `users`.

## Verification

After deploy with Resend env vars set:

1. From the team page, invite a fresh test email. The invitee receives the email.
2. Click **Resend** on a pending row. The recipient receives a new email with a
   fresh 48h link. The old link 404s.
3. Click **Resend all pending**. Each of the 8 pending users receives an email.
   The toast reports `Sent 8 of 8`.
4. Accept-invite link from the email leads to `/accept-invite.html`, password
   creation works, the user is logged in.

## Risks & mitigations

- **Domain reputation cold start.** First sends from a new domain can land in spam.
  Mitigation: only 8 recipients in the initial bulk send, all expected internal
  recipients. After domain warmup deliverability stabilizes.
- **Resend free-tier limit (100/day).** Bulk resend of 8 + occasional invites is
  far under the limit. Not a concern at current scale.
- **Token regeneration invalidates previously-shared manual links.** Acceptable:
  the manual-link fallback was a workaround for the missing email, not a
  documented flow.
