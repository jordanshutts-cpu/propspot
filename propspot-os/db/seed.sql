-- ============================================================
--  Seed: built-in apps. Idempotent (ON CONFLICT DO NOTHING).
-- ============================================================

INSERT INTO apps (slug, name, description, icon, base_url, enabled)
VALUES
  ('fieldcam',     'FieldCam',      'Field photo management for renovation contractors', '📸', NULL, TRUE),
  ('underwriting', 'Underwriting',  'Offer underwriting and ARV modeling',                '💰', NULL, TRUE),
  ('maintenance',  'Maintenance',   'Work-order tracking for properties',                 '🛠️',  'https://maintenance.propspot.io', TRUE),
  ('holdings',     'Holdings Desk', 'Per-property obligations: utilities, insurance, taxes, mortgages, licenses, HOA', '💼', 'https://holdings.propspot.io', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Auto-grant owners full access to every enabled app. Mirrors the grant
-- block in routes/auth.js POST /signup, but runs on every boot so that
-- apps registered AFTER an owner signed up are still granted to them.
-- Idempotent — ON CONFLICT DO NOTHING leaves existing grants untouched.
INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
SELECT u.id, a.id, 'owner', '{"all": true}'::jsonb, u.id
  FROM users u, apps a
 WHERE u.is_owner = TRUE
   AND a.enabled  = TRUE
ON CONFLICT (user_id, app_id) DO NOTHING;
