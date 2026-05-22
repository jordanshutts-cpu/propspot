# FieldCam

Field photo capture for the **Prop Spot** OS.

FieldCam is a satellite app — not a standalone service. Sign-in, user
management, properties, and contacts all live in Prop Spot. FieldCam's
job is the camera/photo flow: capture, GPS tag, upload to Cloudinary,
write a row into Prop Spot's `photos` table.

## How it connects

```
                       Prop Spot Postgres
                              ▲
            ┌─────────────────┴────────────────┐
            │                                  │
   ┌────────┴────────┐                ┌────────┴────────┐
   │  Prop Spot      │                │  FieldCam       │
   │  (the OS)       │                │  (this service) │
   │                 │                │                 │
   │  os.propspot.io │                │  fieldcam.…     │
   └─────────────────┘                └─────────────────┘
            ▲                                  ▲
            └─── same JWT_SECRET ──────────────┘
```

- `DATABASE_URL` points at Prop Spot's Postgres.
- `JWT_SECRET` is byte-identical to Prop Spot's so any token issued at
  the OS works here.
- Users sign in at Prop Spot, click the FieldCam tile, get deep-linked
  here with `?token=…`; `public/app.js` consumes the token.
- Anything FieldCam needs to know about a user (full_name, email,
  grants) it asks Prop Spot via `/api/me` (proxied to `/api/os/me`).

## What lives here

```
server.js              Express entry — mounts /api/properties, /api/photos,
                       /api/health, /api/config, and the /api/me proxy.
middleware/auth.js     16 lines: verify JWT, set req.userId.
db/index.js            Postgres pool + query() wrapper. No schema runner —
                       Prop Spot owns the DDL.
lib/address.js         Copy of Prop Spot's address normalizer.
routes/properties.js   Reads/writes Prop Spot's properties table. Exposes
                       FieldCam-shaped `name` and `address` aliases so the
                       UI HTML stays unchanged.
routes/photos.js       Cloudinary upload + Prop Spot photos table.
public/                Camera, dashboard, property gallery, add-property,
                       import. The `/index.html` page just bounces to
                       Prop Spot for sign-in.
```

## Local development

```bash
npm install
cp .env.example .env
# Fill in: DATABASE_URL (Prop Spot's), JWT_SECRET, Cloudinary keys,
# OS_URL (Prop Spot's public URL)

npm run dev    # nodemon
```

You'll need Prop Spot running too (or at least reachable at `OS_URL`)
for `/api/me` and the sign-in redirect.

## Deploy

Push to GitHub → Railway redeploys. Required env vars on the FieldCam
Railway service:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Reference Prop Spot's Postgres: `${{Postgres.DATABASE_URL}}` from the Prop Spot project |
| `JWT_SECRET` | Identical to Prop Spot's |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Photo storage |
| `OS_URL` | Public URL of Prop Spot |
| `OS_INTERNAL_URL` | Railway-internal Prop Spot hostname (optional, faster) |
| `APP_URL` | This service's public URL |
| `GOOGLE_MAPS_API_KEY` | Frontend map rendering |

## Tips for field use

- Bookmark this URL on your phone's home screen.
- The camera page auto-highlights the nearest property (within 300m).
- Photos store the exact GPS coordinates of where they were taken.
- Workers can add notes to each photo ("north wall framing done").
