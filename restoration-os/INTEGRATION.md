# Integration Guide for Satellite Apps

How to connect FieldCam, Underwriting, or any future app to Prop Spot.

---

## What "connected" means

1. **Single sign-on** — users log in once at the OS and the same JWT works in
   every connected app.
2. **Shared identity** — apps don't run their own user table; they ask the OS
   "who is this token?".
3. **Per-record access** — apps ask the OS "can this user see project X?"
   before showing protected data.

---

## Step 1 — Share `JWT_SECRET`

Set the **same** `JWT_SECRET` on every connected service (OS, FieldCam,
Underwriting, …). The OS signs tokens with it; satellite apps verify with it.
v1 keeps this simple. We'll move to JWKS / public-key verification in v2.

```bash
# On each Railway service:
JWT_SECRET=<the same long random string everywhere>
```

---

## Step 2 — Register the app in the OS

The seed inserts `fieldcam` and `underwriting` rows in `apps`. To set their
public URLs (so the OS dashboard can deep-link into them):

```sql
UPDATE apps SET base_url = 'https://underwriting-production.up.railway.app'
 WHERE slug = 'underwriting';
```

---

## Step 3 — Add an OS-aware auth middleware to your app

```js
const jwt = require('jsonwebtoken');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'auth required' });

  const token = header.slice(7);
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }

  const r = await fetch((process.env.OS_INTERNAL_URL || process.env.OS_URL) + '/api/os/me', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return res.status(401).json({ error: 'OS rejected token' });

  const { user, grants } = await r.json();
  req.user   = user;
  req.grants = grants;
  req.appGrant = grants.find(g => g.slug === 'YOUR_APP_SLUG');
  if (!req.appGrant) return res.status(403).json({ error: 'no access to this app' });
  next();
}
```

---

## Step 4 — Per-record access checks

For list views:

```js
const r = await fetch(OS_URL + '/api/os/my-projects?app=fieldcam', {
  headers: { Authorization: 'Bearer ' + token }
});
const { projects } = await r.json();
```

For per-record pages:

```js
const r = await fetch(`${OS_URL}/api/os/authz?app=fieldcam&resource=project&id=${id}`, {
  headers: { Authorization: 'Bearer ' + token }
});
const { allow } = await r.json();
if (!allow) return res.status(403).json({ error: 'no access' });
```

---

## Step 5 — Reference properties / projects by OS UUID

Your app's records (photos, offers, estimates) carry `os_property_id` /
`os_project_id`. Fetch property details via:

```
GET {OS_URL}/api/os/properties/:id
```

---

## Troubleshooting

- **401 on every request:** confirm `JWT_SECRET` is byte-identical on both
  services.
- **403 "no access to this app":** the user has no grant for your app's slug.
- **`my-projects` returns empty for a contractor:** their grant has
  `scope.project_ids = []` because they aren't linked to any property as a
  contractor.
