# FieldCam → Prop Spot Cutover Runbook

This is the production cutover checklist for switching FieldCam from
its own Postgres to Prop Spot's shared Postgres.

The schema/route work has already shipped (commits `3b4a207`, `7be7bdc`,
`f1ad377` on `claude/real-estate-os-foundation-ARLFX`). What's left is
**data migration and the env-var flip on Railway**.

Plan a 1–2 hour window. Run off-hours; users hitting FieldCam during
the window will see read failures or 401s.

---

## Pre-flight (do these days before)

- [ ] Both services deployed at the current commit. Confirm
      `GET /api/health` on each.
- [ ] `JWT_SECRET` is byte-identical on Prop Spot and FieldCam.
- [ ] On Prop Spot's Railway service, set `FIELDCAM_DATABASE_URL` to
      FieldCam's old Postgres connection string (read-only credential
      preferred).
- [ ] Cloudinary creds set on Prop Spot too (`CLOUDINARY_*`).
- [ ] Take a baseline count from FieldCam's DB:
      ```sql
      SELECT
        (SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL) AS active_users,
        (SELECT COUNT(*) FROM properties) AS properties,
        (SELECT COUNT(*) FROM photos) AS photos;
      ```
      Save these numbers — you'll compare them after migration.
- [ ] Railway → Prop Spot Postgres → **Take a manual backup** and
      download the dump. Keep for 30 days.

---

## T-0: Migration

1. **Maintenance banner** — optional. If you have one, flip it on.

2. **Dry-run the migration script.** Run from your laptop OR by
   `railway run` on the Prop Spot service:
   ```bash
   FIELDCAM_DATABASE_URL=postgresql://... \
   DATABASE_URL=postgresql://...   \
   node scripts/migrate-from-fieldcam.js --dry-run
   ```
   Review the report:
   - `users.migrated + users.linked` should equal the baseline
     active_users (or come close — `linked` covers people who already
     existed in Prop Spot).
   - `properties.parse_failed` should be small. Open the printed
     errors and confirm none are critical addresses.
   - `photos.orphaned` should be 0 in a healthy run. Non-zero means
     some photos point at a FieldCam property that didn't migrate —
     they'll land in a "Migrated photos — needs review" bucket.

3. **Run for real:**
   ```bash
   FIELDCAM_DATABASE_URL=postgresql://... \
   DATABASE_URL=postgresql://...   \
   node scripts/migrate-from-fieldcam.js
   ```

4. **Verify counts in Prop Spot's DB:**
   ```sql
   SELECT
     (SELECT COUNT(*) FROM users)      AS users,
     (SELECT COUNT(*) FROM properties) AS properties,
     (SELECT COUNT(*) FROM photos)     AS photos;
   ```
   Properties + photos should be ≥ the baseline. Users will usually
   exceed because Prop Spot users are also counted.

5. **Spot-check a few records:**
   - Open `https://os.propspot.io/properties.html` — see all migrated
     properties listed, including any with placeholder
     `city='UNKNOWN' state='XX' zip='00000'`. Edit those by hand.
   - Open one property detail — confirm the Photos section renders
     with thumbnails.

---

## T+migration: FieldCam DB flip

1. **Railway → FieldCam service → Variables:**
   - Change `DATABASE_URL` from FieldCam's Postgres → Prop Spot's
     Postgres. Use the reference variable syntax if available:
     `${{Postgres.DATABASE_URL}}` (referencing the Prop Spot project).
   - Verify `OS_URL` and `JWT_SECRET` are still set.

2. **Redeploy** FieldCam (Railway does this on env change).

3. **Smoke test the cutover:**
   - [ ] Open Prop Spot, sign in.
   - [ ] Click the FieldCam tile in the dashboard → land on FieldCam
         dashboard authenticated.
   - [ ] Property list shows the same count as the baseline.
   - [ ] Open a known property → photo grid renders historical photos.
   - [ ] Open `/camera.html` → take a new photo → it appears in both
         FieldCam's `/property.html` and Prop Spot's
         `/property.html?id=<same id>`.
   - [ ] Add a new property in FieldCam → it appears in Prop Spot's
         `/properties.html`.
   - [ ] Visit `https://fieldcam.railway.app/index.html` directly →
         auto-redirects to Prop Spot for sign-in.

4. **Maintenance banner off** (if used).

---

## T+24h: Watch

- Errors in FieldCam logs (Railway).
- Cloudinary upload failures.
- Any reports of users seeing the wrong photos against the wrong
  property — would indicate a bad FK remap in migration.

If anything looks off, **roll back** immediately by flipping
`DATABASE_URL` on the FieldCam service back to its original Postgres,
redeploy. Any photos uploaded during the cutover window need to be
re-migrated.

---

## T+7d: Cleanup

After a week of stable operation:

- [ ] Delete FieldCam's old Postgres service from Railway.
- [ ] Delete `propspot-os/routes/admin.js` (the
      `/api/admin/migrate-fieldcam` endpoint is now obsolete).
      Remove the mount in `server.js`. Commit + redeploy Prop Spot.
- [ ] Archive `FIELDCAM_DATABASE_URL` from Prop Spot's Railway env.

---

## Rollback decision tree

| Symptom | Action |
|---|---|
| 401 storm on FieldCam | Token issued before migration is fine — verify `JWT_SECRET` parity. If wrong, fix the secret. |
| FieldCam returns "Property not found" for known property | FK remap miss in migration. Roll back the env var, investigate. |
| Photos show on wrong property | Same as above — roll back. |
| Photo upload 500s | Cloudinary creds. Check FieldCam logs, fix the env var, redeploy without rollback. |
| Whole FieldCam service down | Railway issue, not migration. Check Railway status; restart the service. |
