# Resend Email Setup (for invites)

This is a one-time setup so PropSpot can send real invitation emails. After this,
the "+ Invite" and "↻ Resend" buttons on the Team page actually deliver email.

**Total time:** ~15 minutes (plus DNS propagation, which is usually under an hour).

## 1. Create a Resend account

1. Go to https://resend.com and sign up with `jordan.shutts@restorationhomes.com`.
2. Verify your email.

## 2. Add propspot.io as a sending domain

1. In the Resend dashboard, click **Domains** → **Add Domain**.
2. Enter: `propspot.io`
3. Region: pick the one closest to Railway's region (US East is the default).
4. Resend shows you a table with 3 DNS records to add. They look like:

| Type | Host | Value | Priority |
|---|---|---|---|
| MX  | send | feedback-smtp.us-east-1.amazonses.com | 10 |
| TXT | send | v=spf1 include:amazonses.com ~all | – |
| TXT | resend._domainkey | p=MIGfMA0GCSq... (long string) | – |

**Leave this page open** — you'll come back to verify after step 3.

## 3. Add the DNS records at your domain registrar

Wherever propspot.io's DNS lives (Cloudflare, Namecheap, GoDaddy, etc.):

1. Log into the DNS provider.
2. Add each of the 3 records exactly as shown in Resend, including the priority for MX.
3. Save.

If you don't know where DNS lives, run this in a terminal to find out:
```bash
dig NS propspot.io +short
```
The result tells you which provider hosts the DNS.

## 4. Verify the domain in Resend

1. Back in the Resend dashboard, click **Verify DNS Records**.
2. If it fails immediately, wait 10-30 minutes and try again — DNS propagation takes time.
3. Once all 3 records show green checks, the domain is verified.

## 5. Create an SMTP API key

1. In Resend, click **API Keys** → **Create API Key**.
2. Name it `propspot-os-railway`.
3. Permission: **Sending access**.
4. Domain: `propspot.io`.
5. Click **Add** and **copy the key immediately** — it starts with `re_` and you can't see it again.

## 6. Set the env vars on Railway

1. Go to railway.app → your project → `propspot-os` service → **Variables** tab.
2. Add (or update) these 5 variables:

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `resend` |
| `SMTP_PASS` | `re_xxxxxxxxxxxxxxxxxxxxxxxxxxxx` (the API key from step 5) |
| `FROM_EMAIL` | `Prop Spot <invites@propspot.io>` |

3. Click **Deploy** (Railway redeploys automatically when env vars change).

## 7. Test

1. Open https://os.propspot.io/team.html.
2. Click **+ Invite**, enter your personal Gmail, leave apps unchecked, send.
3. Check your Gmail (and the spam folder if it's not there in 30 seconds).
4. The email should be from `Prop Spot <invites@propspot.io>` with a green "Accept Invite" button.
5. Once that works, click **↻ Resend all pending** on the Team page to deliver invites to the 8 stuck users.

## Troubleshooting

- **Domain won't verify:** DNS hasn't propagated yet. Wait 30 min and retry. If it still fails after an hour, double-check you copied the values exactly (especially the long DKIM string — no line breaks).
- **Email lands in spam:** Normal for the first few sends from a new domain. After ~10 successful deliveries that aren't marked spam, reputation builds and inbox placement improves.
- **Railway service crashes after env var change:** It shouldn't, but if it does, the logs will show the error. Most likely cause: a typo in `SMTP_PORT` (must be a number).
- **"No email configured" still shows in the invite modal:** The service didn't redeploy. Click "Deploy Latest" in Railway, or push any small change to main.
