-- ============================================================
--  Seed: built-in apps. Idempotent (ON CONFLICT DO NOTHING).
-- ============================================================

INSERT INTO apps (slug, name, description, icon, base_url, enabled)
VALUES
  ('fieldcam',     'FieldCam',      'Field photo management for renovation contractors', '📸', NULL, TRUE),
  ('underwriting', 'Underwriting',  'Offer underwriting and ARV modeling',                '💰', 'https://underwriter-production.up.railway.app', TRUE),
  ('maintenance',  'Maintenance',   'Work-order tracking for properties',                 '🛠️',  'https://maintenance.propspot.io', TRUE),
  ('holdings',     'Holdings Desk', 'Per-property obligations: utilities, insurance, taxes, mortgages, licenses, HOA', '💼', 'https://holdings.propspot.io', TRUE),
  ('pulse',        'Pulse',         'Team messaging — channels, DMs, mentions',           '💬', 'https://pulse.propspot.io', TRUE),
  ('inbox',        'Inbox',         'Shared team email tagged to properties',             '📧', 'https://inbox.propspot.io', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Patch base_url for underwriting in case the row already existed with NULL
UPDATE apps SET base_url = 'https://underwriter-production.up.railway.app'
 WHERE slug = 'underwriting' AND (base_url IS NULL OR base_url = '');

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

-- Pulse: seed the default #general channel and add every owner as a member.
INSERT INTO chat_channels (slug, name, description, is_private)
VALUES ('general', 'general', 'Everyone — start here.', FALSE)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO chat_channel_members (channel_id, user_id, role)
SELECT c.id, u.id, 'admin'
  FROM chat_channels c, users u
 WHERE c.slug = 'general'
   AND u.is_owner = TRUE
ON CONFLICT (channel_id, user_id) DO NOTHING;

-- Backfill owner_contact_id from the legacy free-text properties.owner.
-- Step 1: ensure a contact (type='owner') exists for every distinct
-- non-empty owner string. Step 2: link properties whose owner_contact_id
-- is still null to the matching contact. Both steps are idempotent and
-- safe to re-run.
DO $$ BEGIN
  -- Create contacts for any owner-name not already represented.
  INSERT INTO contacts (type, full_name)
  SELECT 'owner', TRIM(p.owner)
    FROM (SELECT DISTINCT owner FROM properties WHERE owner IS NOT NULL AND TRIM(owner) <> '') p
   WHERE NOT EXISTS (
     SELECT 1 FROM contacts c
      WHERE c.type = 'owner' AND LOWER(c.full_name) = LOWER(TRIM(p.owner))
   );

  -- Link unlinked properties to the matching owner contact.
  UPDATE properties pr
     SET owner_contact_id = c.id
    FROM contacts c
   WHERE pr.owner_contact_id IS NULL
     AND pr.owner IS NOT NULL
     AND TRIM(pr.owner) <> ''
     AND c.type = 'owner'
     AND LOWER(c.full_name) = LOWER(TRIM(pr.owner));
END $$;
