# Pulse

Team messaging satellite for Prop Spot — channels, DMs, mentions, files. Model A
integration (shared `DATABASE_URL` + `JWT_SECRET`). Hosted at
`pulse.propspot.io` on Railway.

## What v1 includes

- Public + private channels (`#general` seeded by Prop Spot OS)
- 1:1 and group DMs *(Phase 3)*
- @mentions with browser notifications *(Phase 4)*
- File attachments via Cloudinary *(Phase 5)*
- Unread counts, presence, basic search *(Phases 4–6)*
- PWA — installable on iOS / Android home screen *(Phase 6)*

## Local dev

```bash
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET (must match propspot-os), OS_URL
npm install
npm run dev
```

Then in another tab make sure `propspot-os` is running too. From
`os.propspot.io/apps.html`, click the Pulse tile — it appends the JWT as a
query param to `pulse.propspot.io`, which consumes it via `app.js` and
redirects to `/chat.html`.

## Architecture

| Concern | Choice |
|---|---|
| Stack | Node 18 + Express, plain HTML/CSS/JS frontend (no framework) |
| Real-time | Server-Sent Events (`/api/pulse/stream`) with in-memory pub/sub (`lib/hub.js`) |
| Auth | JWT, signed by Prop Spot OS, verified locally with shared secret |
| EventSource auth | JWT passed as `?token=` query param (browser API can't set headers) |
| Schema | Owned by Prop Spot OS (`propspot-os/db/schema.sql`); Pulse only reads/writes |
| Compression | **Not enabled** — would buffer SSE events and break real-time delivery |

## Routes

- `GET  /api/pulse/channels`             — list channels the caller can see
- `POST /api/pulse/channels/:id/join`    — join a public channel
- `GET  /api/pulse/messages?channel_id=` — last 100 messages in a channel
- `POST /api/pulse/messages`             — send a message
- `GET  /api/pulse/stream?channel_id=&token=` — SSE event stream
- `GET  /api/auth/me`                    — pass-through to Prop Spot OS
- `GET  /api/health`                     — health check (Railway uses this)
- `GET  /api/config`                     — non-secret config for the frontend

## Env vars

| Var | Notes |
|---|---|
| `DATABASE_URL` | Same as propspot-os |
| `JWT_SECRET` | **Must** byte-match propspot-os |
| `OS_URL` | e.g. `https://os.propspot.io` |
| `OS_INTERNAL_URL` | Optional. Service-to-service URL on Railway if set |
| `APP_URL` | e.g. `https://pulse.propspot.io` (used for CORS allowed origin) |
| `HOLDINGS_URL`, `MAINTENANCE_URL`, `FIELDCAM_URL` | For cross-app links |
| `PORT` | Auto-set by Railway |
