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
  ('inbox',        'Inbox',         'Shared team email tagged to properties',             '📧', 'https://inbox.propspot.io', TRUE),
  ('inkd',         'Ink''d',        'E-signature for property documents — templates, signing, audit trail', '🖋️', '/inkd.html', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Underwriting is now a built-in OS page — always point to its internal path.
-- A leading slash signals "built-in" to apps.html (no token hand-off needed).
UPDATE apps SET base_url = '/underwriting.html' WHERE slug = 'underwriting';

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

-- ── Underwriting deals — Restoration Homes portfolio ─────────────────────
-- Seeded from original Excel underwriters. Only runs on a fresh database
-- (skipped if any uw_deals rows already exist). Idempotent.
DO $$
DECLARE d UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM uw_deals LIMIT 1) THEN RETURN; END IF;

  -- 1. 379 Curtis Dr, Sumter SC
  INSERT INTO uw_deals (address,city,state,zip,county,sqft,list_price)
  VALUES ('379 Curtis Dr','Sumter','SC','29153','Sumter',1071,117200)
  RETURNING id INTO d;
  INSERT INTO uw_snapshots (deal_id,kind,data_json) VALUES
    (d,'initial_pro_forma','{"purchasePrice":72000,"bridgeARV":145000,"dscrARV":160000,"renoBudget":31984,"rentOverride":1350,"annualPropertyTax":1500,"insuranceAnnual":950,"bridgeRate":0.1099,"bridgeOrigPct":0.015,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.068,"dscrMaxLTV":0.75,"dscrOriginationPct":0.015,"dscrUWFee":750,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb),
    (d,'actual_results',   '{"purchasePrice":72000,"bridgeARV":145000,"dscrARV":160000,"renoBudget":31984,"rentOverride":1350,"annualPropertyTax":1500,"insuranceAnnual":950,"bridgeRate":0.1099,"bridgeOrigPct":0.015,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.068,"dscrMaxLTV":0.75,"dscrOriginationPct":0.015,"dscrUWFee":750,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb);

  -- 2. 219 S Guignard Dr, Sumter SC
  INSERT INTO uw_deals (address,city,state,zip,county,sqft,list_price)
  VALUES ('219 S Guignard Dr','Sumter','SC','29150','Sumter',1168,125000)
  RETURNING id INTO d;
  INSERT INTO uw_snapshots (deal_id,kind,data_json) VALUES
    (d,'initial_pro_forma','{"purchasePrice":64000,"bridgeARV":170000,"dscrARV":168000,"renoBudget":69000,"rentOverride":1400,"annualPropertyTax":1440,"insuranceAnnual":943,"bridgeRate":0.1099,"bridgeOrigPct":0.01,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.067,"dscrMaxLTV":0.75,"dscrOriginationPct":0.01,"dscrUWFee":1500,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb),
    (d,'actual_results',   '{"purchasePrice":64000,"bridgeARV":170000,"dscrARV":168000,"renoBudget":69000,"rentOverride":1400,"annualPropertyTax":1440,"insuranceAnnual":943,"bridgeRate":0.1099,"bridgeOrigPct":0.01,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.067,"dscrMaxLTV":0.75,"dscrOriginationPct":0.01,"dscrUWFee":1500,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb);

  -- 3. 237 Woodlawn Ave, Sumter SC
  INSERT INTO uw_deals (address,city,state,zip,county,sqft)
  VALUES ('237 Woodlawn Ave','Sumter','SC','29150','Sumter',1110)
  RETURNING id INTO d;
  INSERT INTO uw_snapshots (deal_id,kind,data_json) VALUES
    (d,'initial_pro_forma','{"purchasePrice":32500,"bridgeARV":125000,"dscrARV":150000,"renoBudget":66091,"rentOverride":1200,"annualPropertyTax":1500,"insuranceAnnual":900,"bridgeRate":0.0999,"bridgeOrigPct":0.015,"bridgeOrigMin":2250,"bridgeUWFee":1500,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.035,"borrowMaxDSCR":true,"dscrRate":0.068,"dscrMaxLTV":0.75,"dscrOriginationPct":0.015,"dscrUWFee":750,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb),
    (d,'actual_results',   '{"purchasePrice":32500,"bridgeARV":125000,"dscrARV":150000,"renoBudget":66091,"rentOverride":1200,"annualPropertyTax":1500,"insuranceAnnual":900,"bridgeRate":0.0999,"bridgeOrigPct":0.015,"bridgeOrigMin":2250,"bridgeUWFee":1500,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.035,"borrowMaxDSCR":true,"dscrRate":0.068,"dscrMaxLTV":0.75,"dscrOriginationPct":0.015,"dscrUWFee":750,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb);

  -- 4. 631 1/2 Gibson Road, Lexington SC
  INSERT INTO uw_deals (address,city,state,zip,county,sqft)
  VALUES ('631 1/2 Gibson Road','Lexington','SC','29072','Lexington',1418)
  RETURNING id INTO d;
  INSERT INTO uw_snapshots (deal_id,kind,data_json) VALUES
    (d,'initial_pro_forma','{"purchasePrice":54000,"bridgeARV":150000,"dscrARV":150000,"renoBudget":50935,"rentOverride":1385,"annualPropertyTax":1292,"insuranceAnnual":945,"bridgeRate":0.1024,"bridgeOrigPct":0.01,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.035,"borrowMaxDSCR":true,"dscrRate":0.0675,"dscrMaxLTV":0.75,"dscrOriginationPct":0.01,"dscrUWFee":999,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb),
    (d,'actual_results',   '{"purchasePrice":54000,"bridgeARV":150000,"dscrARV":150000,"renoBudget":50935,"rentOverride":1385,"annualPropertyTax":1292,"insuranceAnnual":945,"bridgeRate":0.1024,"bridgeOrigPct":0.01,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.035,"borrowMaxDSCR":true,"dscrRate":0.0675,"dscrMaxLTV":0.75,"dscrOriginationPct":0.01,"dscrUWFee":999,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb);

  -- 5. 2516 Flamingo Dr, Columbia SC
  INSERT INTO uw_deals (address,city,state,zip,county,sqft)
  VALUES ('2516 Flamingo Dr','Columbia','SC','29209','Richland',1059)
  RETURNING id INTO d;
  INSERT INTO uw_snapshots (deal_id,kind,data_json) VALUES
    (d,'initial_pro_forma','{"purchasePrice":85000,"bridgeARV":169000,"dscrARV":169000,"renoBudget":40758,"rentOverride":1400,"annualPropertyTax":1956,"insuranceAnnual":900,"bridgeRate":0.1,"bridgeOrigPct":0.01,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.069,"dscrMaxLTV":0.8,"dscrOriginationPct":0.01,"dscrUWFee":999,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb),
    (d,'actual_results',   '{"purchasePrice":85000,"bridgeARV":169000,"dscrARV":169000,"renoBudget":40758,"rentOverride":1400,"annualPropertyTax":1956,"insuranceAnnual":900,"bridgeRate":0.1,"bridgeOrigPct":0.01,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.069,"dscrMaxLTV":0.8,"dscrOriginationPct":0.01,"dscrUWFee":999,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb);

  -- 6. 300 E Oneal St, Gaffney SC
  INSERT INTO uw_deals (address,city,state,zip,county,sqft,list_price)
  VALUES ('300 E Oneal St','Gaffney','SC','29340','Cherokee',1331,171000)
  RETURNING id INTO d;
  INSERT INTO uw_snapshots (deal_id,kind,data_json) VALUES
    (d,'initial_pro_forma','{"purchasePrice":100000,"bridgeARV":215000,"dscrARV":215000,"renoBudget":28889,"rentOverride":1300,"annualPropertyTax":2100,"insuranceAnnual":1355,"bridgeRate":0.1024,"bridgeOrigPct":0.015,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.0725,"dscrMaxLTV":0.75,"dscrOriginationPct":0.015,"dscrUWFee":999,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb),
    (d,'actual_results',   '{"purchasePrice":100000,"bridgeARV":215000,"dscrARV":215000,"renoBudget":28889,"rentOverride":1300,"annualPropertyTax":2100,"insuranceAnnual":1355,"bridgeRate":0.1024,"bridgeOrigPct":0.015,"bridgeOrigMin":2250,"bridgeUWFee":999,"bridgeClosingCosts":2300,"bridgePreClosingExpenses":800,"vacancyRate":0.05,"includeAppreciation":true,"appreciationRate":0.03,"borrowMaxDSCR":true,"dscrRate":0.0725,"dscrMaxLTV":0.75,"dscrOriginationPct":0.015,"dscrUWFee":999,"dscrClosingCosts":2200,"useDwellaPM":true}'::jsonb);

END $$;

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
