-- ──────────────────────────────────────────────────────────────────
-- Add 'database' and 'activity' as managed apps
-- ──────────────────────────────────────────────────────────────────
-- Adds two new rows to the `apps` table so the Members page auto-
-- renders columns for them, then back-fills app_grants for every
-- currently non-external user (active + invited) so nobody loses
-- access at deploy time. Sidebar.js separately checks user.grants
-- to hide the Database / Activity rows for users without the grant.
-- ──────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO apps (slug, name, description, icon, base_url, enabled) VALUES
  ('database', 'Database', 'Searchable property database',     '🗃️', '/database.html', TRUE),
  ('activity', 'Activity', 'Workspace-wide activity feed',     '⚡', '/activity.html', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Auto-grant the two new apps to every non-external user so the
-- deploy doesn't yank access from anyone. Owners are unaffected
-- (they bypass grant checks at the middleware layer anyway).
INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
SELECT u.id, a.id, 'member', '{"all": true}'::jsonb, NULL
  FROM users u
  CROSS JOIN apps a
 WHERE a.slug IN ('database', 'activity')
   AND COALESCE(u.user_type, 'team') <> 'external_worker'
ON CONFLICT (user_id, app_id) DO NOTHING;

COMMIT;
