-- ============================================================
--  Seed: built-in apps. Idempotent (ON CONFLICT DO NOTHING).
-- ============================================================

INSERT INTO apps (slug, name, description, icon, base_url, enabled)
VALUES
  ('fieldcam',    'FieldCam',     'Field photo management for renovation contractors',                                    '📸', 'https://fieldcam.propspot.io',    TRUE),
  ('holdings',    'Holdings Desk','Per-property obligations: utilities, insurance, taxes, mortgages, licenses, HOA',       '💼', 'https://holdings.propspot.io',    TRUE),
  ('maintenance', 'Maintenance',  'Work-order tracking for properties',                                                    '🛠️', 'https://maintenance.propspot.io', TRUE),
  ('underwriting','Underwriting', 'Offer underwriting and ARV modeling',                                                   '💰', NULL,                              TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Backfill base_url for any apps that already exist without one. Safe to run
-- repeatedly; only overwrites when the column is NULL or empty.
UPDATE apps SET base_url = 'https://fieldcam.propspot.io'    WHERE slug = 'fieldcam'    AND (base_url IS NULL OR base_url = '');
UPDATE apps SET base_url = 'https://holdings.propspot.io'    WHERE slug = 'holdings'    AND (base_url IS NULL OR base_url = '');
UPDATE apps SET base_url = 'https://maintenance.propspot.io' WHERE slug = 'maintenance' AND (base_url IS NULL OR base_url = '');
