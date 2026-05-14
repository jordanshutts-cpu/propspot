# Holdings Desk

Satellite app on Prop Spot. Tracks per-property recurring obligations:
utilities, insurance, taxes, mortgages, licenses, HOA. Records payments
and rolls the next-due date forward by cadence.

## Architecture

- **Model A** (shared database) — points at Prop Spot's Postgres via
  `DATABASE_URL`. Owns the `holdings` and `holding_payments` tables.
- **Auth** — verifies the OS-issued JWT with the shared `JWT_SECRET`.
  Per-app access requires an `app_grants` row for `slug='holdings'`
  (owners get this automatically).

## Setup

1. Provision a new Railway service from this folder.
2. Set env vars (see `.env.example`):
   - `DATABASE_URL` → `${{Postgres.DATABASE_URL}}` (Prop Spot's DB)
   - `JWT_SECRET`   → same value as Prop Spot
   - `OS_URL`       → `https://os.propspot.io`
   - `APP_URL`      → `https://holdings.propspot.io`
3. Add custom domain `holdings.propspot.io` in Railway → Settings →
   Networking → Custom Domain.
4. Visit it once signed in to Prop Spot — the dashboard tile (or the
   Apps page row) will deep-link with an SSO token.

## Schema

Tables created/maintained by Prop Spot's `restoration-os/db/schema.sql`:
- `holdings`           — one row per obligation
- `holding_payments`   — one row per recorded payment

This app never runs DDL. If you need a column, add it to
`restoration-os/db/schema.sql` and let Prop Spot's `initDb()` run it
on next boot.
