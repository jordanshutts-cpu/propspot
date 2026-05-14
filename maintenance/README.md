# Maintenance

Satellite app on Prop Spot. Tracks work orders (repairs, turn-overs,
service calls) for each property, with status workflow (open → scheduled
→ in_progress → completed) and a comment thread per ticket.

## Architecture

- **Model A** (shared database) — points at Prop Spot's Postgres via
  `DATABASE_URL`. Owns the `work_orders` and `work_order_updates` tables.
- **Auth** — verifies the OS-issued JWT with the shared `JWT_SECRET`.
  Per-app access requires an `app_grants` row for `slug='maintenance'`.

## Setup

1. Provision a new Railway service from this folder.
2. Set env vars (see `.env.example`):
   - `DATABASE_URL` → `${{Postgres.DATABASE_URL}}` (Prop Spot's DB)
   - `JWT_SECRET`   → same value as Prop Spot
   - `OS_URL`       → `https://os.propspot.io`
   - `APP_URL`      → `https://maintenance.propspot.io`
3. Add custom domain `maintenance.propspot.io` in Railway → Settings →
   Networking → Custom Domain.
4. Visit it once signed in to Prop Spot.

## Schema

Tables created/maintained by Prop Spot's `propspot-os/db/schema.sql`:
- `work_orders`        — one row per ticket
- `work_order_updates` — comment thread

This app never runs DDL.
