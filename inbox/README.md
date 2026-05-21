# Inbox — Propspot's shared team email app

Satellite app at `inbox.propspot.io`. Brings email into propspot:

- **Shared inboxes** — team-owned inboxes that route incoming aliases (e.g. `deals@…`, `seller-leads@…`) to the right place
- **Company-level mailbox connection** — admin signs in once per Google Workspace mailbox; aliases are auto-discovered and mapped to shared inboxes inside Inbox
- **Property tagging** — link any email thread to a property; surfaces under that property's Email tab in propspot-os
- **Save attachments to a property** — pipes the file through Cloudinary into the property's photo storage, with rename
- **Per-shared-inbox access control** — extends `app_grants.scope` with `inbox_ids`

## How it runs

- Express server on port 3000 (Railway picks the port from `PORT`)
- Postgres shared with propspot-os via `DATABASE_URL`
- JWT auth verifies tokens minted by propspot-os (shared `JWT_SECRET`)
- Background worker (`workers/sync.js`) polls each connected Gmail mailbox using the Gmail History API every `INBOX_SYNC_INTERVAL_SECONDS`

## Env vars

See `.env.example`. The non-obvious ones:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — one OAuth client for the whole platform. Configure at https://console.cloud.google.com/apis/credentials.
- `GOOGLE_OAUTH_REDIRECT` — must match the redirect URI on the OAuth client. Default: `https://inbox.propspot.io/api/mailboxes/oauth/callback`.
- `INBOX_TOKEN_KEY` — base64 32-byte key for AES-GCM encryption of stored refresh tokens. Generate with `openssl rand -base64 32`. **Losing this key invalidates every connected mailbox** — they'll need to be reconnected.
- `INBOX_SYNC_DISABLED=1` — disables the background sync worker (useful when running locally without API access).

## Local dev

```
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_*, INBOX_TOKEN_KEY
npm install
npm run dev
```

Visit `http://localhost:3000/api/health` — should return `{"status":"ok","service":"inbox", …}`.

## Deploy

See the deployment guide at `Claude/SETUP-INBOX.md` for the full Railway / DNS / Google Cloud walkthrough.
