# Prop Spot

Central operating system for **Restoration Homes**.

Prop Spot owns the canonical database: identity & SSO, properties,
contacts, the deal pipeline (prospects → leads → opportunities →
purchases → projects), the apps registry, and the photos table. Every
satellite app (FieldCam today; underwriting, accounting, etc. later)
reads and writes that single Postgres.

Satellite apps authenticate against Prop Spot's JWT and reference rows
by the canonical OS UUID.

## Schema owners

Prop Spot is the only service that runs DDL. Satellite apps query the
shared tables but never `CREATE`/`ALTER` them. See
[`db/schema.sql`](db/schema.sql) for the full set.

| Table | Owner / writer |
|---|---|
| users, apps, app_grants | Prop Spot |
| properties (incl. `display_name`) | Prop Spot + FieldCam |
| contacts, property_contacts | Prop Spot |
| prospects, leads, opportunities, purchases, projects | Prop Spot |
| activity | Prop Spot (FieldCam can append) |
| **photos** | **FieldCam** (Prop Spot reads) |

## Setup

See [`INTEGRATION.md`](INTEGRATION.md) for satellite-app wiring. For
the OS itself:

1. Provision Postgres on Railway, set `DATABASE_URL`, `JWT_SECRET`,
   `BOOTSTRAP_OWNER_EMAIL`, `APP_URL`, Cloudinary creds, optional SMTP.
2. Deploy this folder (`restoration-os/`) as a Railway service.
3. Generate domain (we use `os.propspot.io`).
4. Sign up with the bootstrap email → you become owner.

## Migrating FieldCam data

Before pointing FieldCam at Prop Spot's DB, run the migration script
from the Prop Spot service to copy users / properties / photos:

```bash
FIELDCAM_DATABASE_URL=postgresql://...   # FieldCam's old Postgres
DATABASE_URL=postgresql://...            # Prop Spot's Postgres
npm run migrate-from-fieldcam -- --dry-run
# review output, then:
npm run migrate-from-fieldcam
```

The script is idempotent and detailed in
[`scripts/migrate-from-fieldcam.js`](scripts/migrate-from-fieldcam.js).

## Brand

- Name: **Prop Spot**
- Domain: propspot.io
- Color: `#61B746` (emerald)
- Logo: dog-pin ([`public/logo.png`](public/logo.png))
