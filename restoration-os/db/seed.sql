-- ============================================================
--  Seed: built-in apps. Idempotent (ON CONFLICT DO NOTHING).
-- ============================================================

INSERT INTO apps (slug, name, description, icon, base_url, enabled)
VALUES
  ('fieldcam',    'FieldCam',    'Field photo management for renovation contractors', '📸', NULL, TRUE),
  ('underwriting','Underwriting','Offer underwriting and ARV modeling',                '💰', NULL, TRUE)
ON CONFLICT (slug) DO NOTHING;
