# Integration Guide for Satellite Apps

How to connect FieldCam, Underwriting, or any future app to Restoration OS.

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

Or do it from a future admin UI when we add one.

---

## Step 3 — Add an OS-aware auth middleware to your app

Replace your local auth check with one that:
1. Verifies the JWT against the shared secret.
2. Calls `GET {OS_URL}/api/os/me` with the bearer token to resolve identity
   and grants for *your* app.
3. Caches the result for the lifetime of the request.

Example for an Express app:

```js
const jwt = require('jsonwebtoken');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'auth required' });

  const token = header.slice(7);
  try {
    jwt.verify(token, process.env.JWT_SECRET);   // signature check
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }

  // Resolve identity + grants from the OS
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

For list views, ask the OS for the project IDs visible to this user:

```js
// inside a list route
const r = await fetch(OS_URL + '/api/os/my-projects?app=fieldcam', {
  headers: { Authorization: 'Bearer ' + token }
});
const { projects } = await r.json();
const projectIds = projects.map(p => p.project_id);

// Filter your app's records to those project_ids.
```

For per-record pages, ask explicitly:

```js
const r = await fetch(`${OS_URL}/api/os/authz?app=fieldcam&resource=project&id=${id}`, {
  headers: { Authorization: 'Bearer ' + token }
});
const { allow } = await r.json();
if (!allow) return res.status(403).json({ error: 'no access' });
```

---

## Step 5 — Reference properties / projects by OS UUID

Your app's primary records (photos, offers, estimates, etc.) should carry an
`os_property_id` column (and/or `os_project_id`). Don't model your own
property table — fetch the property via:

```
GET {OS_URL}/api/os/properties/:id
  → { id, address_line1, unit, city, state, zip, lat, lng }
```

Cache responses in your app for a few minutes if needed; properties don't
change often.

---

## Step 6 — Push events back to the OS (optional)

When something material happens in your app, write an activity entry the OS
can show on its dashboard:

```js
await fetch(OS_URL + '/api/activity', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({
    entity_type: 'project',
    entity_id:   osProjectId,
    action:      'photo_uploaded',
    payload:     { count: 3 }
  })
});
```

(This endpoint is read-only in v1 — let me know when you're ready to write
events and we'll add the POST.)

---

## Underwriting-specific contract (Adam)

Until your app moves to OS-managed properties, here's the bridge:

1. When a deal moves to "opportunity" in the OS, you'll be able to call:
   ```
   GET {OS_URL}/api/opportunities?property_id=<uuid>
   ```
   and get the opportunity record (asking_price, our_offer, status).

2. Your underwriting model writes back to the opportunity:
   ```
   PATCH {OS_URL}/api/opportunities/<id>
     { our_offer: 145000, notes: "ARV 220k, rehab 50k, MAO 145k" }
   ```

3. When the opportunity is "promoted" to purchase, the OS fires an activity
   event. You can poll `/api/activity?entity_type=opportunity&entity_id=<id>`
   for the `promoted` action and pick up `payload.purchase_id` to keep your
   underwriting record linked to the purchase.

We can refine this once you've ported the app to use OS auth — the cleanest
final shape is: your app writes offer state directly into a new
`underwriting_offers` table in the OS DB and the opportunity row references
the latest offer.

---

## Troubleshooting

- **401 on every request:** confirm `JWT_SECRET` is byte-identical on both
  services (no trailing newline, no quotes).
- **403 "no access to this app":** the user has no grant for your app's slug.
  Owner can grant via the OS team page (when wired up) or via SQL:
  `INSERT INTO app_grants (user_id, app_id, role, scope) VALUES (...)`.
- **`my-projects` returns empty for a contractor:** their grant has
  `scope.project_ids = []` because they aren't linked to any property as a
  contractor. Link them on the OS property page.
