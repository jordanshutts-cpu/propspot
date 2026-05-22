# Prop Spot

A property-operations platform for real-estate teams. This is a Node.js
monorepo — one Postgres database, one JWT secret, one team of users, and
several satellite apps that each own a piece of the workflow.

## Apps in this repo

| Folder | Service | URL | What it does |
|---|---|---|---|
| `propspot-os/` | `propspot` | os.propspot.io | The hub: auth, users, properties, contacts, pipeline (prospects → leads → opportunities → purchases → projects), app registry, per-user app grants. The other apps verify the JWT it mints and read/write its shared Postgres. |
| `fieldcam/` | `fieldcam` | fieldcam.propspot.io | Field photo capture with GPS, folder organization, sharing, comments. |
| `maintenance/` | `maintenance` | maintenance.propspot.io | Work-order tracking and lawn-maintenance routing per property. |
| `pulse/` | `pulse` | pulse.propspot.io | Team chat — channels, DMs, mentions (in progress). |
| `holdings/` | `holdings` | holdings.propspot.io | Per-property obligations: utilities, insurance, taxes, mortgages, licenses, HOA. |

Future: `inbox/` — shared team email (Phase 1 of that app is on the
`claude/add-inbox-app` branch).

## How they connect

Each satellite app is its own Railway service deployed from this same
GitHub repo with a different "Root Directory" setting (so Railway only
builds and watches the relevant subfolder). All services share:

- The same `JWT_SECRET` (referenced via Railway's `${{propspot-os.JWT_SECRET}}` syntax)
- The same Postgres database (referenced via `${{Postgres.DATABASE_URL}}`)
- The propspot-os `/api/os/me` endpoint to resolve a user's identity and
  per-app grants on every request

```
                                propspot-os (os.propspot.io)
                                       │
                ┌──────────────────────┼──────────────────────┐
                ▼                      ▼                      ▼
            fieldcam              maintenance              holdings           pulse
                       \           |                  /                /
                        \          |                 /                /
                         ▼         ▼                ▼                ▼
                                   Shared Postgres
```

## Local dev

Each app folder has its own `package.json`, `.env.example`, and
`server.js`. To run one locally:

```
cd <app-folder>           # e.g. cd fieldcam, cd maintenance, etc.
cp .env.example .env
# Fill in DATABASE_URL and JWT_SECRET (copy from Railway), then:
npm install
npm run dev
```

## Deploy

GitHub-push to `main` triggers Railway auto-deploy for any service whose
Root Directory was touched in the push. Schema changes go in
`propspot-os/db/schema.sql` and run on every propspot-os boot (idempotent
— `CREATE TABLE IF NOT EXISTS`).

## Conventions

- **Frontend** — vanilla HTML + CSS + JS, no framework. Each app has its
  own `public/` folder; `app.js` includes the shared left-nav code that
  renders all five satellite tiles (hidden per-user via `app_grants`).
- **Backend** — Express. Routes under `routes/`. Middleware under
  `middleware/`. Auth verifies the propspot-os JWT and looks up the user's
  app grant.
- **Database** — all tables owned by propspot-os. Satellites read/write
  but don't define schema.
- **Branches** — feature work goes on `claude/<feature-name>` branches.
  PR'd into the active integration branch
  (`acquisitions-rename-under-contract` at time of writing) and merged
  into `main` on a deploy.
