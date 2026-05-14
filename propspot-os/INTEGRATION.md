# Integration Guide for Satellite Apps

How to connect a satellite app (FieldCam today, future apps tomorrow)
to Prop Spot.

---

## Two integration models

### A. Shared database (FieldCam, current)

The satellite's Express service reads/writes Prop Spot's Postgres
directly. Tight coupling on schema, lowest latency, simplest auth.

- Same `DATABASE_URL` as Prop Spot.
- Same `JWT_SECRET`.
- Auth middleware is the same 16 lines as Prop Spot: verify JWT,
  set `req.userId`. No shadow sync.

### B. API only (recommended for future apps)

The satellite has no DB credentials. Every read/write hits an HTTPS
endpoint on Prop Spot. Cleaner blast radius, slower, more work.

- Different `DATABASE_URL` (or none at all).
- Same `JWT_SECRET` (still verifies tokens locally).
- All data calls go to `${OS_URL}/api/os/...`.

Pick A when the satellite is high-traffic and tight-coupled (photos,
activity logs). Pick B for new business domains that should evolve
independently.

---

## Step 1 — Share `JWT_SECRET`

Set the **same** `JWT_SECRET` on every connected service. The OS signs
tokens with it; satellites verify with it. v1 keeps this simple.
We'll move to JWKS / public-key verification in v2.

---

## Step 2 — Register the app in the OS

The seed inserts `fieldcam` (and any other planned apps) into the
`apps` table. To set the public URL so the OS dashboard can deep-link:

```sql
UPDATE apps SET base_url = 'https://fieldcam.railway.app' WHERE slug = 'fieldcam';
```

---

## Step 3 — Add an OS-aware auth middleware

### Model A (shared DB)

```js
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'auth required' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId    = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
```

You can query Prop Spot's `app_grants` directly to gate access:

```sql
SELECT * FROM app_grants ag
  JOIN apps a ON a.id = ag.app_id
 WHERE ag.user_id = $1 AND a.slug = 'YOUR_APP_SLUG';
```

### Model B (API only)

```js
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'auth required' });

  const token = header.slice(7);
  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'invalid token' }); }

  const r = await fetch((process.env.OS_INTERNAL_URL || process.env.OS_URL) + '/api/os/me', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return res.status(401).json({ error: 'OS rejected token' });

  const { user, grants } = await r.json();
  req.user = user;
  req.grants = grants;
  req.appGrant = grants.find(g => g.slug === 'YOUR_APP_SLUG');
  if (!req.appGrant) return res.status(403).json({ error: 'no access to this app' });
  next();
}
```

---

## Step 4 — Per-record access checks

### Model A

Join `app_grants` and inspect the `scope` JSONB:

- `{"all": true}` — full access
- `{"project_ids": ["uuid", ...]}` — only listed projects

### Model B

```js
const r = await fetch(`${OS_URL}/api/os/authz?app=fieldcam&resource=project&id=${id}`, {
  headers: { Authorization: 'Bearer ' + token }
});
const { allow } = await r.json();
```

---

## Step 5 — Reference rows by Prop Spot UUID

Satellite tables (photos, offers, estimates) carry FKs that point at
Prop Spot's `properties.id`, `projects.id`, etc.

For Model A: declare the FK with `ON DELETE CASCADE / SET NULL` in
the shared schema.

For Model B: store the UUID, dereference via `GET /api/os/properties/:id`.

---

## Troubleshooting

- **401 on every request:** confirm `JWT_SECRET` is byte-identical.
- **403 "no access to this app":** the user has no grant for your slug.
- **`my-projects` returns empty for a contractor:** their grant has
  `scope.project_ids = []` because they aren't linked to any property
  as a contractor — fix via `property_contacts`.
