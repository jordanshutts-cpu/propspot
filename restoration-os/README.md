# Prop Spot

Central operating system for **Restoration Homes**.

Owns: identity & SSO, properties (canonical), contacts, the deal pipeline
(prospects → leads → opportunities → purchases → projects), and the apps
registry that grants per-user, per-app, per-record access.

Satellite apps (FieldCam, Underwriting, future apps) authenticate against the
OS and reference properties / projects by the canonical OS UUID.

---

## Setup

See `INTEGRATION.md` for connecting satellite apps. For the OS itself:

1. Provision Postgres on Railway, set `DATABASE_URL`, `JWT_SECRET`,
   `BOOTSTRAP_OWNER_EMAIL`, `APP_URL`, optional SMTP vars.
2. Deploy this folder as a Railway service.
3. Generate domain (we use `os.propspot.io`).
4. Sign up with the bootstrap email → you become owner.

## Brand

- Name: **Prop Spot**
- Domain: propspot.io
- Color: #61B746 (emerald)
- Logo: dog-pin (`public/logo.png`)
