# Restoration OS

Central operating system for **Restoration Homes**.

Owns: identity & SSO, properties (canonical), contacts, the deal pipeline
(prospects → leads → opportunities → purchases → projects), and the apps
registry that grants per-user, per-app, per-record access.

Satellite apps (FieldCam, Underwriting, future apps) authenticate against the
OS and reference properties / projects by the canonical OS UUID.

---

## Architecture

```
                     Restoration OS
                ┌──────────────────────────┐
                │ identity + SSO + invites │
                │ properties + pipeline    │
                │ contacts + grants        │
                │ apps registry            │
                └────────────┬─────────────┘
                             │ JWT + REST
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
   ┌───▼──────┐        ┌─────▼───────┐       ┌─────▼─────┐
   │ FieldCam │        │ Underwriting│       │ Future    │
   │ (photos) │        │ (offers)    │       │ apps...   │
   └──────────┘        └─────────────┘       └───────────┘
```

**Stack:** Node 18+ / Express / Postgres / Railway / JWT.

**Visual:** mobile-first, FieldCam emerald (`#61B746`).

---

## Setup (Railway)

1. **Provision a service**
   - Railway → New Project → Add Postgres → Add Service from this directory.
   - Set `DATABASE_URL` (auto-injected) and `JWT_SECRET` (any 32+ char random
     string — **must be the same on every connected app**).
   - Set `BOOTSTRAP_OWNER_EMAIL` to your email — when you sign up with that
     address you become owner with full grants on every app.
   - Set `APP_URL` to the Railway public URL.
   - Set SMTP env vars if you want invites emailed; otherwise the OS returns
     the invite link in the API response and the UI shows it for manual share.
   - Generate a domain in Railway → Settings → Networking.

2. **Sign in**
   - Open the public URL → "Create Account" → use the bootstrap email.
   - You land on the dashboard with the pipeline overview, your apps grid,
     and the recent activity feed.

3. **Add the apps**
   - The seed already inserts `fieldcam` and `underwriting` rows in `apps`.
   - From `/apps.html` you can see them. To set their public URLs run:
     ```sql
     UPDATE apps SET base_url = 'https://fieldcam-...railway.app' WHERE slug = 'fieldcam';
     UPDATE apps SET base_url = 'https://underwriting-...railway.app' WHERE slug = 'underwriting';
     ```

---

## The Contact-to-User Invite Flow

1. Create a contact (Contacts → +). For example, a contractor named "Bob's
   Drywall" (type: `contractor`) or your CPA (type: `accountant`).
2. Link them to one or more properties from the property page using the
   "+ Link" button (role: `contractor`, `accountant`, etc.).
3. Open the contact and click **"✉️ Invite to create account"**.
4. In the modal, check the apps you want them to access, choose a role
   (`contractor`, `field_user`, `member`, `admin`), and choose the scope:
   - **all projects** — access everything in the app
   - **only linked projects** — auto-populated with the projects this contact
     is linked to. Adding/removing the contact from a property automatically
     updates their visible projects.
5. They receive an email (or you copy the link manually). They set a
   password, get a JWT, and land in the OS where they only see their apps
   and their scoped records.

---

## API Reference (selected)

```
POST /api/auth/signup                  — first user becomes owner
POST /api/auth/login                   — returns { token, user }
GET  /api/auth/me                      — { user, grants[] }
POST /api/auth/invite                  — free-form user invite
POST /api/auth/accept-invite           — { token, password, fullName }

GET  /api/properties                   — list with pipeline counts
GET  /api/properties/:id               — full detail (all pipeline + contacts)
POST /api/properties                   — 409 with `existing` if duplicate

POST /api/prospects     /:id/promote   → creates lead
POST /api/leads         /:id/promote   → creates opportunity
POST /api/opportunities /:id/promote   → creates purchase
POST /api/purchases     /:id/promote   → creates project (body: { kind })
POST /api/projects      /:id/status    → { status: 'sold'|'rented'|... }

GET  /api/contacts?type=contractor
POST /api/contacts/:id/invite          — { app_grants: [...] }

POST /api/property-contacts            — { property_id, contact_id, role }
DELETE /api/property-contacts          — same body

GET  /api/apps                         — registry
PUT  /api/apps/:id/grants/:userId      — owner-only
DELETE /api/apps/:id/grants/:userId

GET  /api/os/me                        — for satellite apps
GET  /api/os/authz?app=&resource=&id=  — { allow, role, reason }
GET  /api/os/my-projects?app=          — { projects: [...] }
GET  /api/os/properties/:id            — minimal property summary
```

---

## Connecting a Satellite App

See `INTEGRATION.md`.

---

## Local Development

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL (local Postgres) and JWT_SECRET
npm run dev
# → http://localhost:3000
```

---

## File Structure

```
restoration-os/
  server.js
  package.json
  railway.toml
  .env.example
  db/
    index.js          pool + initDb()
    schema.sql        all tables (idempotent)
    seed.sql          built-in apps registry
  middleware/
    auth.js           requireAuth + requireOwner
  lib/
    address.js        normalize() — for property dedup
    scope.js          keeps app_grants.scope.project_ids in sync
    email.js          nodemailer invite email
    jwt.js            signToken + safeUser
    activity.js       logActivity()
    crud.js           generic pipeline CRUD helper
  routes/
    auth.js           signup/login/me/invite/accept
    users.js          team list with grants
    apps.js           registry + grant management
    properties.js     CRUD + dedup
    prospects.js      + /:id/promote → lead
    leads.js          + /:id/promote → opportunity
    opportunities.js  + /:id/promote → purchase
    purchases.js      + /:id/promote → project (body: kind)
    projects.js       + /:id/status (renovating|listed_for_sale|...)
    contacts.js       + /:id/invite (with app_grants)
    property-contacts.js  link/unlink with role
    activity.js       read-only event feed
    authz.js          /me, /authz, /my-projects (used by satellite apps)
  public/
    index.html        login + signup
    accept-invite.html
    dashboard.html    pipeline counts + apps grid + activity
    properties.html
    add-property.html (with dedup detection)
    property.html     full detail + pipeline + contacts
    contacts.html     filterable list (incl. accountant)
    contact.html      detail + INVITE WITH APP GRANTS modal
    team.html         users with grants summary
    apps.html         registry
    style.css         copied verbatim from FieldCam
    app.js            api wrapper
    config.js
```
