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
